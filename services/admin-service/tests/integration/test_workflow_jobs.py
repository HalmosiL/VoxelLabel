"""The workflow board and the jobs it produces: cards, edges, Run,
My Jobs, and the computed job status following the cases' real
annotation state."""
import uuid

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


def test_a_removed_member_no_longer_sees_their_job(client, db):
    """C-11/A-06: My Jobs listed the job, its cases and reviewer comments
    to an assignee whose every role in the study was removed."""
    sid, _, _, ann, _ = _pipeline(client, db)
    client.as_admin()
    assert client.delete(f"/admin/studies/{sid}/members/{ANNOTATOR_SUBJECT}", params={"role": "annotator"}).status_code == 204
    client.as_user(ANNOTATOR_SUBJECT)
    assert ann["id"] not in {j["card_id"] for j in client.get("/admin/my-jobs").json()}


def test_list_all_jobs_is_admin_only_and_covers_every_studys_jobs(client, db):
    """GET /admin/jobs (the admin-only Jobs page's data source): every
    Annotation/Review card on the platform, its assignee (or none), and
    its study -- not scoped to the caller's own assignments the way
    /admin/my-jobs is, and refused to anyone without the global admin
    role, including a study's own data_manager."""
    sid, cases, series, ann, rev = _pipeline(client, db)
    unassigned = _card(client, sid, "annotation", "Second cohort", {}, x=900)

    client.as_user(DM_SUBJECT)
    assert client.get("/admin/jobs").status_code == 403

    client.as_admin()
    jobs = {j["card_id"]: j for j in client.get("/admin/jobs").json()}
    assert {ann["id"], rev["id"], unassigned["id"]} <= jobs.keys()
    assert jobs[ann["id"]]["assigned_user_id"] == ANNOTATOR_SUBJECT
    assert jobs[ann["id"]]["card_type"] == "annotation"
    assert jobs[ann["id"]]["study_id"] == sid and jobs[ann["id"]]["study_name"]
    assert jobs[rev["id"]]["assigned_user_id"] == REVIEWER_SUBJECT
    assert jobs[unassigned["id"]]["assigned_user_id"] is None
    assert set(jobs[ann["id"]]["progress"].keys()) == {"annotated", "total"}


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


def test_review_jobs_surface_config_carries_the_annotation_labels_and_their_forms(client, db):
    """The per-object form lives on the Annotation Surface's labels
    (Nodule -> Type, Calcified, Confidence); a Review job, whose own
    surface has no labels, gets those same labels through its input
    chain so the reviewer sees the form the annotator filled."""
    sid, _, _, ann, rev = _pipeline(client, db)
    client.as_user(REVIEWER_SUBJECT)
    assert client.get(f"/admin/workflow-cards/{rev['id']}/surface-config").json()["labels"] == []

    client.as_admin()
    labels = [{"name": "Nodule", "color": "#ef4444", "fields": [
        {"name": "Type", "kind": "choice", "options": ["solid", "sub-solid"]},
        {"name": "Calcified", "kind": "check"},
        {"name": "Confidence", "kind": "scale", "min": 1, "max": 5},
    ]}]
    surface = _card(client, sid, "annotation_surface", "Nodule surface", {"tools": ["paint"], "panes": ["axial"], "labels": labels}, x=300)
    _edge(client, sid, surface["id"], ann["id"], source_handle="surface_config", target_handle="surface_config")

    client.as_user(ANNOTATOR_SUBJECT)
    assert client.get(f"/admin/workflow-cards/{ann['id']}/surface-config").json()["labels"] == labels
    client.as_user(REVIEWER_SUBJECT)
    config = client.get(f"/admin/workflow-cards/{rev['id']}/surface-config").json()
    assert config["labels"] == labels
    assert config["tools"] == [] and config["show_3d"] is False

    # Through a materialized "(annotated)" dataset between the two jobs, too.
    client.as_admin()
    board = client.get(f"/admin/studies/{sid}/workflow").json()
    rev_input = next(e for e in board["edges"] if e["target_card_id"] == rev["id"] and e["target_handle"] == "input")
    assert client.delete(f"/admin/workflow-edges/{rev_input['id']}").status_code in (200, 204)
    mid = _card(client, sid, "dataset", "Annotate (annotated)", {"mode": "manual", "case_ids": []}, x=450)
    db.execute(__import__("sqlalchemy").text("UPDATE workflow_cards SET materialized_source_card_id = :src, materialized_source_handle = 'annotated' WHERE id = :id"), {"src": ann["id"], "id": mid["id"]})
    db.commit()
    _edge(client, sid, mid["id"], rev["id"])
    client.as_user(REVIEWER_SUBJECT)
    assert client.get(f"/admin/workflow-cards/{rev['id']}/surface-config").json()["labels"] == labels


