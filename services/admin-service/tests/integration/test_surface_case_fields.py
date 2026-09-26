"""Case questions (UX-ux-admin-16): a triage "No finding / Nodule / Other"
had to be asked with a fake object, because forms belonged to drawn
objects. The Annotation Surface now carries `case_fields`, answered once
per case; a Review job reads the Annotation surface's, as with the labels."""
from .conftest import ANNOTATOR_SUBJECT, REVIEWER_SUBJECT, add_member, make_study
from .test_workflow_jobs import _card, _edge

QUESTION = {"name": "Finding", "kind": "choice", "options": ["No finding", "Nodule", "Other"]}


def test_the_surface_carries_case_questions_to_both_jobs(client):
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    add_member(client, sid, REVIEWER_SUBJECT, "reviewer")
    ann = _card(client, sid, "annotation", "Annotate", {"assigned_user_id": ANNOTATOR_SUBJECT})
    rev = _card(client, sid, "review", "Review", {"assigned_user_id": REVIEWER_SUBJECT}, x=300)
    _edge(client, sid, ann["id"], rev["id"])
    bare = client.get(f"/admin/workflow-cards/{ann['id']}/surface-config").json()
    assert bare["case_fields"] == []
    surface = _card(client, sid, "annotation_surface", "Triage surface", {"tools": ["paint"], "panes": ["axial"], "case_fields": [QUESTION]}, x=600)
    _edge(client, sid, surface["id"], ann["id"], source_handle="surface_config", target_handle="surface_config")
    assert client.get(f"/admin/workflow-cards/{ann['id']}/surface-config").json()["case_fields"] == [QUESTION]
    assert client.get(f"/admin/workflow-cards/{rev['id']}/surface-config").json()["case_fields"] == [QUESTION]
    # something that isn't a list of questions is not passed on
    client.patch(f"/admin/workflow-cards/{surface['id']}", json={"config": {"case_fields": "Finding?"}})
    assert client.get(f"/admin/workflow-cards/{ann['id']}/surface-config").json()["case_fields"] == []
