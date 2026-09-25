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


def test_a_long_review_comment_travels_in_the_body(client, db):
    """F-08: the comment went as a URL query parameter and ~11 000
    Hungarian characters made the URL too long -- a 500 after the
    reviewer's draft was already saved."""
    study, series = _setup(db)
    client.as_user(ALICE)
    submitted = _save(client, study, series, status="submitted").json()["id"]
    client.as_user(REVIEWER)
    comment = "ő" * 12000
    r = client.post(f"/annotations/{submitted}/review", params={"decision": "reject"}, json={"comment": comment})
    assert r.status_code == 200, r.text
    from shared_models.models import AnnotationReview
    assert db.query(AnnotationReview).one().comment == comment
    # an absurd comment is refused with a reason, not a crash
    client.as_user(ALICE)
    again = _save(client, study, series, status="submitted").json()["id"]
    client.as_user(REVIEWER)
    r = client.post(f"/annotations/{again}/review", params={"decision": "approve"}, json={"comment": "x" * 200_001})
    assert r.status_code == 422 and "too long" in r.json()["detail"]


def test_concurrent_decisions_record_one_review(client, db):
    """J-12: six reviews fired at once gave four 200s and four review rows.
    Three rounds, since a race only shows up some of the time."""
    import threading

    from shared_models.models import AnnotationReview

    study, series = _setup(db)
    for _ in range(3):
        client.as_user(ALICE)
        submitted = _save(client, study, series, status="submitted").json()["id"]
        client.as_user(REVIEWER)
        codes, barrier = [], threading.Barrier(8)

        def decide(annotation_id=submitted):
            barrier.wait()
            codes.append(_decide(client, annotation_id).status_code)

        threads = [threading.Thread(target=decide) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert sorted(codes) == [200] + [409] * 7, codes
    db.expire_all()
    assert db.query(AnnotationReview).count() == 3


def test_nobody_reviews_their_own_work(client, db):
    """F-10: a member holding both roles approved their own submission."""
    study, series = _setup(db)
    db.add(StudyMembership(study_id=study, user_id=ALICE, role="reviewer"))
    db.commit()
    client.as_user(ALICE)
    submitted = _save(client, study, series, status="submitted").json()["id"]
    r = _decide(client, submitted)
    assert r.status_code == 403 and "your own work" in r.json()["detail"]
    draft = _save(client, study, series, review_of=submitted)
    assert draft.status_code == 403
    client.as_user(REVIEWER)
    assert _decide(client, submitted).status_code == 200
