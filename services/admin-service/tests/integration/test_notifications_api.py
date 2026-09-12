"""The notification service's HTTP surface plus one real observation
cycle: settings (password never echoed), preferences, run-now with the
poller's bootstrap-then-diff behaviour, the delivery log, test email."""
from .conftest import ANNOTATOR_SUBJECT, REVIEWER_SUBJECT, add_member, make_case, make_study


def test_settings_round_trip_never_echoes_the_password(client):
    s = client.get("/admin/notifications/settings").json()
    assert s["smtp_host"] == "mailpit" and s["smtp_password_set"] is False and "smtp_password" not in s
    r = client.put("/admin/notifications/settings", json={"smtp_host": "smtp.example.test", "smtp_port": 587, "smtp_use_tls": True, "smtp_password": "hunter2"})
    assert r.status_code == 200 and r.json()["smtp_password_set"] is True and "hunter2" not in r.text
    # null leaves the stored password alone, "" clears it
    assert client.put("/admin/notifications/settings", json={"smtp_password": None}).json()["smtp_password_set"] is True
    assert client.put("/admin/notifications/settings", json={"smtp_password": ""}).json()["smtp_password_set"] is False
    assert client.put("/admin/notifications/settings", json={"poll_interval_seconds": 3}).status_code == 422


def test_settings_are_admin_only_but_own_preferences_are_for_everyone(client):
    client.as_user(ANNOTATOR_SUBJECT)
    assert client.get("/admin/notifications/settings").status_code == 403
    mine = client.get("/admin/notifications/preferences/me").json()
    assert mine["email_enabled"] is True
    assert client.put("/admin/notifications/preferences/me", json={"email_enabled": False}).json()["email_enabled"] is False
    client.as_admin()
    row = next(p for p in client.get("/admin/notifications/preferences").json() if p["user_id"] == ANNOTATOR_SUBJECT)
    assert row["email_enabled"] is False and row["username"] == "dr-test"


def test_first_cycle_is_silent_then_assignment_and_status_changes_email(client, db, outbox):
    client.put("/admin/notifications/settings", json={"enabled": True})
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    add_member(client, sid, REVIEWER_SUBJECT, "reviewer")
    make_case(client, sid)
    card = client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": "annotation", "title": "Job", "position_x": 0, "position_y": 0, "config": {"assigned_user_id": ANNOTATOR_SUBJECT}}).json()

    first = client.post("/admin/notifications/run-now").json()
    assert first["bootstrap"] is True and first["sent"] == 0 and outbox == []

    client.patch(f"/admin/workflow-cards/{card['id']}", json={"config": {"assigned_user_id": REVIEWER_SUBJECT}})
    second = client.post("/admin/notifications/run-now").json()
    assert second["events"] == 1 and second["sent"] == 1
    assert outbox[-1]["to"] == "dr-review@example.test" and outbox[-1]["subject"].startswith("New annotation job")
    assert "What this means" in outbox[-1]["text"] and "What to do" in outbox[-1]["text"] and "http" not in outbox[-1]["text"]

    log = client.get("/admin/notifications/log").json()
    assert log[0]["event_type"] == "job_assigned" and log[0]["status"] == "sent" and log[0]["user_id"] == REVIEWER_SUBJECT


def test_opted_out_user_is_skipped_with_a_reason(client, db, outbox):
    client.put("/admin/notifications/settings", json={"enabled": True})
    client.put(f"/admin/notifications/preferences/{ANNOTATOR_SUBJECT}", json={"notify_new_job": False})
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    client.post("/admin/notifications/run-now")  # bootstrap
    client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": "annotation", "title": "Job", "position_x": 0, "position_y": 0, "config": {"assigned_user_id": ANNOTATOR_SUBJECT}})
    result = client.post("/admin/notifications/run-now").json()
    assert result["events"] == 1 and result["skipped"] == 1 and outbox == []
    assert "opted out" in client.get("/admin/notifications/log").json()[0]["error"]


def test_delivery_off_still_advances_the_snapshot(client, db, outbox):
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    client.post("/admin/notifications/run-now")
    client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": "annotation", "title": "Job", "position_x": 0, "position_y": 0, "config": {"assigned_user_id": ANNOTATOR_SUBJECT}})
    assert client.post("/admin/notifications/run-now").json()["skipped"] == 1
    assert client.post("/admin/notifications/run-now").json()["events"] == 0  # not replayed
    assert outbox == []


def test_test_email_goes_through_the_saved_settings(client, outbox):
    client.put("/admin/notifications/settings", json={"enabled": True})
    r = client.post("/admin/notifications/test-email", json={"to": "someone@example.test"})
    assert r.status_code == 200 and outbox[-1]["to"] == "someone@example.test"
    assert client.get("/admin/notifications/log").json()[0]["event_type"] == "test"
    status = client.get("/admin/notifications/status").json()
    assert status["enabled"] is True and status["log_entries"] >= 1
