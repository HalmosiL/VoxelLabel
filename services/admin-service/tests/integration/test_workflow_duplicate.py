"""Duplicate: the same cases down several lanes, each annotated apart.

A Duplicate card materializes one Dataset per copy, every one holding all
of its input's cases. Each copy is its own branch of the annotations (see
annotation-service's Annotation.branch): a job downstream of a copy reads
and counts only that copy's work, so two annotators can do the same
images independently -- and a Compare card can set them side by side.
"""
from .conftest import ANNOTATOR_SUBJECT, REVIEWER_SUBJECT, add_member, make_annotation, make_case, make_series, make_study
from .test_workflow_jobs import _card, _edge, _job

OTHER_ANNOTATOR = "00000000-0000-4000-8000-00000000e0e2"


def _children(client, sid, parent_id):
    """The Datasets `parent` made, by handle ({"copy_0": card, ...})."""
    board = client.get(f"/admin/studies/{sid}/workflow").json()
    by_id = {c["id"]: c for c in board["cards"]}
    parent = by_id[parent_id]
    return {handle: by_id[cid] for handle, cid in sorted((parent.get("materialized_card_ids") or {}).items())}


def _lanes(client, db, copies=2, n_cases=2):
    """Dataset -> Duplicate -> one Annotation job per copy, run."""
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    add_member(client, sid, OTHER_ANNOTATOR, "annotator")
    add_member(client, sid, REVIEWER_SUBJECT, "reviewer")
    cases = [make_case(client, sid, external=f"d{i}") for i in range(n_cases)]
    series = [make_series(db, c["id"]) for c in cases]
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    dup = _card(client, sid, "duplicate", "Twice", {"copies": copies}, x=300)
    _edge(client, sid, ds["id"], dup["id"])
    assert client.post(f"/admin/workflow-cards/{dup['id']}/run").status_code == 200
    lanes = list(_children(client, sid, dup["id"]).values())
    jobs = []
    for i, lane in enumerate(lanes[:2]):
        who = ANNOTATOR_SUBJECT if i == 0 else OTHER_ANNOTATOR
        job = _card(client, sid, "annotation", f"Annotate {i}", {"assigned_user_id": who}, x=900)
        _edge(client, sid, lane["id"], job["id"])
        assert client.post(f"/admin/workflow-cards/{job['id']}/run").status_code == 200
        jobs.append(job)
    return sid, cases, series, dup, lanes, jobs


def test_every_copy_holds_every_case(client, db):
    sid, cases, _, dup, lanes, _ = _lanes(client, db, copies=3)
    assert list(_children(client, sid, dup["id"])) == ["copy_0", "copy_1", "copy_2"]
    assert [lane["title"] for lane in lanes] == ["Copy A", "Copy B", "Copy C"]
    for lane in lanes:
        assert sorted(lane["config"]["case_ids"]) == sorted(c["id"] for c in cases)
    board = client.get(f"/admin/studies/{sid}/workflow").json()
    assert next(c for c in board["cards"] if c["id"] == dup["id"])["output_count"] == {"copy_0": 2, "copy_1": 2, "copy_2": 2}


def test_copies_are_two_to_four(client, db):
    sid = make_study(client)
    for bad in (1, 5, "two"):
        r = client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": "duplicate", "title": "x", "position_x": 0, "position_y": 0, "config": {"copies": bad}})
        assert r.status_code == 422, bad