def test_a_dataset_can_only_pin_cases_of_its_own_study(client, db):
    """C-08: a data manager of study A must not pull study B's cases (their
    annotation state and reviewer comments) into A's board."""
    from shared_models.models import WorkflowCard

    sid_a = make_study(client, "A")
    sid_b = make_study(client, "B")
    add_member(client, sid_a, DM_SUBJECT, "data_manager")
    own = make_case(client, sid_a, external="a1")
    foreign = make_case(client, sid_b, external="b1")
    client.as_user(DM_SUBJECT)

    def create(case_ids):
        return client.post(f"/admin/studies/{sid_a}/workflow/cards", json={"type": "dataset", "title": "Pinned", "position_x": 0, "position_y": 0, "config": {"mode": "manual", "case_ids": case_ids}})

    assert create([foreign["id"]]).status_code == 422
    assert create([own["id"], foreign["id"]]).status_code == 422
    assert create(["not-a-uuid"]).status_code == 422
    assert create("x").status_code == 422
    ds = create([own["id"]])
    assert ds.status_code == 201
    # nor sneak it in later with a PATCH
    assert client.patch(f"/admin/workflow-cards/{ds.json()['id']}", json={"config": {"case_ids": [foreign["id"]]}}).status_code == 422

    # a config stored before these checks (or restored from a version) is ignored on read and on Run
    client.as_admin()
    card = db.get(WorkflowCard, ds.json()["id"])
    card.config = {"mode": "manual", "case_ids": [own["id"], foreign["id"], "junk"]}
    db.commit()
    ann = _card(client, sid_a, "annotation", "Annotate", {}, x=300)
    _edge(client, sid_a, ds.json()["id"], ann["id"])
    assert client.post(f"/admin/workflow-cards/{ann['id']}/run").status_code == 200
    ids = [c["id"] for c in client.get(f"/admin/workflow-cards/{ann['id']}/cases").json()]
    assert ids == [own["id"]]


def test_board_loads_when_an_ai_card_is_fed_by_a_card_not_run_yet(client, db):
    """C-01: an LLM/Criterion card wired to a never-run Filter used to make
    GET /workflow 409 for everyone -- an empty canvas, no way to fix it
    from the UI. The board loads; the card counts what it can and names
    what still needs a Run."""
    sid = make_study(client)
    make_case(client, sid, external="p0")
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    flt = _card(client, sid, "filter", "Adults only", x=300)
    llm = _card(client, sid, "llm", "Assistant", x=600)
    _edge(client, sid, ds["id"], flt["id"])
    _edge(client, sid, flt["id"], llm["id"])
    _edge(client, sid, ds["id"], llm["id"])

    r = client.get(f"/admin/studies/{sid}/workflow")
    assert r.status_code == 200, r.text
    card = next(c for c in r.json()["cards"] if c["id"] == llm["id"])
    assert card["llm_connected_case_count"] == 1  # the Dataset's case still counts
    assert card["llm_unrun_sources"] == ["Adults only"]


