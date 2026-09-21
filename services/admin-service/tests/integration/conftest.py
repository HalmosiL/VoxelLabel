"""Integration-test harness: the real admin-service app, a real Postgres
(schema created from the ORM models -- the migrations' source of truth),
and only the two things that can't be real in a test: Keycloak (an
in-memory user directory) and SMTP (a recorder).

Per test: tables are truncated afterwards, so tests never see each
other's rows. Auth is a dependency override -- `as_user(...)` decides
who the request is; there are no tokens anywhere.

Safety: refuses to run unless the database name ends in `_test`.
"""
import os
import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from shared_auth import CurrentUser, get_current_user
from shared_models import database
from shared_models.models import Base
from sqlalchemy import text

if not database.DATABASE_URL.rstrip("/").split("/")[-1].endswith("_test"):
    # A plain `assert` here would abort the whole pytest session with a
    # collection error -- pytest always imports every conftest.py under
    # rootdir up front (for fixture/plugin discovery), regardless of
    # tests/conftest.py's collect_ignore_glob, which only filters test
    # *items*, not this eager conftest walk. `pytest.skip(...,
    # allow_module_level=True)` is the documented way to bail out of a
    # module at import time -- it cleanly excludes this directory
    # instead of failing the plain unit-test run.
    pytest.skip(
        "integration tests need DATABASE_URL pointing at a *_test database -- refusing to truncate anything else",
        allow_module_level=True,
    )
os.environ.setdefault("NOTIFICATIONS_POLLER_ENABLED", "0")

from app.main import app  # noqa: E402 -- after the env guard on purpose

ADMIN_SUBJECT = "00000000-0000-4000-8000-000000000001"
DM_SUBJECT = "00000000-0000-4000-8000-000000000002"
ANNOTATOR_SUBJECT = "00000000-0000-4000-8000-000000000003"
REVIEWER_SUBJECT = "00000000-0000-4000-8000-000000000004"


class FakeKeycloak:
    """Stands in for app.keycloak_admin: a dict of users, the same
    serialized shape list_realm_users() returns, plus a call log."""

    def __init__(self):
        self.users = {}
        self.calls = []
        for subject, username, admin in (
            (ADMIN_SUBJECT, "platform-admin", True),
            (DM_SUBJECT, "dm", False),
            (ANNOTATOR_SUBJECT, "dr-test", False),
            (REVIEWER_SUBJECT, "dr-review", False),
        ):
            self.users[subject] = {
                "id": subject, "username": username, "email": f"{username}@example.test",
                "first_name": username.title(), "last_name": "User", "enabled": True,
                "email_verified": True, "required_actions": [], "created_at": None, "is_admin": admin,
            }

    def list_realm_users(self):
        return list(self.users.values())

    def get_user(self, user_id):
        import httpx
        if user_id not in self.users:
            raise httpx.HTTPStatusError("404", request=httpx.Request("GET", "http://kc"), response=httpx.Response(404))
        return dict(self.users[user_id])

    def create_user(self, username, email, first_name, last_name, password, is_admin):
        self.calls.append(("create_user", username, is_admin))
        uid = str(uuid.uuid4())
        self.users[uid] = {
            "id": uid, "username": username, "email": email, "first_name": first_name, "last_name": last_name,
            "enabled": True, "email_verified": True, "required_actions": ["UPDATE_PASSWORD"], "created_at": None, "is_admin": is_admin,
        }
        return {"id": uid, "username": username, "email": email, "is_admin": is_admin}

    def update_user(self, user_id, **fields):
        self.calls.append(("update_user", user_id, fields))
        for k, v in fields.items():
            if v is not None:
                self.users[user_id][k] = v
        return dict(self.users[user_id])

    def set_admin_role(self, user_id, is_admin):
        self.calls.append(("set_admin_role", user_id, is_admin))
        self.users[user_id]["is_admin"] = is_admin

    def reset_password(self, user_id, password, temporary=True):
        self.calls.append(("reset_password", user_id, temporary))

    def delete_user(self, user_id):
        self.calls.append(("delete_user", user_id))
        self.users.pop(user_id, None)


@pytest.fixture(scope="session", autouse=True)
def _schema():
    # Rebuild from scratch every session: create_all() never alters an
    # existing table, so a column added to the models since the last run
    # would otherwise be missing from the (throwaway) test database.
    Base.metadata.drop_all(database.engine)
    Base.metadata.create_all(database.engine)
    yield


@pytest.fixture
def db():
    session = database.SessionLocal()
    try:
        yield session
    finally:
        session.close()
        # Wipe everything the test touched, in one statement, FK-safe.
        tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
        with database.engine.begin() as conn:
            conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))


