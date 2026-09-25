"""Restoring a study version while a job is in progress: the board goes
back, and undoing the restore brings the job back as it was -- the
cases already queued on it keep the moment they entered the queue."""
import uuid

from shared_models.models import CaseStageEvent

from .conftest import ANNOTATOR_SUBJECT, add_member, make_case, make_study
from .test_workflow_jobs import _card, _edge


def _queued(db, card_id):
    db.expire_all()
    return {(str(e.case_id), e.occurred_at) for e in db.query(CaseStageEvent).filter_by(card_id=uuid.UUID(card_id)).all()}


def test_undoing_a_restore_brings_back_a_job_in_progress(client, db):
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    make_case(client, sid, external="p0")
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    before_job = client.post(f"/admin/studies/{sid}/versions", json={"label": "before the job"}).json()["id"]
    ann = _card(client, sid, "annotation", "Annotate", {"assigned_user_id": ANNOTATOR_SUBJECT, "labels": ["Nodule"]}, x=300)
    _edge(client, sid, ds["id"], ann["id"])
    assert client.post(f"/admin/workflow-cards/{ann['id']}/run").status_code == 200
    queued = _queued(db, ann["id"])
    assert len(queued) == 1

    result = client.post(f"/admin/studies/{sid}/versions/{before_job}/restore").json()
    assert all(c["id"] != ann["id"] for c in client.get(f"/admin/studies/{sid}/workflow").json()["cards"])

    safety = next(v["id"] for v in client.get(f"/admin/studies/{sid}/versions").json() if v["number"] == result["safety_version"])
    assert client.post(f"/admin/studies/{sid}/versions/{safety}/restore").status_code == 200
    assert any(c["id"] == ann["id"] for c in client.get(f"/admin/studies/{sid}/workflow").json()["cards"])
    assert {c["id"] for c in client.get(f"/admin/workflow-cards/{ann['id']}/cases").json()} == {q[0] for q in queued}
    assert _queued(db, ann["id"]) == queued  # the queue-start times survived the round trip


def test_undoing_a_card_delete_keeps_its_queue_times(client, db):
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    make_case(client, sid, external="p0")
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    ann = _card(client, sid, "annotation", "Annotate", {"assigned_user_id": ANNOTATOR_SUBJECT, "labels": ["Nodule"]}, x=300)
    _edge(client, sid, ds["id"], ann["id"])
    assert client.post(f"/admin/workflow-cards/{ann['id']}/run").status_code == 200
    queued = _queued(db, ann["id"])

    assert client.delete(f"/admin/workflow-cards/{ann['id']}").status_code == 204
    back = {k: ann[k] for k in ("id", "type", "title", "position_x", "position_y", "config", "last_run_at", "output_case_ids")}
    assert client.post(f"/admin/studies/{sid}/workflow/cards", json=back).status_code == 201  # the board's Undo
    assert _queued(db, ann["id"]) == queued