def test_a_reviewers_save_keeps_the_case_handed_in(client, db):
    """F-01: the reviewer's "Save" while reviewing made the case "not
    annotated" for the annotator and left the review queue nothing to
    decide. Their draft points at the version it reviews and changes
    neither side."""
    from shared_models.models import Annotation

    sid, cases, series, ann, rev = _pipeline(client, db, n_cases=1)
    submitted = make_annotation(db, sid, series[0], ANNOTATOR_SUBJECT, "submitted")
    review_draft = make_annotation(db, sid, series[0], REVIEWER_SUBJECT, "draft")
    db.get(Annotation, review_draft).review_of_id = submitted
    db.commit()

    annotator_case = _job(client, ANNOTATOR_SUBJECT, ann["id"])["cases"][0]
    assert annotator_case["status"] == "done"
    reviewer_case = _job(client, REVIEWER_SUBJECT, rev["id"])["cases"][0]
    assert reviewer_case["status"] == "pending" and reviewer_case["pending_annotation_id"] == str(review_draft)


def test_split_ratios_must_be_usable(client, db):
    """C-06: a negative ratio stole cases, text or null gave 500, huge
    ratios overflowed and all-zero sent everything to the last part."""
    sid = make_study(client)
    for parts in (
        [{"name": "a", "ratio": -1}, {"name": "b", "ratio": 2}],
        [{"name": "a", "ratio": "abc"}, {"name": "b", "ratio": 1}],
        [{"name": "a", "ratio": None}, {"name": "b", "ratio": 1}],
        [{"name": "a", "ratio": 1e308}, {"name": "b", "ratio": 1e308}],
        [{"name": "a", "ratio": 0}, {"name": "b", "ratio": 0}],
    ):
        r = client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": "split", "title": "S", "position_x": 0, "position_y": 0, "config": {"parts": parts}})
        assert r.status_code == 422, (parts, r.text)
    ok = _card(client, sid, "split", "S", {"parts": [{"name": "a", "ratio": 70}, {"name": "b", "ratio": 30}]})
    bad = {"parts": [{"name": "a", "ratio": -5}, {"name": "b", "ratio": 1}]}
    assert client.patch(f"/admin/workflow-cards/{ok['id']}", json={"config": bad}).status_code == 422


def test_non_finite_numbers_are_refused(client, db):
    """C-07: a NaN position was stored and then made every study autosave fail, silently."""
    sid = make_study(client)
    headers = {"content-type": "application/json"}
    body = '{"type": "note", "title": "n", "position_x": NaN, "position_y": 0, "config": {}}'
    assert client.post(f"/admin/studies/{sid}/workflow/cards", content=body, headers=headers).status_code == 422
    body = '{"type": "note", "title": "n", "position_x": 0, "position_y": 0, "config": {"zoom": Infinity}}'
    assert client.post(f"/admin/studies/{sid}/workflow/cards", content=body, headers=headers).status_code == 422
    note = _card(client, sid, "note", "n")
    assert client.patch(f"/admin/workflow-cards/{note['id']}", content='{"position_y": NaN}', headers=headers).status_code == 422


def test_an_edit_made_during_an_ai_run_survives_it(client, db, monkeypatch):
    """C-15: a Criterion Run (or an AI chat turn) takes minutes; the config
    was written back from the copy read before the model call, reverting
    whatever was edited meanwhile."""
    from app.api.workflow import engine, routes
    from shared_models.database import SessionLocal
    from shared_models.models import WorkflowCard

    sid = make_study(client)
    make_case(client, sid, external="p0")
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    crit = _card(client, sid, "criterion", "Crit", {"criterion": "Patient has a nodule"}, x=300)
    _edge(client, sid, ds["id"], crit["id"])

    async def model_turn(card, history, message):
        other = SessionLocal()  # someone edits the card while the model is thinking
        row = other.get(WorkflowCard, card.id)
        row.config = {**row.config, "criterion": "EDITED while running"}
        other.commit()
        other.close()
        return [{"role": "assistant", "content": "done"}], False

    monkeypatch.setattr(engine, "run_llm_turn", model_turn)
    monkeypatch.setattr(routes, "run_llm_turn", model_turn)
    assert client.post(f"/admin/workflow-cards/{crit['id']}/run").status_code == 200
    db.expire_all()
    config = db.get(WorkflowCard, uuid.UUID(crit["id"])).config
    assert config["criterion"] == "EDITED while running" and config["messages"][-1]["content"] == "done"

    llm = _card(client, sid, "llm", "Assistant", {"note": "before"}, x=600)
    assert client.post(f"/admin/workflow-cards/{llm['id']}/llm-chat", json={"message": "hi"}).status_code == 200
    db.expire_all()
    assert db.get(WorkflowCard, uuid.UUID(llm["id"])).config["criterion"] == "EDITED while running"


