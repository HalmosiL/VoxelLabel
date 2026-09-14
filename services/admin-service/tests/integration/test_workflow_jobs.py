"""The workflow board and the jobs it produces: cards, edges, Run,
My Jobs, and the computed job status following the cases' real
annotation state."""
from .conftest import ANNOTATOR_SUBJECT, DM_SUBJECT, REVIEWER_SUBJECT, add_member, make_annotation, make_case, make_series, make_study


def _card(client, sid, type_, title, config=None, x=0):
    r = client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": type_, "title": title, "position_x": x, "position_y": 0, "config": config or {}})
    assert r.status_code == 201, r.text
    return r.json()


def _edge(client, sid, src, dst, source_handle="output", target_handle="input"):
    r = client.post(f"/admin/studies/{sid}/workflow/edges", json={"source_card_id": src, "source_handle": source_handle, "target_card_id": dst, "target_handle": target_handle})
    assert r.status_code == 201, r.text
    return r.json()


def _pipeline(client, db, n_cases=2):
    """Study with a member annotator + reviewer, n cases each with a
    series, an all-cases Dataset -> Annotation -> Review chain, run."""
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    add_member(client, sid, REVIEWER_SUBJECT, "reviewer")
    add_member(client, sid, DM_SUBJECT, "data_manager")
    cases = [make_case(client, sid, external=f"p{i}") for i in range(n_cases)]
    series = [make_series(db, c["id"]) for c in cases]
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    ann = _card(client, sid, "annotation", "Annotate", {"assigned_user_id": ANNOTATOR_SUBJECT, "labels": ["Nodule"]}, x=300)
    rev = _card(client, sid, "review", "Review", {"assigned_user_id": REVIEWER_SUBJECT}, x=600)
    _edge(client, sid, ds["id"], ann["id"])
    _edge(client, sid, ann["id"], rev["id"])
    assert client.post(f"/admin/workflow-cards/{ann['id']}/run").status_code == 200
    assert client.post(f"/admin/workflow-cards/{rev['id']}/run").status_code == 200
    return sid, cases, series, ann, rev


def _job(client, subject, card_id):
    client.as_user(subject)
    jobs = client.get("/admin/my-jobs").json()
    return next(j for j in jobs if j["card_id"] == card_id)


def test_run_materialises_the_annotation_jobs_cases(client, db):
    sid, cases, _, ann, _ = _pipeline(client, db)
    board = client.get(f"/admin/studies/{sid}/workflow").json()
    card = next(c for c in board["cards"] if c["id"] == ann["id"])
    assert set(card["output_case_ids"]) == {c["id"] for c in cases}
    assert card["config"]["status"] == "todo"


def test_my_jobs_lists_only_the_assignees_jobs(client, db):
    _, _, _, ann, rev = _pipeline(client, db)
    client.as_user(ANNOTATOR_SUBJECT)
    mine = {j["card_id"] for j in client.get("/admin/my-jobs").json()}
    assert ann["id"] in mine and rev["id"] not in mine
    client.as_user(DM_SUBJECT)
    assert client.get("/admin/my-jobs").json() == []


def test_job_status_follows_the_cases(client, db):
    sid, cases, series, ann, rev = _pipeline(client, db)
    assert _job(client, ANNOTATOR_SUBJECT, ann["id"])["status"] == "todo"
    assert _job(client, REVIEWER_SUBJECT, rev["id"])["status"] == "todo"  # nothing submitted yet

    make_annotation(db, sid, series[0], ANNOTATOR_SUBJECT, "draft")
    assert _job(client, ANNOTATOR_SUBJECT, ann["id"])["status"] == "in_progress"

    make_annotation(db, sid, series[0], ANNOTATOR_SUBJECT, "submitted")
    job = _job(client, ANNOTATOR_SUBJECT, ann["id"])
    assert job["status"] == "in_progress"
    states = {c["id"]: c["status"] for c in job["cases"]}
    assert states[cases[0]["id"]] == "done" and states[cases[1]["id"]] == "pending"  # per-case: done | rejected | pending
    # the review job now has something waiting
    assert _job(client, REVIEWER_SUBJECT, rev["id"])["status"] == "in_progress"

    make_annotation(db, sid, series[1], ANNOTATOR_SUBJECT, "submitted")
    assert _job(client, ANNOTATOR_SUBJECT, ann["id"])["status"] == "done"

    # a rejection reopens the annotation job; deciding everything closes the review job
    make_annotation(db, sid, series[0], REVIEWER_SUBJECT, "rejected")
    assert _job(client, ANNOTATOR_SUBJECT, ann["id"])["status"] == "in_progress"
    make_annotation(db, sid, series[1], REVIEWER_SUBJECT, "approved")
    assert _job(client, REVIEWER_SUBJECT, rev["id"])["status"] == "done"


