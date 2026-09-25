"""A-09: the Store's pipeline templates and the annotation types were
readable -- and templates creatable -- by any logged-in account, even one
that belongs to no study. Annotation types are for study members (the
viewer reads them for annotators); templates for those who build boards."""
from .conftest import ANNOTATOR_SUBJECT, DM_SUBJECT, REVIEWER_SUBJECT, add_member, make_study

TEMPLATE = {"title": "t", "cards": [{"key": "a", "type": "note", "title": "a", "x": 0, "y": 0, "width": 1, "height": 1, "config": {}}], "edges": []}


def test_platform_configuration_needs_a_study_role(client):
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    add_member(client, sid, DM_SUBJECT, "data_manager")

    client.as_user(REVIEWER_SUBJECT)  # member of nothing
    assert client.get("/admin/annotation-types").status_code == 403
    assert client.get("/admin/pipeline-templates").status_code == 403
    assert client.post("/admin/pipeline-templates", json=TEMPLATE).status_code == 403

    client.as_user(ANNOTATOR_SUBJECT)  # annotates, doesn't build boards
    assert client.get("/admin/annotation-types").status_code == 200
    assert client.get("/admin/pipeline-templates").status_code == 403

    client.as_user(DM_SUBJECT)  # builds boards
    assert client.get("/admin/pipeline-templates").status_code == 200
    assert client.post("/admin/pipeline-templates", json=TEMPLATE).status_code == 201

    client.as_admin()
    assert client.get("/admin/annotation-types").status_code == 200
    assert client.get("/admin/pipeline-templates").status_code == 200
