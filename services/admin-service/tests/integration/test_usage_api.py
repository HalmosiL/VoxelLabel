"""Usage tracking through the real API: events land under the caller's
own subject and only for switched-on categories, the switches (global,
per category, per user) are admin-only and take effect on ingestion,
every read is admin-only, and old rows get purged."""
from datetime import datetime, timedelta, timezone

from app.usage.settings import get_settings, purge_expired
from shared_models.models import UsageEvent

from .conftest import ADMIN_SUBJECT, ANNOTATOR_SUBJECT, REVIEWER_SUBJECT

NOW = datetime(2026, 9, 20, 9, 0, tzinfo=timezone.utc)


def ev(kind, route, *, session="s1", app="admin-ui", at_s=0, name=None, detail=None, duration_ms=None):
    return {
        "session_id": session,
        "app": app,
        "event_type": kind,
        "route": route,
        "name": name,
        "detail": detail,
        "duration_ms": duration_ms,
        "occurred_at": (datetime.now(timezone.utc) - timedelta(minutes=5) + timedelta(seconds=at_s)).isoformat(),
    }


def post(client, events):
    r = client.post("/admin/usage/events", json={"events": events})
    assert r.status_code == 200, r.text
    return r.json()["accepted"]


def test_events_are_stored_under_the_callers_subject_not_the_bodys(client, db):
    client.as_user(ANNOTATOR_SUBJECT, ["annotator"])
    forged = {**ev("page_view", "/my-jobs"), "user_id": ADMIN_SUBJECT}
    assert post(client, [forged]) == 1
    rows = db.query(UsageEvent).all()
    assert len(rows) == 1 and rows[0].user_id == ANNOTATOR_SUBJECT and rows[0].route == "/my-jobs"


def test_detail_is_whitelisted_and_traces_capped(client, db):
    client.as_user(ANNOTATOR_SUBJECT)
    detail = {
        "case_id": "c1",
        "patient_name": "must not be stored",
        "target": "x" * 500,
        "viewport": [1600, 900],
        "points": [[i, i, i] for i in range(700)] + ["junk"],
    }
    post(client, [ev("mouse_trace", "/viewer/:id", app="viewer", detail=detail)])
    stored = db.query(UsageEvent).one().detail
    assert set(stored) == {"case_id", "target", "viewport", "points"}
    assert len(stored["target"]) == 200 and len(stored["points"]) == 600 and stored["points"][0] == [0, 0, 0]


def test_oversize_batch_and_bad_types_are_422(client):
    client.as_user(ANNOTATOR_SUBJECT)
    assert client.post("/admin/usage/events", json={"events": [ev("page_view", "/x")] * 501}).status_code == 422
    assert client.post("/admin/usage/events", json={"events": [{**ev("page_view", "/x"), "event_type": "keylog"}]}).status_code == 422
    assert client.post("/admin/usage/events", json={"events": [{**ev("page_view", "/x"), "app": "evil"}]}).status_code == 422


def test_switches_are_admin_only_and_filter_ingestion_server_side(client, db):
    client.as_user(ANNOTATOR_SUBJECT)
    assert client.get("/admin/usage/settings").status_code == 403
    assert client.put("/admin/usage/settings", json={"track_mouse": False}).status_code == 403
    config = client.get("/admin/usage/config").json()
    assert config["enabled"] is True and config["track_mouse"] is True and config["mouse_sample_ms"] == 100

    client.as_admin()
    saved = client.put("/admin/usage/settings", json={"track_mouse": False, "mouse_sample_ms": 250}).json()
    assert saved["track_mouse"] is False and saved["track_clicks"] is True and saved["mouse_sample_ms"] == 250
    assert client.put("/admin/usage/settings", json={"mouse_sample_ms": 5}).status_code == 422

    client.as_user(ANNOTATOR_SUBJECT)
    config = client.get("/admin/usage/config").json()
    assert config["track_mouse"] is False and config["mouse_sample_ms"] == 250
    # A stale tab still shipping traces: the click lands, the trace does not.
    accepted = post(client, [ev("mouse_trace", "/x", detail={"points": [[0, 1, 1]]}), ev("click", "/x", at_s=1, detail={"x": 1, "y": 1})])
    assert accepted == 1
    assert [e.event_type for e in db.query(UsageEvent).all()] == ["click"]


def test_master_switch_and_per_user_switch(client, db):
    client.as_admin()
    assert client.put(f"/admin/usage/settings/users/{ANNOTATOR_SUBJECT}", json={"enabled": False}).json()["disabled_user_ids"] == [ANNOTATOR_SUBJECT]

    client.as_user(ANNOTATOR_SUBJECT)
    assert client.get("/admin/usage/config").json()["enabled"] is False
    assert post(client, [ev("page_view", "/my-jobs")]) == 0
    client.as_user(REVIEWER_SUBJECT)
    assert client.get("/admin/usage/config").json()["enabled"] is True
    assert post(client, [ev("page_view", "/my-jobs", session="s2")]) == 1

    client.as_admin()
    assert client.put(f"/admin/usage/settings/users/{ANNOTATOR_SUBJECT}", json={"enabled": True}).json()["disabled_user_ids"] == []
    client.put("/admin/usage/settings", json={"enabled": False})
    client.as_user(REVIEWER_SUBJECT)
    assert client.get("/admin/usage/config").json()["enabled"] is False
    assert post(client, [ev("page_view", "/my-jobs", session="s2", at_s=1)]) == 0
    assert db.query(UsageEvent).count() == 1