def test_status_cannot_be_set_by_hand(client, db):
    sid, _, _, ann, _ = _pipeline(client, db)
    r = client.patch(f"/admin/workflow-cards/{ann['id']}", json={"config": {"status": "done"}})
    assert r.status_code == 200 and r.json()["config"]["status"] == "todo"  # computed value wins
    client.as_user(ANNOTATOR_SUBJECT)
    assert client.patch(f"/admin/workflow-cards/{ann['id']}", json={"title": "x"}).status_code == 403


def test_assignee_may_rerun_their_own_job_but_not_edit_the_board(client, db):
    sid, _, _, ann, _ = _pipeline(client, db)
    client.as_user(ANNOTATOR_SUBJECT)
    assert client.post(f"/admin/workflow-cards/{ann['id']}/run").status_code == 200
    assert client.delete(f"/admin/workflow-cards/{ann['id']}").status_code == 403
    assert client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": "note", "title": "n", "position_x": 0, "position_y": 0}).status_code == 403


def test_split_produces_deterministic_parts(client, db):
    sid = make_study(client)
    for i in range(10):
        make_case(client, sid, external=f"s{i}")
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    split = _card(client, sid, "split", "Split", {"parts": [{"name": "train", "ratio": 0.7}, {"name": "test", "ratio": 0.3}], "seed": "42"}, x=300)
    _edge(client, sid, ds["id"], split["id"])
    client.post(f"/admin/workflow-cards/{split['id']}/run")
    board = client.get(f"/admin/studies/{sid}/workflow").json()
    parts = [c for c in board["cards"] if c["type"] == "dataset" and c["id"] != ds["id"]]
    assert len(parts) == 2
    sizes = sorted(len(c["output_case_ids"] or c["config"].get("case_ids", [])) for c in parts)
    assert sum(sizes) == 10 and sizes == [3, 7]
    first = [c["config"].get("case_ids") for c in parts]
    client.post(f"/admin/workflow-cards/{split['id']}/run")
    board2 = client.get(f"/admin/studies/{sid}/workflow").json()
    second = [c["config"].get("case_ids") for c in board2["cards"] if c["type"] == "dataset" and c["id"] != ds["id"]]
    assert first == second  # same seed, same split


def test_surface_config_defaults_to_everything_allowed(client, db):
    _, _, _, ann, _ = _pipeline(client, db)
    client.as_user(ANNOTATOR_SUBJECT)
    cfg = client.get(f"/admin/workflow-cards/{ann['id']}/surface-config").json()
    assert cfg  # a permissive default, never a 404 for an unrestricted job


def test_card_changes_are_audited_but_drags_are_not(client, db):
    sid, _, _, ann, _ = _pipeline(client, db)
    client.patch(f"/admin/workflow-cards/{ann['id']}", json={"position_x": 999})
    client.patch(f"/admin/workflow-cards/{ann['id']}", json={"title": "Renamed"})
    entries = client.get("/admin/audit-log", params={"entity_id": ann["id"]}).json()["entries"]
    actions = [e["action"] for e in entries]
    assert actions.count("card.update") == 1 and "card.run" in actions and "card.create" in actions
    client.delete(f"/admin/workflow-cards/{ann['id']}")
    assert client.get("/admin/audit-log", params={"entity_id": ann["id"]}).json()["entries"][0]["action"] == "card.delete"


def test_surface_config_carries_the_review_surfaces_checklist(client, db):
    """A Review Surface's per-label checklist (what ct-annotator's review
    card shows next to the comment box) rides along in surface-config;
    a job without one gets an empty list, never a missing key."""
    sid, _, _, ann, rev = _pipeline(client, db)
    client.as_user(REVIEWER_SUBJECT)
    assert client.get(f"/admin/workflow-cards/{rev['id']}/surface-config").json()["review_form"] == []

    client.as_admin()
    form = [{"label": "Nodule", "fields": [{"name": "Type", "kind": "choice", "options": ["solid", "sub-solid"]}, {"name": "Calcified", "kind": "check"}]}]
    surface = _card(client, sid, "review_surface", "Review surface", {"panes": ["axial"], "review_form": form}, x=600)
    _edge(client, sid, surface["id"], rev["id"], source_handle="surface_config", target_handle="surface_config")

    client.as_user(REVIEWER_SUBJECT)
    config = client.get(f"/admin/workflow-cards/{rev['id']}/surface-config").json()
    assert config["review_form"] == form
    assert config["panes"] == ["axial"] and config["tools"] == [] and config["show_3d"] is False
    # An Annotation job's surface-config never carries a checklist it wasn't given.
    client.as_user(ANNOTATOR_SUBJECT)
    assert client.get(f"/admin/workflow-cards/{ann['id']}/surface-config").json()["review_form"] == []