def test_each_copys_job_works_on_its_own_branch(client, db):
    sid, cases, series, dup, lanes, (job_a, job_b) = _lanes(client, db)
    a = client.get(f"/admin/workflow-cards/{job_a['id']}/surface-config").json()["branch"]
    b = client.get(f"/admin/workflow-cards/{job_b['id']}/surface-config").json()["branch"]
    assert a and b and a != b
    # the annotator of copy A hands in case 0 on A's branch: A's job counts it, B's doesn't
    make_annotation(db, sid, series[0], ANNOTATOR_SUBJECT, "submitted", branch=a)
    states_a = {c["id"]: c["status"] for c in _job(client, ANNOTATOR_SUBJECT, job_a["id"])["cases"]}
    states_b = {c["id"]: c["status"] for c in _job(client, OTHER_ANNOTATOR, job_b["id"])["cases"]}
    assert states_a[cases[0]["id"]] == "done" and states_b[cases[0]["id"]] == "pending"
    assert _job(client, OTHER_ANNOTATOR, job_b["id"])["status"] == "todo"
    # work on the main chain counts for neither copy
    make_annotation(db, sid, series[1], ANNOTATOR_SUBJECT, "submitted")
    assert {c["id"]: c["status"] for c in _job(client, ANNOTATOR_SUBJECT, job_a["id"])["cases"]}[cases[1]["id"]] == "pending"


def test_a_card_off_the_duplicate_is_on_the_main_chain(client, db):
    sid = make_study(client)
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    job = _card(client, sid, "annotation", "Plain", {}, x=300)
    _edge(client, sid, ds["id"], job["id"])
    assert client.get(f"/admin/workflow-cards/{job['id']}/surface-config").json()["branch"] is None


def test_a_review_in_a_copy_decides_that_copys_work(client, db):
    sid, cases, series, dup, lanes, (job_a, _) = _lanes(client, db)
    rev = _card(client, sid, "review", "Review A", {"assigned_user_id": REVIEWER_SUBJECT}, x=1200)
    _edge(client, sid, job_a["id"], rev["id"])
    branch = client.get(f"/admin/workflow-cards/{job_a['id']}/surface-config").json()["branch"]
    assert client.get(f"/admin/workflow-cards/{rev['id']}/surface-config").json()["branch"] == branch
    make_annotation(db, sid, series[0], ANNOTATOR_SUBJECT, "submitted", branch=branch)
    make_annotation(db, sid, series[1], OTHER_ANNOTATOR, "submitted", branch="d:other:copy_1")
    assert client.post(f"/admin/workflow-cards/{rev['id']}/run").status_code == 200
    queued = {c["id"] for c in _job(client, REVIEWER_SUBJECT, rev["id"])["cases"]}
    assert queued == {cases[0]["id"]}  # the other copy's hand-in isn't this review's
    make_annotation(db, sid, series[0], REVIEWER_SUBJECT, "approved", branch=branch)
    assert client.post(f"/admin/workflow-cards/{rev['id']}/run").status_code == 200
    approved = _children(client, sid, rev["id"])["approved"]
    assert approved["config"]["case_ids"] == [cases[0]["id"]]


def test_a_split_inside_a_copy_stays_on_its_branch(client, db):
    sid, cases, series, dup, lanes, (job_a, _) = _lanes(client, db)
    split = _card(client, sid, "split", "Halves", {"parts": [{"name": "x", "ratio": 0.5}, {"name": "y", "ratio": 0.5}], "seed": "1"}, x=600)
    _edge(client, sid, lanes[0]["id"], split["id"])
    assert client.post(f"/admin/workflow-cards/{split['id']}/run").status_code == 200
    part = _children(client, sid, split["id"])["part_0"]
    inner = _card(client, sid, "annotation", "Inner", {}, x=900)
    _edge(client, sid, part["id"], inner["id"])
    lane_branch = client.get(f"/admin/workflow-cards/{job_a['id']}/surface-config").json()["branch"]
    assert client.get(f"/admin/workflow-cards/{inner['id']}/surface-config").json()["branch"] == lane_branch


def test_one_job_cannot_take_two_copies(client, db):
    sid, cases, series, dup, lanes, _ = _lanes(client, db)
    both = _card(client, sid, "annotation", "Both", {}, x=1200)
    _edge(client, sid, lanes[0]["id"], both["id"])
    _edge(client, sid, lanes[1]["id"], both["id"])
    r = client.post(f"/admin/workflow-cards/{both['id']}/run")
    assert r.status_code == 422 and "copies" in r.json()["detail"]
