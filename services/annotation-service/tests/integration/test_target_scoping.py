"""A role in one study never reaches another study's images (A-02, A-03)
and an annotation can't point at arbitrary bucket objects (A-04)."""
from .conftest import ALICE, BOB, make_study_with_series

MASK = {"mask_volume_key": "annotation-masks/abc.gz", "labels": [], "objects": []}


def _create(client, study_id, target_id, payload=MASK, target_type="series"):
    return client.post(
        f"/annotations/studies/{study_id}",
        params={"target_type": target_type, "target_id": target_id, "type_name": "segmentation_volume"},
        json=payload,
    )


def test_an_annotator_cannot_write_onto_another_studys_series(client, db):
    study_a, series_a, _ = make_study_with_series(db, "A", ALICE)
    _, series_b, instance_b = make_study_with_series(db, "B", BOB)
    client.as_user(ALICE)
    assert _create(client, study_a, series_a).status_code == 200
    # the role check passes on study A, but the target belongs to B
    assert _create(client, study_a, series_b).status_code == 403
    assert _create(client, study_a, instance_b, target_type="instance").status_code == 403


def test_unknown_targets_and_types_are_refused(client, db):
    study_a, _, _ = make_study_with_series(db, "A", ALICE)
    client.as_user(ALICE)
    assert _create(client, study_a, "00000000-0000-4000-8000-00000000dead").status_code == 404
    assert _create(client, study_a, "00000000-0000-4000-8000-00000000dead", target_type="case").status_code == 422
    assert client.post("/annotations/studies/not-a-uuid", params={"target_type": "series", "target_id": "00000000-0000-4000-8000-00000000dead", "type_name": "segmentation_volume"}, json=MASK).status_code == 422


def test_reads_follow_the_targets_own_study_not_the_first_annotation(client, db):
    study_a, _, _ = make_study_with_series(db, "A", ALICE)
    study_b, series_b, _ = make_study_with_series(db, "B", BOB)
    client.as_user(BOB)
    assert _create(client, study_b, series_b).status_code == 200
    # Alice has no role in B: she can't read B's series
    client.as_user(ALICE)
    assert client.get(f"/annotations/series/{series_b}").status_code == 403
    # an annotation row filed under another study on B's series (legacy /
    # injected data) is never returned with B's own
    from shared_models.models import Annotation, AnnotationType

    atype = db.query(AnnotationType).first()
    db.add(Annotation(target_type="series", target_id=series_b, study_id=study_a, annotator_id=ALICE, type_id=atype.id, payload={"x": 1}))
    db.commit()
    client.as_user(BOB)
    rows = client.get(f"/annotations/series/{series_b}").json()
    assert len(rows) == 1 and rows[0]["payload"]["mask_volume_key"] == "annotation-masks/abc.gz"


def test_storage_keys_in_a_payload_must_be_the_viewers_own_masks(client, db):
    study_a, series_a, _ = make_study_with_series(db, "A", ALICE)
    client.as_user(ALICE)
    for bad in ("1.2.3/4.5/6.dcm", "annotation-masks/../1.2.3/x.dcm", "thumbnails/x.png", 12):
        r = _create(client, study_a, series_a, {**MASK, "mask_volume_key": bad})
        assert r.status_code == 422, bad
    assert _create(client, study_a, series_a, {"mask_storage_key": "clinical-data/x.pdf"}).status_code == 422


def test_a_save_based_on_an_old_version_is_refused_not_buried(client, db):
    """J-11: two tabs/users saving the same series -- the second, still
    based on what it loaded, gets 409 instead of silently winning."""
    study_a, series_a, _ = make_study_with_series(db, "A", ALICE)
    client.as_user(ALICE)

    def save(base, key):
        return client.post(
            f"/annotations/studies/{study_a}",
            params={"target_type": "series", "target_id": series_a, "type_name": "segmentation_volume", "base_version_id": base},
            json={**MASK, "mask_volume_key": f"annotation-masks/{key}.gz"},
        )

    first = save("none", "one")
    assert first.status_code == 200
    v1 = first.json()["id"]
    # a second "fresh" save (from a tab that also saw nothing) is refused
    assert save("none", "stale").status_code == 409
    second = save(v1, "two")
    assert second.status_code == 200
    # the tab still on v1 can't bury v2
    assert save(v1, "three").status_code == 409
    rows = client.get(f"/annotations/series/{series_a}").json()
    assert [r["payload"]["mask_volume_key"] for r in rows] == ["annotation-masks/one.gz", "annotation-masks/two.gz"]
    assert rows[-1]["created_at"] > rows[0]["created_at"]
    from shared_models.models import Annotation

    assert str(db.get(Annotation, second.json()["id"]).parent_version_id) == v1
    # no base given: legacy callers still just append
    assert _create(client, study_a, series_a).status_code == 200


def test_a_data_manager_reads_the_studys_annotations(client, db):
    """A-08: data_manager, a full study-management role everywhere else,
    got 403 on reading annotations."""
    study_a, series_a, _ = make_study_with_series(db, "A", ALICE)
    client.as_user(ALICE)
    assert _create(client, study_a, series_a).status_code == 200
    from shared_models.models import StudyMembership

    db.add(StudyMembership(study_id=study_a, user_id=BOB, role="data_manager"))
    db.commit()
    client.as_user(BOB)
    assert client.get(f"/annotations/studies/{study_a}").status_code == 200
    assert client.get(f"/annotations/series/{series_a}").status_code == 200
