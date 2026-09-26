"""People are shown by the name the admin gave them on the Users page, not
by their username or id (UX: "the names set on Users show nowhere, the
avatar says UX"). The fake realm names dr-test "Dr-Test User".

Payloads that carry a `username` keep it (exports, filters, sign-in) and
add `name`; plain display strings (who did a step, an assignee, an audit
actor, a version's author) are the name itself."""
from app import keycloak_admin
from shared_models.models import Annotation

from .conftest import ANNOTATOR_SUBJECT, REVIEWER_SUBJECT, add_member, make_annotation, make_review, make_study
from .test_pipeline_health_api import _pipeline


def test_display_name_falls_back_to_the_username_then_the_id():
    assert keycloak_admin.display_name({"id": "u1", "username": "anna", "first_name": " Anna ", "last_name": "Kovács"}) == "Anna Kovács"
    assert keycloak_admin.display_name({"id": "u1", "username": "anna", "first_name": None, "last_name": ""}) == "anna"
    assert keycloak_admin.display_name({"id": "u1"}) == "u1"


def test_members_notifications_audit_and_usage_carry_the_name(client):
    sid = make_study(client, "Names")
    member = add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    assert member["name"] == "Dr-Test User" and member["username"] == "dr-test"
    listed = client.get(f"/admin/studies/{sid}/members").json()
    assert {m["name"] for m in listed} == {"Dr-Test User"}
    prefs = next(p for p in client.get("/admin/notifications/preferences").json() if p["user_id"] == ANNOTATOR_SUBJECT)
    assert prefs["name"] == "Dr-Test User"
    log = client.get("/admin/audit-log", params={"entity_id": sid}).json()["entries"]
    assert log and all(e["actor"] == "Platform-Admin User" for e in log)
    people = {p["user_id"]: p for p in client.get("/admin/usage/people").json()}
    assert people[ANNOTATOR_SUBJECT]["name"] == "Dr-Test User" and people[ANNOTATOR_SUBJECT]["username"] == "dr-test"
    client.post(f"/admin/studies/{sid}/versions", json={"label": "v1"})
    versions = client.get(f"/admin/studies/{sid}/versions").json()
    assert versions and versions[0]["created_by_name"] == "Platform-Admin User"


def test_analytics_name_who_did_the_work(client, db):
    sid, cases, series, ann, rev = _pipeline(client, db, n_cases=1)
    submitted = make_annotation(db, sid, series[0], ANNOTATOR_SUBJECT, "submitted")
    db.query(Annotation).filter_by(id=submitted).update({"payload": {"mask_volume_key": "k", "labels": [], "objects": []}})
    db.commit()
    make_annotation(db, sid, series[0], REVIEWER_SUBJECT, "draft")
    make_review(db, submitted, REVIEWER_SUBJECT, "approve")
    client.post(f"/admin/workflow-cards/{rev['id']}/run")
    client.as_admin()
    body = client.get(f"/admin/studies/{sid}/analytics").json()
    done = body["cases"][0]
    assert done["annotators"] == ["Dr-Test User"] and done["reviewers"] == ["Dr-Review User"]
    assert body["cards"][ann["id"]]["assignee"] == "Dr-Test User"
    assert {p["name"] for p in body["people"]} >= {"Dr-Test User", "Dr-Review User"}
