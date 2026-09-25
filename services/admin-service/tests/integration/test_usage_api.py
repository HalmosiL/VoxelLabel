"""Usage tracking through the real API: events land under the caller's
own subject and only for switched-on categories, the switches (global,
per category, per user) are admin-only and take effect on ingestion,
every read is admin-only, and old rows get purged."""
from datetime import datetime, timedelta, timezone

from app.usage.settings import get_settings, purge_expired
from shared_models.models import UsageEvent

from .conftest import ADMIN_SUBJECT, ANNOTATOR_SUBJECT, REVIEWER_SUBJECT, make_annotation, make_case, make_series, make_study

NOW = datetime(2026, 9, 20, 9, 0, tzinfo=timezone.utc)
# One base for every event of a run: taking "now" per event let a few
# milliseconds slip in between them and made exact durations flaky.
BASE = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=5)


def ev(kind, route, *, session="s1", app="admin-ui", at_s=0, name=None, detail=None, duration_ms=None):
    return {
        "session_id": session,
        "app": app,
        "event_type": kind,
        "route": route,
        "name": name,
        "detail": detail,
        "duration_ms": duration_ms,
        "occurred_at": (BASE + timedelta(seconds=at_s)).isoformat(),
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
    assert heat["points"] == [{"x": 0.5, "y": 0.5, "target": "job-row", "user_id": ANNOTATOR_SUBJECT, "dead": False, "mode": "other", "placed": "screen"}]
    assert heat["users"] == [{"user_id": ANNOTATOR_SUBJECT, "username": "dr-test", "clicks": 1}]
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
    assert heat["points"][0]["target"] == "job-row"
    heat_outside = client.get("/admin/usage/heatmap", params={"route": "/my-jobs", "from": (now - timedelta(hours=2)).isoformat(), "to": (now - timedelta(hours=1)).isoformat()}).json()
    assert heat_outside["points"] == []


def test_findings_and_report_are_admin_only_and_derive_from_the_same_data(client):
    _seed_session(client)
    assert client.get("/admin/usage/findings").status_code == 403
    assert client.get("/admin/usage/report.md").status_code == 403
    assert client.get("/admin/usage/export/events.csv").status_code == 403

    client.as_admin()
    found = client.get("/admin/usage/findings", params={"days": 7}).json()
    assert {"since", "until", "findings", "friction_score"} <= set(found)
    ids = [f["id"] for f in found["findings"]]
    # the seeded viewer tool use (only tool.paint) makes the unused-tools rule fire
    assert "tools.unused" in ids
    tools = next(f for f in found["findings"] if f["id"] == "tools.unused")
    assert tools["severity"] == "info" and tools["tab"] == "behaviour" and "cursor" in tools["evidence"]["unused"]

    report = client.get("/admin/usage/report.md", params={"days": 7})
    assert report.status_code == 200 and report.headers["content-type"].startswith("text/markdown")
    md = report.text
    assert md.startswith("# Usage report") and "## Findings" in md and tools["title"] in md
    assert "| Active people | 1 |" in md and "| dr-test | 1 |" in md


def test_raw_event_export_streams_csv_without_mouse_by_default(client):
    _seed_session(client)
    post(client, [ev("mouse_trace", "/viewer/:id", app="viewer", at_s=20, detail={"points": [[0, 1, 1], [100, 2, 2]], "viewport": [1600, 900]})])
    client.as_admin()

    r = client.get("/admin/usage/export/events.csv", params={"days": 7})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert r.headers["content-disposition"].startswith('attachment; filename="usage-events-')
    body = r.text
    assert body.startswith("﻿occurred_at,user_id,username,session_id,app,event_type,route,name,duration_ms,detail")
    lines = [line for line in body.splitlines() if line.strip()]
    assert len(lines) == 1 + 7  # header + the seeded events, mouse trace excluded
    assert "mouse_trace" not in body and "dr-test" in body and "mark_annotated" in body
    # detail is JSON text, quoted for CSV
    assert '"{""x"":800,""y"":450' in body

    with_mouse = client.get("/admin/usage/export/events.csv", params={"days": 7, "include_mouse": "true"}).text
    assert with_mouse.count("mouse_trace") == 1

    only_reviewer = client.get("/admin/usage/export/events.csv", params={"days": 7, "user_id": REVIEWER_SUBJECT}).text
    assert len([line for line in only_reviewer.splitlines() if line.strip()]) == 1  # header only


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


def test_admins_and_excluded_accounts_are_recorded_but_not_counted(client, db):
    _seed_session(client)  # dr-test
    client.as_admin()
    post(client, [ev("page_view", "/studies", session="admin-s"), ev("page_leave", "/studies", session="admin-s", at_s=20, duration_ms=20000)])
    assert db.query(UsageEvent).filter_by(user_id=ADMIN_SUBJECT).count() == 2  # recorded...
    summary = client.get("/admin/usage/summary").json()
    assert [u["username"] for u in summary["users"]] == ["dr-test"]  # ...but admins are left out by default
    assert summary["basis"]["admins_left_out"] is True and summary["basis"]["not_counted"] >= 1

    assert client.put("/admin/usage/settings", json={"exclude_admins": False}).json()["exclude_admins"] is False
    assert {u["username"] for u in client.get("/admin/usage/summary").json()["users"]} == {"dr-test", "platform-admin"}

    # a test account: still recorded, left out of every figure and export
    settings = client.put(f"/admin/usage/settings/users/{ANNOTATOR_SUBJECT}", json={"counted": False}).json()
    assert settings["excluded_user_ids"] == [ANNOTATOR_SUBJECT] and settings["disabled_user_ids"] == []
    assert [u["username"] for u in client.get("/admin/usage/summary").json()["users"]] == ["platform-admin"]
    assert "dr-test" not in client.get("/admin/usage/export/events.csv").text
    assert client.get("/admin/usage/heatmap", params={"route": "/my-jobs"}).json()["points"] == []
    people = {p["username"]: p for p in client.get("/admin/usage/people").json()}
    assert people["dr-test"]["recorded"] is True and people["dr-test"]["counted"] is False
    assert people["platform-admin"]["is_admin"] is True and people["platform-admin"]["counted"] is True
    client.as_user(ANNOTATOR_SUBJECT)
    assert client.get("/admin/usage/people").status_code == 403


def test_overview_returns_every_dataset_in_one_call(client):
    _seed_session(client)
    client.as_admin()
    overview = client.get("/admin/usage/overview", params={"days": 7}).json()
    assert set(overview) == {"since", "until", "summary", "previous", "pipeline", "pipeline_previous", "learning_curve", "findings"}
    assert overview["summary"]["totals"] == client.get("/admin/usage/summary", params={"days": 7}).json()["totals"]
    assert set(overview["summary"]["effort"]) == {"annotation", "review", "all"}
    assert "quality" in overview["pipeline"]


def test_a_backwards_window_is_422_and_a_future_clock_is_clamped(client, db):
    client.as_admin()
    for path in ("/admin/usage/summary", "/admin/usage/overview", "/admin/pipeline-health/summary"):
        assert client.get(path, params={"from": "2026-09-20T00:00:00Z", "to": "2026-09-01T00:00:00Z"}).status_code == 422, path
    assert client.get("/admin/pipeline-health/summary", params={"card_id": "junk"}).status_code == 422
    client.as_user(ANNOTATOR_SUBJECT)
    post(client, [{**ev("page_view", "/x"), "occurred_at": "2030-01-01T00:00:00Z"}])
    stored = db.query(UsageEvent).one().occurred_at
    assert stored <= datetime.now(timezone.utc) + timedelta(minutes=1)


def test_id_like_runs_in_click_targets_are_normalised(client, db):
    client.as_user(ANNOTATOR_SUBJECT)
    post(client, [ev("click", "/patients", detail={"target": "a:Patient 09a1d4c3…", "x": 1, "y": 1, "responded": True, "interactive": True})])
    assert db.query(UsageEvent).one().detail == {"target": "a:Patient #…", "x": 1, "y": 1, "responded": True, "interactive": True}


def test_csv_cells_that_look_like_formulas_are_escaped(client):
    client.as_user(ANNOTATOR_SUBJECT)
    post(client, [ev("action", "/x", name="=HYPERLINK(1)")])
    client.as_admin()
    assert ",'=HYPERLINK(1)," in client.get("/admin/usage/export/events.csv").text


def test_the_case_table_joins_viewer_work_with_what_made_the_case_hard(client, db):
    """Hands-on time from the viewer events, next to the case's slices,
    objects, rework and felt difficulty -- and the build that sent it."""
    import uuid as _uuid

    from shared_models.models import Annotation, Instance

    client.as_admin()
    sid = make_study(client)
    case = make_case(client, sid, external="p-hard")
    series_id = make_series(db, case["id"])
    for i in range(3):
        db.add(Instance(series_id=series_id, sop_instance_uid=f"1.4.{_uuid.uuid4().int % 10**12}", instance_number=i, object_storage_key=f"k{i}"))
    db.commit()
    make_annotation(db, sid, series_id, ANNOTATOR_SUBJECT, "rejected")
    latest = make_annotation(db, sid, series_id, ANNOTATOR_SUBJECT, "draft")
    db.query(Annotation).filter_by(id=latest).update({"payload": {"mask_volume_key": "k", "labels": [], "objects": [{"id": 1}, {"id": 2}]}})
    db.commit()
    card = client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": "annotation", "title": "Annotate", "position_x": 0, "position_y": 0, "config": {}}).json()

    client.as_user(ANNOTATOR_SUBJECT, ["annotator"])
    ids = {"job_id": card["id"], "case_id": case["id"]}
    events = [
        ev("page_view", "/viewer/:id", app="viewer", at_s=0, detail={**ids, "device": "touch"}),
        ev("key", "/viewer/:id", app="viewer", at_s=3, name="p"),
        ev("action", "/viewer/:id", app="viewer", at_s=5, name="tool.paint"),
        ev("page_leave", "/viewer/:id", app="viewer", at_s=60, duration_ms=60000),
        ev("action", "/viewer/:id", app="viewer", at_s=61, name="case.rating", detail={**ids, "rating": 4, "task": "annotate"}),
        ev("perf", "/viewer/:id", app="viewer", at_s=62, detail={"endpoint": "/data/series/0a1b2c3d4e5f/volume", "count": 3, "ms": 900, "max": 500, "slow": 0, "failures": 0}),
    ]
    post(client, [{**e, "app_version": "0.1.0+test"} for e in events])
    assert {r.app_version for r in db.query(UsageEvent).all()} == {"0.1.0+test"}

    client.as_admin()
    summary = client.get("/admin/usage/summary").json()
    [row] = summary["cases"]
    assert (row["job_type"], row["slices"], row["objects"], row["active_ms"], row["per_object_ms"], row["rating"], row["sent_back"]) == ("annotation", 3, 2, 60000, 30000, 4.0, 1)
    assert row["people"] == ["dr-test"] and row["first_input_ms"] == 3000
    assert summary["effort"]["annotation"]["cases"] == 1 and set(summary["effort_by_device"]) == {"touch"}
    assert summary["ratings"]["count"] == 1 and summary["performance"][0]["endpoint"] == "/data/series/#/volume"
    assert [r["version"] for r in summary["releases"]] == ["0.1.0+test"]
    assert summary["tools"]["tools"][0]["tool"] == "paint"
    assert client.get("/admin/usage/config").json()["rating_every_n"] == 3
    assert "0.1.0+test" in client.get("/admin/usage/export/events.csv").text


def test_layouts_are_sanitised_and_the_heatmap_splits_clicks_by_job_kind(client, db):
    """A screen layout keeps only boxes, known kinds, short masked labels
    and CSS colours; the heatmap tells annotation-job clicks from
    review-job clicks and draws the matching layout behind them."""
    client.as_admin()
    sid = make_study(client)
    ann = client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": "annotation", "title": "Annotate", "position_x": 0, "position_y": 0, "config": {}}).json()
    rev = client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": "review", "title": "Review", "position_x": 300, "position_y": 0, "config": {}}).json()
    boxes = [
        [0, 0, 300, 700, "panel", "", "rgb(26, 26, 46)"],
        [300, 0, 800, 600, "media", "should not be kept"],
        [10, 10, 120, 30, "button", "Patient 09a1d4c3 case", "url(javascript:1)"],
        [10, 50, 200, 24, "input", "typed secret"],
        [1, 2, 3, 4, "script"],
        ["x", 0, 1, 1, "button"],
    ]
    client.as_user(ANNOTATOR_SUBJECT, ["annotator"])
    click = lambda s, at: ev("click", "/viewer/:id", session=s, app="viewer", at_s=at, detail={"x": 800, "y": 450, "viewport": [1600, 900], "target": "canvas"})  # noqa: E731
    post(
        client,
        [
            ev("page_view", "/viewer/:id", session="a", app="viewer", at_s=0, detail={"job_id": ann["id"], "case_id": "c"}),
            ev("layout", "/viewer/:id", session="a", app="viewer", at_s=2, detail={"elements": boxes, "viewport": [1600, 900], "bg": "rgb(10, 10, 20)"}),
            click("a", 3),
            ev("page_view", "/viewer/:id", session="r", app="viewer", at_s=10, detail={"job_id": rev["id"], "case_id": "c"}),
            click("r", 11),
            click("r", 12),
        ],
    )
    stored = db.query(UsageEvent).filter_by(event_type="layout").one().detail
    assert stored["elements"] == [[0, 0, 300, 700, "panel", "", "rgb(26, 26, 46)"], [300, 0, 800, 600, "media"], [10, 10, 120, 30, "button", "Patient # case"], [10, 50, 200, 24, "input"]]
    assert stored["bg"] == "rgb(10, 10, 20)"

    client.as_admin()
    heat = client.get("/admin/usage/heatmap", params={"route": "/viewer/:id"}).json()
    assert heat["modes"] == {"annotation": 1, "review": 2, "other": 0} and len(heat["points"]) == 3
    assert heat["layout"]["mode"] == "annotation" and heat["layout"]["viewport"] == [1600, 900]
    review_only = client.get("/admin/usage/heatmap", params={"route": "/viewer/:id", "mode": "review"}).json()
    assert {p["mode"] for p in review_only["points"]} == {"review"} and review_only["layout"] is None
    session = client.get("/admin/usage/sessions/r").json()
    assert session["events"][0]["detail"]["job_type"] == "review"
    assert "layout" not in client.get("/admin/usage/export/events.csv").text.split("\n", 1)[1]


def test_screen_snapshots_are_cleaned_stored_and_drawn_behind_the_clicks(client, db):
    import base64
    import gzip

    from shared_models.models import UsageSnapshot, UsageSnapshotStyle

    client.as_admin()
    sid = make_study(client)
    rev = client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": "review", "title": "Review", "position_x": 0, "position_y": 0, "config": {}}).json()
    html = '<html><head></head><body><h1>Viewer</h1><img src="/scan.png"><button onclick="x()">Submit review</button><input value="typed"></body></html>'
    body = {
        "session_id": "snap-s",
        "app": "viewer",
        "app_version": "0.1.0+t",
        "route": "/viewer/:id",
        "job_id": rev["id"],
        "viewport": [1600, 900],
        "occurred_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
        "html_gz": base64.b64encode(gzip.compress(html.encode())).decode(),
        "css_hash": "abc123",
        "css": ".btn{color:red;background:url(/x.png)}",
    }
    client.as_user(REVIEWER_SUBJECT, ["reviewer"])
    post(client, [ev("page_view", "/viewer/:id", session="snap-s", app="viewer", detail={"job_id": rev["id"], "case_id": "c"}), ev("click", "/viewer/:id", session="snap-s", app="viewer", at_s=1, detail={"x": 10, "y": 10, "viewport": [1600, 900]})])
    assert client.post("/admin/usage/snapshots", json=body).json() == {"stored": True}
    assert client.post("/admin/usage/snapshots", json={**body, "html_gz": "!!"}).status_code == 422
    assert db.query(UsageSnapshot).one().user_id == REVIEWER_SUBJECT and db.query(UsageSnapshotStyle).count() == 1
    assert client.get("/admin/usage/snapshots/" + str(db.query(UsageSnapshot).one().id)).status_code == 403

    client.as_admin()
    heat = client.get("/admin/usage/heatmap", params={"route": "/viewer/:id"}).json()
    assert heat["snapshot"]["mode"] == "review" and heat["snapshot"]["viewport"] == [1600, 900]
    assert client.get("/admin/usage/heatmap", params={"route": "/viewer/:id", "mode": "annotation"}).json()["snapshot"] is None
    doc = client.get(f"/admin/usage/snapshots/{heat['snapshot']['id']}").json()["document"]
    assert "<h1>Viewer</h1>" in doc and "Submit review" in doc and ".btn{color:red" in doc
    for gone in ("<img", "scan.png", "onclick", "typed", "url(/x.png)"):
        assert gone not in doc, gone
    session = client.get("/admin/usage/sessions/snap-s").json()
    assert [x["id"] for x in session["snapshots"]] == [heat["snapshot"]["id"]]

    # recording clicks off: snapshots are refused too
    client.put("/admin/usage/settings", json={"track_clicks": False})
    client.as_user(REVIEWER_SUBJECT, ["reviewer"])
    assert client.post("/admin/usage/snapshots", json=body).json() == {"stored": False}

    # old snapshots go with the events, and styles nothing uses any more
    db.query(UsageSnapshot).update({"occurred_at": datetime.now(timezone.utc) - timedelta(days=400)})
    db.commit()
    purge_expired(db, get_settings(db), force=True)
    assert db.query(UsageSnapshot).count() == 0 and db.query(UsageSnapshotStyle).count() == 0


def test_heatmap_places_clicks_on_the_element_in_the_best_picture_and_filters_by_study(client, db):
    client.as_admin()
    sid = make_study(client)
    other = make_study(client, name="Study B")
    snap = {
        "session_id": "pic",
        "app": "viewer",
        "route": "/viewer/:id",
        "viewport": [1600, 900],
        "occurred_at": (BASE + timedelta(seconds=30)).isoformat(),
        "html": "<html><head></head><body><div data-testid='pane-coronal'></div></body></html>",
        "anchors": [["testid:pane-coronal", 400, 100, 400, 400], ["testid:object-1", 1200, 300, 200, 20]],
        "study_id": sid,
        "structure_key": "k1",
    }
    client.as_user(ANNOTATOR_SUBJECT, ["annotator"])
    assert client.post("/admin/usage/snapshots", json=snap).json() == {"stored": True}
    assert client.post("/admin/usage/snapshots", json={**snap, "anchors": [["testid:pane-axial", 0, 0, 10, 10]], "study_id": other, "structure_key": "k2"}).json() == {"stored": True}
    click = lambda s, at, target, rx, ry: ev("click", "/viewer/:id", session=s, app="viewer", at_s=at, detail={"x": 5, "y": 5, "viewport": [800, 600], "target": target, "rx": rx, "ry": ry})  # noqa: E731
    post(
        client,
        [
            ev("page_view", "/viewer/:id", session="a", app="viewer", detail={"study_id": sid}),
            click("a", 1, "testid:pane-coronal", 0.5, 0.5),
            click("a", 2, "testid:object-4", 0.5, 0.5),
            click("a", 3, "testid:pane-axial", 0.5, 0.5),
            ev("page_view", "/viewer/:id", session="b", app="viewer", at_s=10, detail={"study_id": other}),
            click("b", 11, "testid:pane-axial", 0.1, 0.1),
        ],
    )
    client.as_admin()
    heat = client.get("/admin/usage/heatmap", params={"route": "/viewer/:id", "study_id": sid}).json()
    assert heat["snapshot"]["study_id"] == sid and heat["snapshot"]["structure_key"] == "k1"
    placed = {p["target"]: p for p in heat["points"]}
    assert (placed["testid:pane-coronal"]["x"], placed["testid:pane-coronal"]["y"], placed["testid:pane-coronal"]["placed"]) == (0.375, round(300 / 900, 4), "exact")
    assert placed["testid:object-4"]["placed"] == "similar"
    assert heat["hidden"] == [{"target": "testid:pane-axial", "clicks": 1}]
    assert heat["placement"] == {"total": 3, "exact": 1, "similar": 1, "screen": 0, "hidden": 1}
    # the other study's clicks, on its own picture
    heat_b = client.get("/admin/usage/heatmap", params={"route": "/viewer/:id", "study_id": other}).json()
    assert [p["target"] for p in heat_b["points"]] == ["testid:pane-axial"] and heat_b["snapshot"]["study_id"] == other
    # the rest of the page follows the study too
    assert client.get("/admin/usage/summary", params={"study_id": sid}).json()["totals"]["sessions"] == 1
    assert [s_["session_id"] for s_ in client.get("/admin/usage/sessions", params={"study_id": other}).json()] == ["b"]


def _snapshot_body(session, css_hash="st1"):
    import base64
    import gzip

    return {
        "session_id": session,
        "app": "viewer",
        "route": "/viewer/:id",
        "viewport": [1600, 900],
        "occurred_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
        "html_gz": base64.b64encode(gzip.compress(b"<html><head></head><body><h1>V</h1></body></html>")).decode(),
        "css_hash": css_hash,
        "css": ".a{color:red}",
    }


def test_clearing_the_log_is_admin_only_moves_everything_out_and_restores_it(client, db):
    from shared_models.models import AuditLog, UsageEventArchive, UsageSnapshot, UsageSnapshotArchive, UsageSnapshotStyle

    client.as_user(ANNOTATOR_SUBJECT, ["annotator"])
    post(client, [ev("page_view", "/my-jobs", session="c1"), ev("click", "/my-jobs", session="c1", at_s=1, detail={"x": 1, "y": 1, "viewport": [1600, 900]})])
    assert client.post("/admin/usage/snapshots", json=_snapshot_body("c1")).json() == {"stored": True}
    assert client.post("/admin/usage/clear", json={"confirm": True}).status_code == 403
    assert client.get("/admin/usage/clears").status_code == 403

    client.as_admin()
    # the confirmation has to be sent explicitly
    assert client.post("/admin/usage/clear", json={}).status_code == 422
    assert client.post("/admin/usage/clear", json={"confirm": False}).status_code == 422
    before = client.get("/admin/usage/clears").json()
    assert before["live"] == {"events": 2, "snapshots": 1} and before["clears"] == []

    r = client.post("/admin/usage/clear", json={"confirm": True})
    assert r.status_code == 200, r.text
    cleared = r.json()["clear"]
    assert cleared["events"] == 2 and cleared["snapshots"] == 1 and cleared["status"] == "archived"
    assert cleared["first_at"] is not None and cleared["last_at"] >= cleared["first_at"]
    assert r.json()["live"] == {"events": 0, "snapshots": 0}
    assert db.query(UsageEvent).count() == 0 and db.query(UsageSnapshot).count() == 0
    assert db.query(UsageEventArchive).count() == 2 and db.query(UsageSnapshotArchive).count() == 1
    # every figure now starts from empty
    assert client.get("/admin/usage/summary").json()["totals"]["events"] == 0
    # nothing left to clear
    assert client.post("/admin/usage/clear", json={"confirm": True}).status_code == 409

    # the purge keeps a stylesheet an archived snapshot still needs
    purge_expired(db, get_settings(db), force=True)
    assert db.query(UsageSnapshotStyle).count() == 1

    # new activity after the clear merges with the restored log
    client.as_user(ANNOTATOR_SUBJECT, ["annotator"])
    post(client, [ev("page_view", "/studies", session="c2", at_s=5)])
    client.as_admin()
    r = client.post(f"/admin/usage/clears/{cleared['id']}/restore")
    assert r.status_code == 200, r.text
    assert r.json()["restored"] == {"events": 2, "snapshots": 1}
    assert db.query(UsageEvent).count() == 3 and db.query(UsageSnapshot).count() == 1 and db.query(UsageEventArchive).count() == 0
    listed = r.json()["clears"][0]
    assert listed["status"] == "restored" and listed["restored_at"] is not None
    # a restore happens once; a restored clear can't be deleted either
    assert client.post(f"/admin/usage/clears/{cleared['id']}/restore").status_code == 409
    assert client.delete(f"/admin/usage/clears/{cleared['id']}").status_code == 409
    assert client.post("/admin/usage/clears/not-a-uuid/restore").status_code == 404

    actions = sorted(a.action for a in db.query(AuditLog).filter(AuditLog.action.like("usage.%")).all())
    assert actions == ["usage.clear", "usage.restore"]


def test_a_cleared_log_can_be_deleted_for_good_and_ages_out_with_retention(client, db):
    from shared_models.models import UsageEventArchive, UsageSnapshotArchive

    client.as_user(ANNOTATOR_SUBJECT, ["annotator"])
    post(client, [ev("page_view", "/my-jobs", session="d1")])
    client.as_admin()
    first = client.post("/admin/usage/clear", json={"confirm": True}).json()["clear"]
    r = client.delete(f"/admin/usage/clears/{first['id']}")
    assert r.status_code == 200 and r.json()["clears"][0]["status"] == "deleted"
    assert db.query(UsageEventArchive).count() == 0
    assert client.post(f"/admin/usage/clears/{first['id']}/restore").status_code == 409

    # an archived clear older than the retention period expires
    client.as_user(ANNOTATOR_SUBJECT, ["annotator"])
    post(client, [ev("page_view", "/my-jobs", session="d2")])
    assert client.post("/admin/usage/snapshots", json=_snapshot_body("d2")).json() == {"stored": True}
    client.as_admin()
    second = client.post("/admin/usage/clear", json={"confirm": True}).json()["clear"]
    db.query(UsageEventArchive).update({"occurred_at": datetime.now(timezone.utc) - timedelta(days=400)})
    db.query(UsageSnapshotArchive).update({"occurred_at": datetime.now(timezone.utc) - timedelta(days=400)})
    db.commit()
    purge_expired(db, get_settings(db), force=True)
    listed = {c["id"]: c for c in client.get("/admin/usage/clears").json()["clears"]}
    assert listed[second["id"]]["status"] == "expired" and listed[second["id"]]["remaining"] == {"events": 0, "snapshots": 0}


def test_case_images_ride_along_only_while_the_switch_is_on(client, db):
    import base64
    import gzip

    shot = '<img data-vl-shot="" src="data:image/webp;base64,UklGRg==" style="width:800px;height:600px;object-fit:fill;">'

    def body(session):
        html = f"<html><head></head><body><h1>V</h1>{shot}</body></html>"
        return {**_snapshot_body(session), "html_gz": base64.b64encode(gzip.compress(html.encode())).decode()}

    client.as_user(ANNOTATOR_SUBJECT, ["annotator"])
    assert client.get("/admin/usage/config").json()["track_screen_images"] is False
    assert client.post("/admin/usage/snapshots", json=body("i1")).json() == {"stored": True}

    client.as_admin()
    assert client.get("/admin/usage/settings").json()["track_screen_images"] is False
    assert client.put("/admin/usage/settings", json={"track_screen_images": True}).json()["track_screen_images"] is True
    client.as_user(ANNOTATOR_SUBJECT, ["annotator"])
    assert client.get("/admin/usage/config").json()["track_screen_images"] is True
    assert client.post("/admin/usage/snapshots", json=body("i2")).json() == {"stored": True}

    from shared_models.models import UsageSnapshot

    client.as_admin()
    off, on = (client.get(f"/admin/usage/snapshots/{db.query(UsageSnapshot).filter_by(session_id=sid).one().id}").json() for sid in ("i1", "i2"))
    assert off["has_images"] is False and on["has_images"] is True
    assert "data-vl-shot" not in off["document"] and shot in on["document"]


def test_the_study_filtered_csv_holds_only_the_studys_pages(client):
    """H-01: with a study picked, the export held every event of every
    session that ever opened a page of the study -- /my-jobs clicks too --
    so a spreadsheet never matched the page's study-filtered figures."""
    sid = "11111111-2222-4333-8444-555555555555"
    client.as_user(ANNOTATOR_SUBJECT)
    post(client, [
        ev("page_view", "/my-jobs", session="h1", at_s=0),
        ev("click", "/my-jobs", session="h1", at_s=1, name="Open job", detail={"x": 1, "y": 1}),
        ev("page_view", "/studies/:id", session="h1", at_s=2, detail={"study_id": sid}),
        ev("click", "/studies/:id", session="h1", at_s=3, name="Open case", detail={"x": 2, "y": 2}),
        ev("page_view", "/my-jobs", session="h1", at_s=4),
        ev("click", "/my-jobs", session="h1", at_s=5, name="Back", detail={"x": 3, "y": 3}),
    ])
    client.as_admin()
    body = client.get("/admin/usage/export/events.csv", params={"days": 7, "study_id": sid}).text
    rows = [line for line in body.splitlines()[1:] if line.strip()]
    assert len(rows) == 2 and all("/studies/:id" in r for r in rows), rows


def test_one_account_cannot_restyle_or_push_out_other_peoples_snapshots(client, db):
    """H-09: the stylesheet hash was chosen by the client and the first
    upload of a hash kept forever -- anyone could restyle other people's
    snapshots ("Session expired -- sign in at evil.example") -- and 300
    junk uploads pushed every genuine snapshot of a screen out."""
    import base64
    import gzip

    from app.usage import snapshots
    from shared_models.models import UsageSnapshot

    def snap(session, css, html="<html><body><h1>Jobs</h1></body></html>"):
        return {
            "session_id": session, "app": "admin-ui", "route": "/my-jobs", "viewport": [1600, 900],
            "occurred_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
            "html_gz": base64.b64encode(gzip.compress(html.encode())).decode(), "css_hash": "shared-hash-1", "css": css,
        }

    client.as_user(ANNOTATOR_SUBJECT)  # the attacker, first to upload the hash
    assert client.post("/admin/usage/snapshots", json=snap("att", "body::after{content:'Session expired'}")).json() == {"stored": True}
    client.as_user(REVIEWER_SUBJECT)
    assert client.post("/admin/usage/snapshots", json=snap("vic", "h1{color:green}")).json() == {"stored": True}
    victim = db.query(UsageSnapshot).filter_by(user_id=REVIEWER_SUBJECT).one()
    client.as_admin()
    doc = client.get(f"/admin/usage/snapshots/{victim.id}").json()["document"]
    assert "color:green" in doc and "Session expired" not in doc

    client.as_user(ANNOTATOR_SUBJECT)
    for n in range(snapshots.KEEP_PER_USER_SCREEN + 5):
        client.post("/admin/usage/snapshots", json=snap(f"junk{n}", "x{}"))
    db.expire_all()
    assert db.query(UsageSnapshot).filter_by(user_id=REVIEWER_SUBJECT).count() == 1  # the genuine one survives
    assert db.query(UsageSnapshot).filter_by(user_id=ANNOTATOR_SUBJECT).count() == snapshots.KEEP_PER_USER_SCREEN
