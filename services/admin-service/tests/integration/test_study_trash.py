"""Deleting a study from the UI puts it in the trash (UX K2: a deleted study
and everything in it was gone at once, with no way back). A trashed study
keeps its data, is hidden from every list, answers 404 to every
study-scoped call, and can be restored -- or deleted for good."""
from .conftest import ANNOTATOR_SUBJECT, add_member, make_case, make_study


def _trash(client, sid):
    return client.post(f"/admin/studies/{sid}/trash")


def test_a_trashed_study_is_hidden_and_closed_until_restored(client):
    sid = make_study(client, "Pilot")
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    make_case(client, sid)
    assert _trash(client, sid).status_code == 200
    assert sid not in [s["id"] for s in client.get("/admin/studies").json()]
    r = client.get(f"/admin/studies/{sid}")
    assert r.status_code == 404 and "trash" in r.json()["detail"]
    trashed = client.get("/admin/studies/trash").json()
    assert [(t["id"], t["name"], t["case_count"], t["deleted_by_name"]) for t in trashed] == [(sid, "Pilot", 1, "Platform-Admin User")]
    assert trashed[0]["deleted_at"]

    client.as_user(ANNOTATOR_SUBJECT)
    assert client.get("/admin/studies").json() == []
    assert client.get(f"/admin/studies/{sid}/members").status_code == 404

    client.as_admin()
    assert client.post(f"/admin/studies/{sid}/restore").status_code == 200
    assert client.get("/admin/studies/trash").json() == []
    client.as_user(ANNOTATOR_SUBJECT)
    assert [s["id"] for s in client.get("/admin/studies").json()] == [sid]
    assert len(client.get(f"/admin/studies/{sid}/members").json()) == 1

    client.as_admin()
    actions = [e["action"] for e in client.get("/admin/audit-log", params={"entity_id": sid}).json()["entries"]]
    assert "study.trash" in actions and "study.restore" in actions


def test_only_a_platform_admin_trashes_restores_and_lists_the_trash(client):
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "admin")
    client.as_user(ANNOTATOR_SUBJECT)
    assert _trash(client, sid).status_code == 403
    assert client.get("/admin/studies/trash").status_code == 403
    client.as_admin()
    _trash(client, sid)
    client.as_user(ANNOTATOR_SUBJECT)
    assert client.post(f"/admin/studies/{sid}/restore").status_code == 403


def test_the_trash_is_emptied_one_study_at_a_time_for_good(client):
    sid = make_study(client)
    make_case(client, sid)
    _trash(client, sid)
    assert client.delete(f"/admin/studies/{sid}", params={"force": True}).status_code == 204
    assert client.get("/admin/studies/trash").json() == []
    assert client.post(f"/admin/studies/{sid}/restore").status_code == 404


def test_a_trashed_study_still_holds_its_name(client):
    sid = make_study(client, "Taken")
    _trash(client, sid)
    r = client.post("/admin/studies", params={"name": "Taken"})
    assert r.status_code == 409 and "trash" in r.json()["detail"]
    assert _trash(client, sid).status_code == 409  # already there