@pytest.fixture
def keycloak(monkeypatch):
    fake = FakeKeycloak()
    import app.api.audit  # noqa: E401
    import app.api.registration
    import app.api.studies
    import app.api.users
    import app.notifications.api
    import app.notifications.events
    import app.usage.api
    for mod in (app.api.audit, app.api.registration, app.api.studies, app.api.users, app.notifications.api, app.notifications.events, app.usage.api):
        for name in ("list_realm_users", "get_user", "create_user", "update_user", "set_admin_role", "reset_password", "delete_user"):
            if hasattr(mod, name):
                monkeypatch.setattr(mod, name, getattr(fake, name))
    return fake


@pytest.fixture
def outbox(monkeypatch):
    """Every email the app tried to send, as (to, subject, text, html)."""
    sent = []

    def fake_send(settings, to_email, subject, body, html=None):
        sent.append({"to": to_email, "subject": subject, "text": body, "html": html})

    import app.api.registration  # noqa: E401
    import app.notifications.api
    import app.notifications.events
    for mod in (app.api.registration, app.notifications.api, app.notifications.events):
        if hasattr(mod, "send_email"):
            monkeypatch.setattr(mod, "send_email", fake_send)
    return sent


@pytest.fixture
def client(db, keycloak, outbox):
    """A TestClient whose caller is whoever `as_user` last set (default:
    the platform admin). Not a context manager on purpose: no lifespan,
    so the notification poller never starts."""
    holder = {"user": CurrentUser(subject=ADMIN_SUBJECT, email="platform-admin@example.test", realm_roles=["admin"])}
    app.dependency_overrides[get_current_user] = lambda: holder["user"]
    c = TestClient(app)
    c.as_user = lambda subject, roles=(): holder.__setitem__("user", CurrentUser(subject=subject, email=keycloak.users.get(subject, {}).get("email"), realm_roles=list(roles)))  # type: ignore[attr-defined]
    c.as_admin = lambda: c.as_user(ADMIN_SUBJECT, ["admin"])  # type: ignore[attr-defined]
    try:
        yield c
    finally:
        app.dependency_overrides.pop(get_current_user, None)


# ---- small builders shared by the test modules -------------------------------

def make_study(client, name="Study A"):
    r = client.post("/admin/studies", params={"name": name})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def add_member(client, study_id, subject, role):
    r = client.post(f"/admin/studies/{study_id}/members", params={"user_id": subject, "role": role})
    assert r.status_code == 200, r.text
    return r.json()


def make_case(client, study_id, external="MRN-1", **fields):
    r = client.post(f"/admin/studies/{study_id}/cases", params={"external_patient_id": external, **fields})
    assert r.status_code == 200, r.text
    return r.json()


def make_series(db, case_id):
    """A case with real imaging rows (no pixel data), so annotation
    status can hang off a series like it does for real cases."""
    from shared_models.models import ImagingStudy, Series
    imaging = ImagingStudy(case_id=uuid.UUID(case_id), study_instance_uid=f"1.2.{uuid.uuid4().int % 10**12}")
    db.add(imaging)
    db.flush()
    series = Series(imaging_study_id=imaging.id, series_instance_uid=f"1.3.{uuid.uuid4().int % 10**12}")
    db.add(series)
    db.flush()
    series_id = series.id  # read before commit -- see make_annotation for why
    db.commit()
    return series_id


def make_annotation(db, study_id, series_id, subject, status):
    """One annotation version on a series, as ct-annotator's save would
    write it (target_type 'series')."""
    from shared_models.models import Annotation, AnnotationStatus, AnnotationType
    # Postgres's now() is the *transaction start* time. Touching an
    # expired attribute after a commit (e.g. `series.id`) silently opens
    # a new read transaction on this session that then stays open; an
    # INSERT made later inside it gets a created_at from before any
    # request the test made in between -- and the job-status code's
    # "nothing older than the card counts" cutoff would then hide the
    # annotation. Start fresh so created_at is really "now".
    db.rollback()
    atype = db.query(AnnotationType).filter_by(name="segmentation_volume").first()
    if atype is None:
        atype = AnnotationType(name="segmentation_volume", json_schema={"type": "object"})
        db.add(atype)
        db.flush()
    row = Annotation(
        target_type="series", target_id=series_id, study_id=uuid.UUID(study_id), annotator_id=subject,
        type_id=atype.id, payload={"mask_volume_key": "k", "labels": [], "objects": []}, status=AnnotationStatus(status),
    )
    db.add(row)
    db.commit()
    return row.id


def now():
    return datetime.now(timezone.utc)
