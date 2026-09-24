"""Integration harness for annotation-service: the real app on a real,
throwaway Postgres (schema from the ORM models), auth as a dependency
override. Refuses to run unless the database name ends in `_test`."""
import uuid

import pytest
from fastapi.testclient import TestClient
from shared_auth import CurrentUser, get_current_user
from shared_models import database
from shared_models.models import AnnotationType, Base, Case, ImagingStudy, Instance, Patient, Series, Study, StudyMembership
from sqlalchemy import text

if not database.DATABASE_URL.rstrip("/").split("/")[-1].endswith("_test"):
    pytest.skip("integration tests need DATABASE_URL pointing at a *_test database", allow_module_level=True)

from app.main import app  # noqa: E402

ADMIN = "00000000-0000-4000-8000-0000000000a1"
ALICE = "00000000-0000-4000-8000-0000000000a2"  # annotator in study A only
BOB = "00000000-0000-4000-8000-0000000000b2"  # annotator in study B only


@pytest.fixture(scope="session", autouse=True)
def _schema():
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
        tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
        with database.engine.begin() as conn:
            conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))


@pytest.fixture
def client(db):
    holder = {"user": CurrentUser(subject=ADMIN, email=None, realm_roles=["admin"])}
    app.dependency_overrides[get_current_user] = lambda: holder["user"]
    c = TestClient(app)
    c.as_user = lambda subject, roles=(): holder.__setitem__("user", CurrentUser(subject=subject, email=None, realm_roles=list(roles)))  # type: ignore[attr-defined]
    try:
        yield c
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def make_study_with_series(db, name, member, role="annotator"):
    """A study with one case, one imaging study, one series and one
    instance; `member` holds `role` in it. Returns (study_id, series_id, instance_id)."""
    study = Study(name=name)
    patient = Patient(pseudonym_id=f"P-{uuid.uuid4().hex[:10]}")
    db.add_all([study, patient])
    db.flush()
    case = Case(study_id=study.id, patient_id=patient.id)
    db.add(case)
    db.flush()
    imaging = ImagingStudy(case_id=case.id, study_instance_uid=f"1.2.{uuid.uuid4().int % 10**12}")
    db.add(imaging)
    db.flush()
    series = Series(imaging_study_id=imaging.id, series_instance_uid=f"1.3.{uuid.uuid4().int % 10**12}")
    db.add(series)
    db.flush()
    instance = Instance(series_id=series.id, sop_instance_uid=f"1.4.{uuid.uuid4().int % 10**12}", object_storage_key="dicom/x.dcm")
    db.add(instance)
    db.flush()
    db.add(StudyMembership(study_id=study.id, user_id=member, role=role))
    if db.query(AnnotationType).filter_by(name="segmentation_volume").first() is None:
        db.add(AnnotationType(name="segmentation_volume", json_schema={"type": "object"}))
    ids = (str(study.id), str(series.id), str(instance.id))
    db.commit()
    return ids
