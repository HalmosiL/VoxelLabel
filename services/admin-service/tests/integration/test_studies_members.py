"""Studies and memberships through the real API: who may do what, what
gets written, and that every change leaves an audit line."""
import uuid

from .conftest import ADMIN_SUBJECT, ANNOTATOR_SUBJECT, DM_SUBJECT, add_member, make_annotation, make_case, make_series, make_study


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


def test_delete_force_removes_annotations_left_on_the_cases_imaging(client, db):
    """Regression: Annotation.target_id is a bare column, not a real FK,
    so an annotated case used to leave the annotation behind when its
    imaging was deleted -- which then 500ed the moment anything tried to
    delete the Study those orphans still (correctly) have a real FK to.
    Force-deleting a study with an annotated case must actually succeed,
    not 500 on the leftover Annotation/AnnotationReview rows."""
    sid = make_study(client)
    case = make_case(client, sid)
    series_id = make_series(db, case["id"])
    make_annotation(db, sid, series_id, ANNOTATOR_SUBJECT, "submitted")
    assert client.delete(f"/admin/studies/{sid}", params={"force": "true"}).status_code == 204
    assert client.get(f"/admin/studies/{sid}").status_code == 404


def test_delete_removes_annotations_with_no_case_left_to_own_them(client, db):
    """Regression, the sharper case: a study with ZERO cases can still
    carry Annotation rows orphaned by an earlier bug (an ImagingStudy/
    Series/Instance deleted without checking whether an annotation still
    targeted it) -- these aren't reachable through any case's cascade, so
    a plain (non-forced) delete has to sweep them by study_id directly,
    or it 500s on data no UI action could otherwise get rid of."""
    sid = make_study(client)
    make_annotation(db, sid, uuid.uuid4(), ANNOTATOR_SUBJECT, "submitted")
    assert client.delete(f"/admin/studies/{sid}").status_code == 204
    assert client.get(f"/admin/studies/{sid}").status_code == 404


def test_delete_imaging_study_removes_annotations_that_targeted_it(client, db):
    """Same bug, the other entry point: deleting an ImagingStudy/Series
    directly (not via study delete) must not leave an Annotation
    dangling either."""
    sid = make_study(client)
    case = make_case(client, sid)
    series_id = make_series(db, case["id"])
    ann_id = make_annotation(db, sid, series_id, ANNOTATOR_SUBJECT, "submitted")
    from shared_models.models import Series
    imaging_study_id = db.get(Series, series_id).imaging_study_id
    assert client.delete(f"/admin/imaging-studies/{imaging_study_id}").status_code == 200
    assert client.get(f"/admin/studies/{sid}").status_code == 200
    # The annotation the deleted series carried is gone too, not orphaned.
    from shared_models.models import Annotation
    db.rollback()
    assert db.get(Annotation, ann_id) is None


def test_me_reports_memberships(client):
    sid = make_study(client, "Mine")
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    client.as_user(ANNOTATOR_SUBJECT)
    me = client.get("/admin/me").json()
    assert me["is_admin"] is False
    assert me["memberships"] == [{"study_id": sid, "study_name": "Mine", "role": "annotator"}]