def _seed_session(client):
    client.as_user(ANNOTATOR_SUBJECT, ["annotator"])
    post(
        client,
        [
            ev("page_view", "/my-jobs", at_s=0, detail={"viewport": [1600, 900]}),
            ev("click", "/my-jobs", at_s=1, detail={"x": 800, "y": 450, "viewport": [1600, 900], "target": "job-row"}),
            ev("page_leave", "/my-jobs", at_s=10, duration_ms=10000),
            ev("page_view", "/viewer/:id", at_s=10, app="viewer"),
            ev("action", "/viewer/:id", at_s=15, app="viewer", name="tool.paint"),
            ev("action", "/viewer/:id", at_s=40, app="viewer", name="mark_annotated"),
            ev("page_leave", "/viewer/:id", at_s=50, app="viewer", duration_ms=40000),
        ],
    )


def test_reads_are_admin_only(client):
    _seed_session(client)
    for path in ("/admin/usage/summary", "/admin/usage/sessions", "/admin/usage/sessions/s1", "/admin/usage/heatmap?route=/my-jobs"):
        assert client.get(path).status_code == 403, path


def test_summary_sessions_and_heatmap(client):
    _seed_session(client)
    client.as_admin()

    summary = client.get("/admin/usage/summary", params={"days": 7}).json()
    assert summary["totals"] == {"events": 7, "active_users": 1, "sessions": 1, "avg_session_ms": 50000, "errors": 0}
    assert summary["tasks"]["annotate"] == {"count": 1, "median_ms": 30000, "mean_ms": 30000}
    assert summary["routes"][0]["route"] == "/viewer/:id" and summary["routes"][0]["total_ms"] == 40000
    assert summary["transitions"] == [{"from": "/my-jobs", "to": "/viewer/:id", "count": 1, "sessions": 1}]
    assert [a["name"] for a in summary["actions"]] == ["mark_annotated", "tool.paint"]
    user = summary["users"][0]
    assert user["user_id"] == ANNOTATOR_SUBJECT and user["username"] == "dr-test" and user["annotated"] == 1
    assert summary["recording"] == {"enabled": True, "disabled_user_ids": []}
    # the user filter narrows to nothing for someone with no events
    assert client.get("/admin/usage/summary", params={"user_id": REVIEWER_SUBJECT}).json()["totals"]["sessions"] == 0

    sessions = client.get("/admin/usage/sessions").json()
    assert len(sessions) == 1 and sessions[0]["session_id"] == "s1" and sessions[0]["username"] == "dr-test"
    assert sessions[0]["page_views"] == 2 and sessions[0]["routes"] == ["/my-jobs", "/viewer/:id"]

    detail = client.get("/admin/usage/sessions/s1").json()
    assert detail["username"] == "dr-test" and [e["event_type"] for e in detail["events"]][:2] == ["page_view", "click"]
    assert client.get("/admin/usage/sessions/nope").status_code == 404

    heat = client.get("/admin/usage/heatmap", params={"route": "/my-jobs"}).json()
    assert heat["points"] == [{"x": 0.5, "y": 0.5, "target": "job-row"}]
    assert client.get("/admin/usage/heatmap", params={"route": "/nothing"}).json()["points"] == []


def test_from_to_window_overrides_days_and_accepts_naive_datetimes(client):
    """The calendar picker on the Usage page sends `from`/`to` -- plain
    datetime-local values, with no timezone offset. They must still
    correctly include/exclude the seeded session (occurred ~5 min ago)."""
    _seed_session(client)
    client.as_admin()
    now = datetime.now(timezone.utc)

    outside = client.get("/admin/usage/summary", params={"from": (now - timedelta(hours=2)).isoformat(), "to": (now - timedelta(hours=1)).isoformat()}).json()
    assert outside["totals"]["sessions"] == 0

    naive_from = (now - timedelta(minutes=30)).replace(tzinfo=None).isoformat()
    inside = client.get("/admin/usage/summary", params={"from": naive_from}).json()
    assert inside["totals"]["sessions"] == 1
    assert inside["since"].startswith(naive_from[:16])

    sessions = client.get("/admin/usage/sessions", params={"from": naive_from}).json()
    assert len(sessions) == 1

    heat = client.get("/admin/usage/heatmap", params={"route": "/my-jobs", "from": naive_from}).json()
    assert heat["points"] == [{"x": 0.5, "y": 0.5, "target": "job-row"}]
    heat_outside = client.get("/admin/usage/heatmap", params={"route": "/my-jobs", "from": (now - timedelta(hours=2)).isoformat(), "to": (now - timedelta(hours=1)).isoformat()}).json()
    assert heat_outside["points"] == []


def test_retention_purge_removes_old_rows_only(client, db):
    _seed_session(client)
    db.add(
        UsageEvent(
            user_id=ANNOTATOR_SUBJECT, session_id="old", app="admin-ui", event_type="page_view", route="/studies",
            occurred_at=datetime.now(timezone.utc) - timedelta(days=100),
        )
    )
    db.commit()
    assert db.query(UsageEvent).count() == 8
    assert purge_expired(db, get_settings(db), force=True) == 1
    assert db.query(UsageEvent).filter(UsageEvent.session_id == "old").count() == 0
    assert db.query(UsageEvent).count() == 7