def _edge_status(client, sid, src, dst, target_handle="input"):
    return client.post(f"/admin/studies/{sid}/workflow/edges", json={"source_card_id": src, "source_handle": "output", "target_card_id": dst, "target_handle": target_handle}).status_code


def test_the_board_refuses_shapes_it_cannot_run_or_show(client, db):
    """C-02, C-03, C-04: the legacy "surface" type, an unknown target handle
    (an invisible, undeletable input), a duplicate edge, a second input into
    a one-input card, and a loop were all accepted -- the trouble only
    surfaced at Run, as a misleading "has not been run yet" for a loop."""
    sid = make_study(client)
    r = client.post(f"/admin/studies/{sid}/workflow/cards", json={"type": "surface", "title": "legacy", "position_x": 0, "position_y": 0, "config": {}})
    assert r.status_code == 422
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    ds2 = _card(client, sid, "dataset", "Other", {"mode": "all_cases"})
    flt = _card(client, sid, "filter", "F", x=300)
    union = _card(client, sid, "union", "U", x=600)
    assert _edge_status(client, sid, ds["id"], union["id"], target_handle="bogus") == 422
    assert _edge_status(client, sid, ds["id"], flt["id"]) == 201
    assert _edge_status(client, sid, ds["id"], flt["id"]) == 409  # the same connection again
    assert _edge_status(client, sid, ds2["id"], flt["id"]) == 422  # a filter takes one input
    assert _edge_status(client, sid, flt["id"], union["id"]) == 201
    assert _edge_status(client, sid, union["id"], flt["id"]) == 422  # a loop (and a second input)
    union2 = _card(client, sid, "union", "U2", x=900)
    assert _edge_status(client, sid, union["id"], union2["id"]) == 201
    assert _edge_status(client, sid, union2["id"], union["id"]) == 422  # a loop between two multi-input cards


def test_a_removed_split_part_keeps_no_cases(client, db):
    """C-05: after going from 3 parts to 2, the old third part's Dataset
    kept its cases, all of them now also in the live parts -- a
    train/test split that is no longer disjoint."""
    sid = make_study(client)
    for i in range(11):
        make_case(client, sid, external=f"s{i}")
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    parts3 = [{"name": "a", "ratio": 1}, {"name": "b", "ratio": 1}, {"name": "c", "ratio": 1}]
    split = _card(client, sid, "split", "Split", {"parts": parts3, "seed": "7"}, x=300)
    _edge(client, sid, ds["id"], split["id"])
    assert client.post(f"/admin/workflow-cards/{split['id']}/run").status_code == 200
    client.patch(f"/admin/workflow-cards/{split['id']}", json={"config": {"parts": parts3[:2]}})
    assert client.post(f"/admin/workflow-cards/{split['id']}/run").status_code == 200
    board = client.get(f"/admin/studies/{sid}/workflow").json()
    children = {c["materialized_from"]["card_id"] and c["title"]: c["config"].get("case_ids", []) for c in board["cards"] if c.get("materialized_from")}
    live = [ids for title, ids in children.items() if title in ("a", "b")]
    removed = [(title, ids) for title, ids in children.items() if title not in ("a", "b")]
    assert sum(len(ids) for ids in live) == 11
    assert removed and all(ids == [] and "no longer a part" in title for title, ids in removed), removed


