"""The study analytics endpoint through the real API and database: it
joins the board, annotation versions, review decisions and viewer usage
into one payload, and only the study's managers may read it."""
import uuid
from datetime import datetime, timedelta, timezone

from shared_models.models import Annotation, UsageEvent

from .conftest import ANNOTATOR_SUBJECT, DM_SUBJECT, REVIEWER_SUBJECT, make_annotation, make_review
from .test_pipeline_health_api import _pipeline


def test_study_analytics_joins_the_workflow_the_annotations_and_the_viewer_work(client, db):
    sid, cases, series, ann, rev = _pipeline(client, db, n_cases=2)
    submitted = make_annotation(db, sid, series[0], ANNOTATOR_SUBJECT, "submitted")
    db.query(Annotation).filter_by(id=submitted).update({"payload": {"mask_volume_key": "k", "labels": [{"id": 1, "name": "Nodule"}], "objects": [{"id": 1, "label_id": 1}, {"id": 2, "label_id": 1}]}})
    db.commit()
    make_review(db, submitted, REVIEWER_SUBJECT, "approve")
    now = datetime.now(timezone.utc)
    for kind, at_s, duration in (("page_view", -120, None), ("page_leave", -60, 60_000)):
        db.add(UsageEvent(id=uuid.uuid4(), user_id=ANNOTATOR_SUBJECT, session_id="s", app="viewer", event_type=kind, route="/viewer/:id", detail={"job_id": ann["id"], "case_id": cases[0]["id"]}, duration_ms=duration, occurred_at=now + timedelta(seconds=at_s)))
    db.commit()

    client.as_admin()
    body = client.get(f"/admin/studies/{sid}/analytics").json()
    assert body["headline"]["cases"] == 2 and body["headline"]["states"]["approved"] == 1 and body["headline"]["states"]["not_started"] == 1
    assert body["headline"]["first_pass_rate"] == 1.0 and body["headline"]["hands_on_total_ms"] == 60_000
    approved = next(r for r in body["cases"] if r["state"] == "approved")
    assert approved["labels"] == {"Nodule": 2} and approved["annotators"] == ["dr-test"] and approved["reviewers"] == ["dr-review"]
    assert approved["annotate_ms"] == 60_000 and approved["approved_at"] is not None
    assert body["cards"][ann["id"]]["entered"] == 2 and body["cards"][ann["id"]]["assignee"] == "dr-test"
    assert body["labels"][0]["label"] == "Nodule" and body["labels"][0]["objects"] == 2
    assert {p["username"] for p in body["people"]} >= {"dr-test", "dr-review"}
    assert body["weekly"] and body["weekly"][-1]["approved"] == 1

    # a data manager of the study may read it; an annotator on it may not
    client.as_user(DM_SUBJECT, ["user"])
    assert client.get(f"/admin/studies/{sid}/analytics").status_code == 200
    client.as_user(ANNOTATOR_SUBJECT, ["user"])
    assert client.get(f"/admin/studies/{sid}/analytics").status_code == 403
    client.as_admin()
    assert client.get(f"/admin/studies/{uuid.uuid4()}/analytics").status_code == 404
