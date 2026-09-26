"""K8: every case opened in the image's own window, so in a lung-nodule
study some opened in soft tissue (40/400) -- a ground-glass nodule is
invisible there, and a hurried reviewer could approve a mask without ever
seeing it. A Surface now says which window a case opens in; a Review job
without its own takes the Annotation surface's, like the labels."""
from .conftest import ANNOTATOR_SUBJECT, REVIEWER_SUBJECT, add_member, make_study
from .test_workflow_jobs import _card, _edge


def test_the_surface_sets_the_window_a_case_opens_in(client):
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    add_member(client, sid, REVIEWER_SUBJECT, "reviewer")
    ann = _card(client, sid, "annotation", "Annotate", {"assigned_user_id": ANNOTATOR_SUBJECT})
    rev = _card(client, sid, "review", "Review", {"assigned_user_id": REVIEWER_SUBJECT}, x=300)
    _edge(client, sid, ann["id"], rev["id"])
    surface = _card(client, sid, "annotation_surface", "Lung surface", {"tools": ["paint"], "panes": ["axial"], "default_window": "Lung"}, x=600)
    _edge(client, sid, surface["id"], ann["id"], source_handle="surface_config", target_handle="surface_config")

    assert client.get(f"/admin/workflow-cards/{ann['id']}/surface-config").json()["default_window"] == "Lung"
    assert client.get(f"/admin/workflow-cards/{rev['id']}/surface-config").json()["default_window"] == "Lung"  # inherited

    own = _card(client, sid, "review_surface", "Review surface", {"panes": ["axial"], "default_window": "Soft tissue"}, x=900)
    _edge(client, sid, own["id"], rev["id"], source_handle="surface_config", target_handle="surface_config")
    assert client.get(f"/admin/workflow-cards/{rev['id']}/surface-config").json()["default_window"] == "Soft tissue"

    # an unknown value is not passed on; no surface means the image's own window
    client.patch(f"/admin/workflow-cards/{surface['id']}", json={"config": {**surface["config"], "default_window": "Plasma"}})
    assert client.get(f"/admin/workflow-cards/{ann['id']}/surface-config").json()["default_window"] is None
    bare = _card(client, sid, "annotation", "No surface", {"assigned_user_id": ANNOTATOR_SUBJECT}, x=1200)
    assert client.get(f"/admin/workflow-cards/{bare['id']}/surface-config").json()["default_window"] is None
