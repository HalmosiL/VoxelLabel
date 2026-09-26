"""A hand-in or a review decision can be taken back for a short while.

The viewer offers "Undo" right after "Mark as annotated" and after
"Submit review". Only the person who did it, only while nothing newer
happened on the image, and only within UNDO_WINDOW.
"""
from datetime import datetime, timedelta, timezone

from app.api import routes
from shared_models.models import Annotation, AnnotationReview, StudyMembership

from .conftest import ALICE, make_study_with_series

REVIEWER = "00000000-0000-4000-8000-0000000000c3"
BOB = "00000000-0000-4000-8000-0000000000b2"
MASK = {"mask_volume_key": "annotation-masks/abc.gz", "labels": [], "objects": []}


def _setup(db):
    study, series, _ = make_study_with_series(db, "U", ALICE)
    db.add(StudyMembership(study_id=study, user_id=REVIEWER, role="reviewer"))
    db.add(StudyMembership(study_id=study, user_id=BOB, role="annotator"))
    db.commit()
    return study, series


def _save(client, study, series, status="draft", review_of=None):
    params = {"target_type": "series", "target_id": series, "type_name": "segmentation_volume", "status": status}
    if review_of:
        params["review_of"] = review_of
    return client.post(f"/annotations/studies/{study}", params=params, json=MASK)


def _undo(client, annotation_id):
    return client.post(f"/annotations/{annotation_id}/undo")


def test_the_annotator_takes_back_a_hand_in(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    handed_in = _save(client, study, series, status="submitted").json()["id"]
    r = _undo(client, handed_in)
    assert r.status_code == 200 and r.json()["status"] == "draft"
    # and can hand it in again later: a new version on top of the draft
    assert _save(client, study, series, status="submitted").status_code == 200


def test_only_the_author_and_only_the_latest_version(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    handed_in = _save(client, study, series, status="submitted").json()["id"]
    client.as_user(BOB)
    assert _undo(client, handed_in).status_code == 403
    client.as_user(REVIEWER)
    _save(client, study, series, review_of=handed_in)  # the reviewer started on it
    client.as_user(ALICE)
    r = _undo(client, handed_in)
    assert r.status_code == 409 and "already" in r.json()["detail"]


def test_a_plain_draft_has_nothing_to_undo(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    draft = _save(client, study, series).json()["id"]
    assert _undo(client, draft).status_code == 409


def test_the_window_closes(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    handed_in = _save(client, study, series, status="submitted").json()["id"]
    row = db.get(Annotation, handed_in)
    row.created_at = datetime.now(timezone.utc) - routes.UNDO_WINDOW - timedelta(seconds=5)
    db.commit()
    r = _undo(client, handed_in)
    assert r.status_code == 409 and "too late" in r.json()["detail"]


def test_the_reviewer_takes_back_a_decision(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    handed_in = _save(client, study, series, status="submitted").json()["id"]
    client.as_user(REVIEWER)
    review_draft = _save(client, study, series, review_of=handed_in).json()["id"]
    assert client.post(f"/annotations/{review_draft}/review", params={"decision": "reject"}).status_code == 200
    r = _undo(client, review_draft)
    assert r.status_code == 200 and r.json()["status"] == "draft"
    db.expire_all()
    assert db.query(AnnotationReview).filter_by(annotation_id=review_draft).count() == 0
    # the case is awaiting a decision again, and can be decided anew
    assert client.post(f"/annotations/{review_draft}/review", params={"decision": "approve"}).json()["status"] == "approved"


def test_a_decision_on_the_handed_in_version_itself_reverts_to_submitted(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    handed_in = _save(client, study, series, status="submitted").json()["id"]
    client.as_user(REVIEWER)
    client.post(f"/annotations/{handed_in}/review", params={"decision": "approve"})
    assert _undo(client, handed_in).json()["status"] == "submitted"


def test_someone_elses_decision_or_one_with_newer_work_stays(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    handed_in = _save(client, study, series, status="submitted").json()["id"]
    client.as_user(REVIEWER)
    client.post(f"/annotations/{handed_in}/review", params={"decision": "reject"})
    client.as_user(ALICE)
    assert _undo(client, handed_in).status_code == 403  # the annotator can't undo the reviewer's rejection
    _save(client, study, series)  # ... and has started the rework
    client.as_user(REVIEWER)
    r = _undo(client, handed_in)
    assert r.status_code == 409 and "newer" in r.json()["detail"]
