"""Studies and memberships through the real API: who may do what, what
gets written, and that every change leaves an audit line."""
from .conftest import ADMIN_SUBJECT, ANNOTATOR_SUBJECT, DM_SUBJECT, add_member, make_case, make_study


def test_only_platform_admin_creates_studies(client):
    client.as_user(DM_SUBJECT)
    assert client.post("/admin/studies", params={"name": "nope"}).status_code == 403
    client.as_admin()
    assert client.post("/admin/studies", params={"name": "ok"}).status_code == 200


def test_member_sees_only_their_studies_with_their_role(client):
    a = make_study(client, "A")
    make_study(client, "B")
    add_member(client, a, DM_SUBJECT, "data_manager")
    client.as_user(DM_SUBJECT)
    listed = client.get("/admin/studies").json()
    assert [s["id"] for s in listed] == [a]
    assert listed[0]["my_role"] == "data_manager"
    # and B is a 403, not a 404 leak
    client.as_admin()
    b = client.get("/admin/studies").json()[1]["id"]
    client.as_user(DM_SUBJECT)
    assert client.get(f"/admin/studies/{b}").status_code == 403


def test_update_is_audited_with_from_to(client):
    sid = make_study(client, "Old name")
    r = client.patch(f"/admin/studies/{sid}", params={"name": "New name", "description": "d"})
    assert r.status_code == 200 and r.json()["name"] == "New name"
    log = client.get("/admin/audit-log", params={"entity_id": sid}).json()["entries"]
    update = next(e for e in log if e["action"] == "study.update")
    assert update["diff"]["name"] == {"from": "Old name", "to": "New name"}
    assert update["actor"] == "platform-admin"


def test_add_member_is_an_upsert_and_role_changes_are_audited(client):
    sid = make_study(client)
    first = add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    assert first["created"] is True and first["role"] == "annotator" and first["username"] == "dr-test"
    second = add_member(client, sid, ANNOTATOR_SUBJECT, "reviewer")
    assert second["created"] is False and second["role"] == "reviewer"
    actions = [e["action"] for e in client.get("/admin/audit-log", params={"entity_id": sid}).json()["entries"]]
    assert "member.add" in actions and "member.change_role" in actions


def test_study_admin_manages_members_but_cannot_remove_themselves(client):
    sid = make_study(client)
    add_member(client, sid, DM_SUBJECT, "admin")
    client.as_user(DM_SUBJECT)
    assert client.post(f"/admin/studies/{sid}/members", params={"user_id": ANNOTATOR_SUBJECT, "role": "annotator"}).status_code == 200
    assert client.delete(f"/admin/studies/{sid}/members/{DM_SUBJECT}").status_code == 409
    assert client.delete(f"/admin/studies/{sid}/members/{ANNOTATOR_SUBJECT}").status_code == 204
    # a plain annotator can read members (needs names for the board) but not edit
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    client.as_user(ANNOTATOR_SUBJECT)
    assert client.get(f"/admin/studies/{sid}/members").status_code == 200
    assert client.post(f"/admin/studies/{sid}/members", params={"user_id": DM_SUBJECT, "role": "viewer"}).status_code == 403


def test_assignee_must_be_a_member(client):
    sid = make_study(client)
    body = {"type": "annotation", "title": "Job", "position_x": 0, "position_y": 0, "config": {"assigned_user_id": ANNOTATOR_SUBJECT}}
    assert client.post(f"/admin/studies/{sid}/workflow/cards", json=body).status_code == 422
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    assert client.post(f"/admin/studies/{sid}/workflow/cards", json=body).status_code == 201


def test_delete_refuses_a_study_with_cases_unless_forced(client):
    sid = make_study(client)
    make_case(client, sid)
    r = client.delete(f"/admin/studies/{sid}")
    assert r.status_code == 409 and "1 case" in r.json()["detail"]
    assert client.delete(f"/admin/studies/{sid}", params={"force": "true"}).status_code == 204
    assert client.get(f"/admin/studies/{sid}").status_code == 404
    deleted = [e for e in client.get("/admin/audit-log").json()["entries"] if e["action"] == "study.delete"]
    assert deleted and deleted[0]["diff"]["cases_deleted"] == 1
    assert deleted[0]["actor_id"] == ADMIN_SUBJECT


def test_me_reports_memberships(client):
    sid = make_study(client, "Mine")
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    client.as_user(ANNOTATOR_SUBJECT)
    me = client.get("/admin/me").json()
    assert me["is_admin"] is False
    assert me["memberships"] == [{"study_id": sid, "study_name": "Mine", "role": "annotator"}]
