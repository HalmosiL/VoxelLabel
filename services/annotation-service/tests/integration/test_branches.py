"""Branches: independent version chains of one image's annotation.

A Duplicate card on the workflow board sends the same cases down two (or
more) lanes, each annotated on its own -- so two annotators can be
compared on the same image. Each lane saves on its own `branch`: its
versions, its "latest", its conflicts, its review, never another's. No
branch is the main chain, as before.
"""
from shared_models.models import StudyMembership

from .conftest import ALICE, make_study_with_series

BOB_TOO = "00000000-0000-4000-8000-0000000000d4"  # a second annotator in the same study
REVIEWER = "00000000-0000-4000-8000-0000000000c3"
MASK = {"mask_volume_key": "annotation-masks/abc.gz", "labels": [], "objects": []}


def _setup(db):
    study, series, _ = make_study_with_series(db, "BR", ALICE)
    db.add(StudyMembership(study_id=study, user_id=BOB_TOO, role="annotator"))
    db.add(StudyMembership(study_id=study, user_id=REVIEWER, role="reviewer"))
    db.commit()
    return study, series


def _save(client, study, series, branch=None, status="draft", base=None, review_of=None):
    params = {"target_type": "series", "target_id": series, "type_name": "segmentation_volume", "status": status}
    if branch is not None:
        params["branch"] = branch
    if base is not None:
        params["base_version_id"] = base
    if review_of is not None:
        params["review_of"] = review_of
    return client.post(f"/annotations/studies/{study}", params=params, json=MASK)


def test_each_branch_is_its_own_chain(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    a1 = _save(client, study, series, branch="dup:1:copy_0", base="none")
    assert a1.status_code == 200, a1.text
    # Bob starts from nothing on his own branch: Alice's save isn't "newer"
    client.as_user(BOB_TOO)
    b1 = _save(client, study, series, branch="dup:1:copy_1", base="none")
    assert b1.status_code == 200, b1.text
    # ... and the main chain is still empty too
    assert _save(client, study, series, base="none").status_code == 200
    # a save based on Alice's version is current on her branch only
    client.as_user(ALICE)
    assert _save(client, study, series, branch="dup:1:copy_0", base=a1.json()["id"]).status_code == 200
    assert _save(client, study, series, branch="dup:1:copy_1", base=a1.json()["id"]).status_code == 409


def test_a_branch_reads_only_its_own_versions(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    _save(client, study, series, branch="dup:1:copy_0")
    _save(client, study, series)
    client.as_user(BOB_TOO)
    _save(client, study, series, branch="dup:1:copy_1")
    mine = client.get(f"/annotations/series/{series}", params={"branch": "dup:1:copy_1"}).json()
    assert len(mine) == 1 and mine[0]["branch"] == "dup:1:copy_1"
    main = client.get(f"/annotations/series/{series}").json()
    assert len(main) == 1 and main[0]["branch"] is None  # no branch: the main chain, as before


def test_a_review_and_its_undo_stay_on_the_branch(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    handed_in = _save(client, study, series, branch="dup:1:copy_0", status="submitted").json()["id"]
    # another branch saving on the same image doesn't make Alice's work "not the latest"
    client.as_user(BOB_TOO)
    _save(client, study, series, branch="dup:1:copy_1")
    client.as_user(REVIEWER)
    draft = _save(client, study, series, branch="dup:1:copy_0", review_of=handed_in)
    assert draft.status_code == 200, draft.text
    # a review draft must be on the branch of the work it reviews
    assert _save(client, study, series, branch="dup:1:copy_1", review_of=handed_in).status_code == 404
    decided = client.post(f"/annotations/{draft.json()['id']}/review", params={"decision": "approve"})
    assert decided.status_code == 200, decided.text
    assert client.post(f"/annotations/{draft.json()['id']}/undo").status_code == 200


def test_a_branch_name_is_a_short_plain_key(client, db):
    study, series = _setup(db)
    client.as_user(ALICE)
    for bad in ("", "x" * 200, "a b", "../x", "dup;drop"):
        assert _save(client, study, series, branch=bad).status_code == 422, bad
