"""Compare: the copies of a Duplicate, set side by side on the same images.

A Compare card takes two or more inputs on different branches (typically
each copy's Annotation job), and on Run compares, for every case they
share, each input's latest handed-in segmentation of each image: Dice
overall and per label, the findings both / only one of them drew. Cases
where the inputs agree (every pair's Dice at least `agree_dice`) and the
ones where they don't are materialized as Datasets -- the disagreements
can go on to an adjudicating review.
"""
import gzip

import numpy as np

from .conftest import ANNOTATOR_SUBJECT, make_annotation
from .test_workflow_duplicate import OTHER_ANNOTATOR, _children, _lanes
from .test_workflow_jobs import _card, _edge

NODULE = {"labels": [{"id": 1, "name": "Nodule"}], "objects": [{"id": 1, "label_id": 1}, {"id": 2, "label_id": 1}]}


def _mask(*spans):
    """A 20-voxel mask: object 1 on each (start, stop) span given."""
    m = np.zeros(20, np.uint8)
    for start, stop in spans:
        m[start:stop] = 1
    return m


def _board(client, db, monkeypatch, masks):
    """Two copies' jobs and a Compare fed by both; `masks` maps a storage
    key to the mask the storage hands back for it."""
    from app.api.workflow import compare as compare_module

    monkeypatch.setattr(compare_module, "download_object", lambda key: gzip.compress(masks[key].tobytes()))
    sid, cases, series, dup, lanes, (job_a, job_b) = _lanes(client, db)
    cmp = _card(client, sid, "compare", "A vs B", {}, x=1200)
    _edge(client, sid, job_a["id"], cmp["id"])
    _edge(client, sid, job_b["id"], cmp["id"])
    branch = lambda job: client.get(f"/admin/workflow-cards/{job['id']}/surface-config").json()["branch"]  # noqa: E731
    return sid, cases, series, cmp, job_a, job_b, branch(job_a), branch(job_b)


def _save(db, sid, series_id, who, branch, key, status="submitted"):
    make_annotation(db, sid, series_id, who, status, branch=branch, payload={"mask_volume_key": key, **NODULE})


def test_the_copies_are_compared_on_the_cases_both_handed_in(client, db, monkeypatch):
    masks = {"a0": _mask((0, 4)), "b0": _mask((2, 6)), "a1": _mask((0, 4))}
    sid, cases, series, cmp, job_a, job_b, a, b = _board(client, db, monkeypatch, masks)
    _save(db, sid, series[0], ANNOTATOR_SUBJECT, a, "a0")
    _save(db, sid, series[0], OTHER_ANNOTATOR, b, "b0")
    _save(db, sid, series[1], ANNOTATOR_SUBJECT, a, "a1")  # B never handed case 1 in
    r = client.post(f"/admin/workflow-cards/{cmp['id']}/run")
    assert r.status_code == 200, r.text
    results = client.get(f"/admin/studies/{sid}/workflow").json()
    card = next(c for c in results["cards"] if c["id"] == cmp["id"])
    res = card["config"]["results"]
    assert [i["card_id"] for i in res["inputs"]] == [job_a["id"], job_b["id"]]
    assert [i["job_id"] for i in res["inputs"]] == [job_a["id"], job_b["id"]]
    (pair,) = res["pairs"]
    assert (pair["a"], pair["b"], pair["images"], pair["mean_dice"]) == (0, 1, 1, 0.5)
    (image,) = res["images"]
    assert image["case_id"] == cases[0]["id"] and image["pairs"][0]["by_label"] == {"Nodule": 0.5}
    assert image["pairs"][0]["objects"] == {"both": 1, "only_a": 0, "only_b": 0}
    (skipped,) = res["skipped"]
    assert skipped["case_id"] == cases[1]["id"] and "A vs B" not in skipped["reason"] and "Annotate 1" in skipped["reason"]
    # below agree_dice (0.7 by default): the case is a disagreement
    kids = _children(client, sid, cmp["id"])
    assert kids["disagree"]["config"]["case_ids"] == [cases[0]["id"]] and kids["agree"]["config"]["case_ids"] == []


def test_a_threshold_decides_what_agrees(client, db, monkeypatch):
    masks = {"a0": _mask((0, 4)), "b0": _mask((2, 6))}
    sid, cases, series, cmp, *_rest, a, b = _board(client, db, monkeypatch, masks)
    _save(db, sid, series[0], ANNOTATOR_SUBJECT, a, "a0")
    _save(db, sid, series[0], OTHER_ANNOTATOR, b, "b0")
    assert client.patch(f"/admin/workflow-cards/{cmp['id']}", json={"config": {"agree_dice": 0.4}}).status_code == 200
    client.post(f"/admin/workflow-cards/{cmp['id']}/run")
    assert _children(client, sid, cmp["id"])["agree"]["config"]["case_ids"] == [cases[0]["id"]]
    for bad in (-0.1, 1.5, "high"):
        assert client.patch(f"/admin/workflow-cards/{cmp['id']}", json={"config": {"agree_dice": bad}}).status_code == 422, bad