def test_the_review_feedback_loop_carries_the_rejected_case_and_settles(client, db):
    """C-09: the "(rejected)" branch of the Review -> Annotation feedback
    loop was always empty -- a rejected case dropped out of "(annotated)",
    and so out of the review's scope, in the same Run. C-10: one of the
    two cards stayed "needs re-run" forever."""
    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    add_member(client, sid, REVIEWER_SUBJECT, "reviewer")
    cases = [make_case(client, sid, external=f"p{i}") for i in range(2)]
    series = [make_series(db, c["id"]) for c in cases]
    ds = _card(client, sid, "dataset", "All", {"mode": "all_cases"})
    ann = _card(client, sid, "annotation", "Annotate", {"assigned_user_id": ANNOTATOR_SUBJECT, "materialize_dataset": True}, x=300)
    _edge(client, sid, ds["id"], ann["id"])
    assert client.post(f"/admin/workflow-cards/{ann['id']}/run").status_code == 200
    card = lambda title: next(c for c in client.get(f"/admin/studies/{sid}/workflow").json()["cards"] if c["title"] == title)  # noqa: E731
    rev = _card(client, sid, "review", "Review", {"assigned_user_id": REVIEWER_SUBJECT}, x=600)
    _edge(client, sid, card("Annotate (annotated)")["id"], rev["id"])
    assert client.post(f"/admin/workflow-cards/{rev['id']}/run").status_code == 200
    _edge(client, sid, card("Review (rejected)")["id"], ann["id"])  # the feedback edge

    for s in series:
        make_annotation(db, sid, s, ANNOTATOR_SUBJECT, "submitted")
    assert client.post(f"/admin/workflow-cards/{ann['id']}/run").status_code == 200
    make_annotation(db, sid, series[0], REVIEWER_SUBJECT, "approved")
    make_annotation(db, sid, series[1], REVIEWER_SUBJECT, "rejected")
    assert client.post(f"/admin/workflow-cards/{rev['id']}/run").status_code == 200

    assert card("Review (rejected)")["config"]["case_ids"] == [cases[1]["id"]]
    assert card("Review (approved)")["config"]["case_ids"] == [cases[0]["id"]]
    assert set(card("Review")["output_case_ids"]) == {c["id"] for c in cases}  # the reviewer keeps what they rejected
    assert not card("Annotate")["stale"] and not card("Review")["stale"]
    assert client.post(f"/admin/workflow-cards/{ann['id']}/run").status_code == 200
    assert not card("Annotate")["stale"] and not card("Review")["stale"]


def test_consort_follows_the_criterion_and_flags_a_changed_population(client, db):
    """C-16: the export followed whichever outgoing edge the database
    returned first (an Annotation, so no stages at all), and kept a
    criterion's old counts after the population changed (6 of 5
    included)."""
    from shared_models.models import WorkflowCard

    sid = make_study(client)
    add_member(client, sid, ANNOTATOR_SUBJECT, "annotator")
    ids = [make_case(client, sid, external=f"c{i}")["id"] for i in range(4)]
    root = _card(client, sid, "dataset", "Population", {"mode": "manual", "case_ids": ids})
    ann = _card(client, sid, "annotation", "Annotate", {"assigned_user_id": ANNOTATOR_SUBJECT}, x=300)
    crit = _card(client, sid, "criterion", "Adults", {"criterion": "age >= 18"}, x=300)
    _edge(client, sid, root["id"], ann["id"])  # the older edge, not a criterion
    _edge(client, sid, root["id"], crit["id"])
    # the criterion's evaluation, as evaluate_criterion materializes it
    for handle, case_ids in (("included", ids[:3]), ("excluded", ids[3:])):
        db.add(WorkflowCard(study_id=uuid.UUID(sid), type="dataset", title=f"Adults -- {handle}", position_x=0, position_y=0,
                            config={"mode": "manual", "case_ids": case_ids}, materialized_source_card_id=uuid.UUID(crit["id"]), materialized_source_handle=handle))
    db.commit()

    url = f"/admin/studies/{sid}/consort-export?root_card_id={root['id']}"
    export = client.get(url).json()
    assert [s["title"] for s in export["stages"]] == ["Adults"]
    assert export["stages"][0]["included_count"] == 3 and not export["stages"][0]["needs_reevaluation"]
    assert export["final_count"] == 3

    client.patch(f"/admin/workflow-cards/{root['id']}", json={"config": {"case_ids": ids[:2]}})  # the population changed
    stage = client.get(url).json()["stages"][0]
    assert stage["input_count"] == 2 and stage["needs_reevaluation"]
