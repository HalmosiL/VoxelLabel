"""Self-service registration end to end, the Users endpoints (Keycloak
faked), and the audit-log endpoint itself."""
from .conftest import ADMIN_SUBJECT, ANNOTATOR_SUBJECT, DM_SUBJECT


def _submit(client, username="newdoc", email="newdoc@example.test", **extra):
    return client.post("/public/registration-requests", json={"username": username, "email": email, "first_name": "New", "last_name": "Doc", **extra})


def _delivery_on(client):
    """Registration emails go through the notification service's
    delivery switch, which is OFF on a fresh install -- the flow still
    works (the requests are stored), the emails are just logged as
    skipped. These tests want to see them sent."""
    assert client.put("/admin/notifications/settings", json={"enabled": True}).status_code == 200


def test_submit_creates_a_pending_request_and_emails_requester_and_admins(client, outbox):
    _delivery_on(client)
    r = _submit(client, note="I work on LIDC")
    assert r.status_code == 201 and r.json()["status"] == "pending"
    to = sorted(m["to"] for m in outbox)
    assert to == ["newdoc@example.test", "platform-admin@example.test"]
    receipt = next(m for m in outbox if m["to"] == "newdoc@example.test")
    assert "received" in receipt["subject"].lower() and "http" not in receipt["text"]
    alert = next(m for m in outbox if m["to"] == "platform-admin@example.test")
    assert "I work on LIDC" in alert["text"] and "newdoc" in alert["text"]


def test_delivery_off_still_stores_the_request_and_logs_the_skip(client, outbox):
    r = _submit(client)
    assert r.status_code == 201 and outbox == []
    log = client.get("/admin/notifications/log").json()
    assert {e["event_type"] for e in log} == {"registration_received", "registration_submitted"}
    assert all(e["status"] == "skipped" and "switched off" in e["error"] for e in log)


def test_duplicates_are_refused(client):
    assert _submit(client).status_code == 201
    assert _submit(client).status_code == 409  # pending twice
    assert _submit(client, username="dr-test", email="x@example.test").status_code == 409  # existing account
    assert _submit(client, username="bad name!", email="y@example.test").status_code == 422
    assert _submit(client, username="ok", email="not-an-email").status_code == 422


def test_approve_creates_the_account_with_a_one_time_password(client, keycloak, outbox):
    _delivery_on(client)
    req = _submit(client).json()
    outbox.clear()
    r = client.post(f"/admin/registration-requests/{req['id']}/approve")
    assert r.status_code == 200 and r.json()["status"] == "approved"
    assert keycloak.calls == [("create_user", "newdoc", False)]  # never as admin
    mail = outbox[0]
    assert mail["to"] == "newdoc@example.test" and "Temporary password" in mail["text"]
    assert "href" not in mail["html"]  # the platform address is plain text, never a link
    assert client.post(f"/admin/registration-requests/{req['id']}/approve").status_code == 409
    audit = client.get("/admin/audit-log", params={"entity_type": "registration_request"}).json()["entries"]
    assert audit[0]["action"] == "registration.approve" and audit[0]["diff"]["username"] == "newdoc"


def test_reject_emails_the_reason_and_creates_no_account(client, keycloak, outbox):
    _delivery_on(client)
    req = _submit(client).json()
    outbox.clear()
    r = client.post(f"/admin/registration-requests/{req['id']}/reject", json={"reason": "Not affiliated"})
    assert r.status_code == 200 and r.json()["rejection_reason"] == "Not affiliated"
    assert keycloak.calls == [] and "Not affiliated" in outbox[0]["text"]


def test_registration_queue_is_admin_only(client):
    _submit(client)
    client.as_user(DM_SUBJECT)
    assert client.get("/admin/registration-requests").status_code == 403
    client.as_admin()
    assert [r["username"] for r in client.get("/admin/registration-requests", params={"status": "pending"}).json()] == ["newdoc"]


def test_users_endpoints_drive_keycloak_and_are_audited(client, keycloak):
    created = client.post("/admin/users", json={"username": "u1", "email": "u1@example.test", "first_name": "U", "last_name": "One", "password": "Secret123!", "is_admin": False}).json()
    uid = created["id"]
    assert client.patch(f"/admin/users/{uid}", json={"enabled": False, "is_admin": True}).status_code == 200
    assert client.post(f"/admin/users/{uid}/reset-password", json={"password": "NewSecret1!", "temporary": True}).status_code == 204
    assert client.post(f"/admin/users/{uid}/reset-password", json={"password": "short"}).status_code == 422
    assert client.delete(f"/admin/users/{uid}").status_code == 204
    kinds = [c[0] for c in keycloak.calls]
    assert kinds == ["create_user", "set_admin_role", "update_user", "reset_password", "delete_user"]
    actions = [e["action"] for e in client.get("/admin/audit-log", params={"entity_type": "user", "entity_id": uid}).json()["entries"]]
    assert actions == ["user.delete", "user.reset_password", "user.update", "user.create"]


def test_admin_cannot_lock_themselves_out(client):
    assert client.patch(f"/admin/users/{ADMIN_SUBJECT}", json={"enabled": False}).status_code == 409
    assert client.patch(f"/admin/users/{ADMIN_SUBJECT}", json={"is_admin": False}).status_code == 409
    assert client.delete(f"/admin/users/{ADMIN_SUBJECT}").status_code == 409


def test_audit_log_is_admin_only_and_filters(client):
    sid = client.post("/admin/studies", params={"name": "S"}).json()["id"]
    client.as_user(ANNOTATOR_SUBJECT)
    assert client.get("/admin/audit-log").status_code == 403
    client.as_admin()
    assert client.get("/admin/audit-log", params={"entity_id": "not-a-uuid"}).status_code == 422
    entries = client.get("/admin/audit-log", params={"entity_type": "study", "entity_id": sid}).json()["entries"]
    assert len(entries) == 1 and entries[0]["action"] == "study.create" and entries[0]["actor"] == "platform-admin"