def test_a_draft_on_top_compares_the_last_hand_in(client, db, monkeypatch):
    masks = {"a0": _mask((0, 4)), "a0-draft": _mask((10, 20)), "b0": _mask((0, 4))}
    sid, cases, series, cmp, *_rest, a, b = _board(client, db, monkeypatch, masks)
    _save(db, sid, series[0], ANNOTATOR_SUBJECT, a, "a0")
    _save(db, sid, series[0], ANNOTATOR_SUBJECT, a, "a0-draft", status="draft")  # reworking, not handed in again
    _save(db, sid, series[0], OTHER_ANNOTATOR, b, "b0")
    client.post(f"/admin/workflow-cards/{cmp['id']}/run")
    card = next(c for c in client.get(f"/admin/studies/{sid}/workflow").json()["cards"] if c["id"] == cmp["id"])
    assert card["config"]["results"]["images"][0]["pairs"][0]["dice"] == 1.0


def test_compare_needs_two_different_branches(client, db, monkeypatch):
    sid, cases, series, cmp, job_a, job_b, a, b = _board(client, db, monkeypatch, {})
    only = _card(client, sid, "compare", "Lonely", {}, x=1500)
    _edge(client, sid, job_a["id"], only["id"])
    r = client.post(f"/admin/workflow-cards/{only['id']}/run")
    assert r.status_code == 422 and "two" in r.json()["detail"]


def test_compare_is_not_rerun_by_a_ripple(client, db, monkeypatch):
    """Downloading and comparing every mask is heavy: like a Criterion, a
    Compare runs when asked, not on every upstream Run."""
    sid, cases, series, cmp, job_a, *_ = _board(client, db, monkeypatch, {})
    assert client.post(f"/admin/workflow-cards/{job_a['id']}/run").status_code == 200
    card = next(c for c in client.get(f"/admin/studies/{sid}/workflow").json()["cards"] if c["id"] == cmp["id"])
    assert card["last_run_at"] is None


def test_what_comes_out_of_a_compare_is_back_on_the_main_chain(client, db, monkeypatch):
    """The copies end at the Compare: its "disagree" cases go on to an
    adjudicator's job for the final, agreed segmentation -- on the main
    chain, not on either copy (and not refused as mixing the two)."""
    masks = {"a0": _mask((0, 4)), "b0": _mask((2, 6))}
    sid, cases, series, cmp, *_rest, a, b = _board(client, db, monkeypatch, masks)
    _save(db, sid, series[0], ANNOTATOR_SUBJECT, a, "a0")
    _save(db, sid, series[0], OTHER_ANNOTATOR, b, "b0")
    client.post(f"/admin/workflow-cards/{cmp['id']}/run")
    disagree = _children(client, sid, cmp["id"])["disagree"]
    final = _card(client, sid, "annotation", "Adjudicate", {"assigned_user_id": ANNOTATOR_SUBJECT}, x=1500)
    _edge(client, sid, disagree["id"], final["id"])
    r = client.post(f"/admin/workflow-cards/{final['id']}/run")
    assert r.status_code == 200, r.text
    assert client.get(f"/admin/workflow-cards/{final['id']}/surface-config").json()["branch"] is None


def test_a_finding_only_one_reader_drew_is_a_disagreement_whatever_the_dice(client, db, monkeypatch):
    """A small nodule one reader missed barely moves the Dice -- but a
    missed finding is exactly the disagreement that matters."""
    big_and_small = _mask((0, 18))
    big_and_small[19] = 2  # a one-voxel second finding
    masks = {"a0": big_and_small, "b0": _mask((0, 18))}
    sid, cases, series, cmp, *_rest, a, b = _board(client, db, monkeypatch, masks)
    _save(db, sid, series[0], ANNOTATOR_SUBJECT, a, "a0")
    _save(db, sid, series[0], OTHER_ANNOTATOR, b, "b0")
    client.post(f"/admin/workflow-cards/{cmp['id']}/run")
    card = next(c for c in client.get(f"/admin/studies/{sid}/workflow").json()["cards"] if c["id"] == cmp["id"])
    image = card["config"]["results"]["images"][0]
    assert image["min_dice"] >= 0.9 and image["pairs"][0]["objects"]["only_a"] == 1
    assert _children(client, sid, cmp["id"])["disagree"]["config"]["case_ids"] == [cases[0]["id"]]
