"""I-03: admin write actions that left no audit line now leave one --
imaging, documents, annotation types, board edges, Store templates,
usage and notification settings, preferences set for someone else."""
import uuid

from shared_models.models import AuditLog

from .conftest import ANNOTATOR_SUBJECT, make_case, make_series, make_study
from .test_workflow_jobs import _card


def _actions(db):
    db.expire_all()
    return {row.action for row in db.query(AuditLog).all()}


def test_admin_write_actions_are_audited(client, db, monkeypatch):
    from app.api import clinical_data

    monkeypatch.setattr(clinical_data, "upload_clinical_data_file", lambda key, data: None)
    sid = make_study(client)
    case_id = make_case(client, sid)["id"]
    series_id = make_series(db, case_id)

    assert client.patch(f"/admin/series/{series_id}", params={"series_description": "Lung window"}).status_code == 200
    item = client.post(f"/admin/cases/{case_id}/clinical-data-items", params={"type": "report", "title": "Report"}).json()["id"]
    assert client.patch(f"/admin/clinical-data-items/{item}", params={"title": "Report v2"}).status_code == 200
    assert client.post(f"/admin/clinical-data-items/{item}/tags", params={"label": "biopsy"}).status_code == 200
    assert client.delete(f"/admin/clinical-data-items/{item}/tags", params={"label": "biopsy"}).status_code == 204
    assert client.post("/admin/annotation-types", params={"name": f"qa_type_{uuid.uuid4().hex[:6]}"}, json={"type": "object"}).status_code in (200, 201)
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    flt = _card(client, sid, "filter", "F", x=300)
    edge = client.post(f"/admin/studies/{sid}/workflow/edges", json={"source_card_id": ds["id"], "source_handle": "output", "target_card_id": flt["id"], "target_handle": "input"}).json()
    assert client.delete(f"/admin/workflow-edges/{edge['id']}").status_code == 204
    tpl = client.post("/admin/pipeline-templates", json={"title": "t", "cards": [{"key": "a", "type": "note", "title": "a", "x": 0, "y": 0, "width": 1, "height": 1, "config": {}}], "edges": []}).json()
    assert client.delete(f"/admin/pipeline-templates/{tpl['id']}").status_code == 204
    assert client.put("/admin/usage/settings", json={"track_mouse": False}).status_code == 200
    assert client.put(f"/admin/usage/settings/users/{ANNOTATOR_SUBJECT}", json={"counted": False}).status_code == 200
    assert client.put("/admin/notifications/settings", json={"enabled": True}).status_code == 200
    assert client.put(f"/admin/notifications/preferences/{ANNOTATOR_SUBJECT}", json={"notify_new_job": False}).status_code == 200

    expected = {
        "series.update", "clinical_data_item.create", "clinical_data_item.update", "tag.add", "tag.delete",
        "annotation_type.create", "edge.create", "edge.delete", "template.create", "template.delete",
        "usage_settings.update", "usage_user_switch.update", "notification_settings.update", "notification_preferences.update",
    }
    missing = expected - _actions(db)
    assert not missing, sorted(missing)
