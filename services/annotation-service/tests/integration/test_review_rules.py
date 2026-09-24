"""Only handed-in work is reviewed, and a decision stands.

- F-09: a plain DRAFT (the annotator never pressed "Mark as annotated")
  can't be approved or rejected.
- F-07: an approved or rejected case can't be re-decided by a reviewer
  from a new version -- only a global admin overrides a decision.
- F-01: a reviewer's in-progress save records the handed-in version it
  reviews (review_of_id); deciding that draft is the normal review.
"""
from shared_models.models import StudyMembership

from .conftest import ALICE, make_study_with_series

REVIEWER = "00000000-0000-4000-8000-0000000000c3"
MASK = {"mask_volume_key": "annotation-masks/abc.gz", "labels": [], "objects": []}


def _setup(db):
    study, series, _ = make_study_with_series(db, "R", ALICE)
    db.add(StudyMembership(study_id=study, user_id=REVIEWER, role="reviewer"))
    db.commit()
    return study, series


def _save(client, study, series, status="draft", review_of=None):
    params = {"target_type": "series", "target_id": series, "type_name": "segmentation_volume", "status": status}
    if review_of:
        params["review_of"] = review_of
    return client.post(f"/annotations/studies/{study}", params=params, json=MASK)


def _decide(client, annotation_id, decision="approve"):
    return client.post(f"/annotations/{annotation_id}/review", params={"decision": decision})


def test_a_draft_that_was_never_handed_in_cannot_be_decided(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    draft = _save(client, study, series).json()["id"]
    client.as_user(REVIEWER)
    r = _decide(client, draft)
    assert r.status_code == 409 and "handed in" in r.json()["detail"]
    # nor through a reviewer draft on top of it
    assert _save(client, study, series, review_of=draft).status_code == 409


def test_the_normal_review_decides_the_reviewers_draft_of_the_handed_in_version(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    submitted = _save(client, study, series, status="submitted").json()["id"]
    client.as_user(REVIEWER)
    first = _save(client, study, series, review_of=submitted)  # the reviewer's "Save"
    assert first.status_code == 200 and first.json()["review_of_id"] == submitted
    second = _save(client, study, series, review_of=submitted).json()["id"]  # "Submit review" saves again
    assert _decide(client, second, "reject").json()["status"] == "rejected"


def test_a_decided_case_is_not_overturned_by_a_reviewer(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    submitted = _save(client, study, series, status="submitted").json()["id"]
    client.as_user(REVIEWER)
    assert _decide(client, submitted).status_code == 200
    # a new version on top of the approved one, then deciding that
    fresh = _save(client, study, series).json()["id"]
    assert _decide(client, fresh, "reject").status_code == 409
    assert _save(client, study, series, review_of=submitted).status_code == 409
    # a global admin may still override
    client.as_user(REVIEWER, roles=["admin"])
    assert _decide(client, submitted, "reject").status_code == 200


def test_only_the_latest_version_of_an_image_is_decided(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    old = _save(client, study, series, status="submitted").json()["id"]
    _save(client, study, series, status="submitted")
    client.as_user(REVIEWER)
    r = _decide(client, old)
    assert r.status_code == 409 and "newer version" in r.json()["detail"]


def test_review_drafts_are_for_reviewers(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    submitted = _save(client, study, series, status="submitted").json()["id"]
    assert _save(client, study, series, review_of=submitted).status_code == 403
