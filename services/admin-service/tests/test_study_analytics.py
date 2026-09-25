"""Unit tests for app/study_analytics/stats.py on hand-built studies of
three shapes -- annotate + review, annotate + review + senior review, and
annotate only -- covering both review flows (the viewer's per-object
review deciding on the reviewer's own version; the admin-ui deciding on
the annotator's row)."""
from datetime import datetime, timedelta, timezone

from app.study_analytics import stats

T0 = datetime(2026, 9, 1, 9, 0, tzinfo=timezone.utc)
ANN, REV, SENIOR = "u-ann", "u-rev", "u-senior"
NAMES = {ANN: "dr-test", REV: "dr-review", SENIOR: "dr-senior"}
LABELS = [{"id": 1, "name": "Nodule"}, {"id": 2, "name": "Mass"}]


def at(hours):
    return T0 + timedelta(hours=hours)


def payload(*objects):
    return {"labels": LABELS, "objects": list(objects)}


def obj(label_id, review_status=None, reason=None, instance=1):
    o = {"id": instance, "label_id": label_id, "instance_number": instance}
    if review_status:
        o["review_status"] = review_status
    if reason:
        o["reject_reason"] = reason
    return o


def card(cid, type_, title, assignee=None, source=None, handle=None):
    return {"id": cid, "type": type_, "title": title, "assignee_id": assignee, "materialized_source_card_id": source, "materialized_source_handle": handle}


# ---------------------------------------------------------------- annotate -> review

ONE_REVIEW = stats.Board(
    [
        card("ds", "dataset", "All"),
        card("ann", "annotation", "Annotate", ANN),
        card("rev", "review", "Review", REV),
        card("ok", "dataset", "Review (approved)", source="rev", handle="approved"),
        card("back", "dataset", "Review (rejected)", source="rev", handle="rejected"),
    ],
    [
        {"source_card_id": "ds", "source_handle": "output", "target_card_id": "ann"},
        {"source_card_id": "ann", "source_handle": "output", "target_card_id": "rev"},
        {"source_card_id": "back", "source_handle": "output", "target_card_id": "ann"},
    ],
)
ANNOTATIONS = [
    # A: submitted, the reviewer's version rejected (one Mass off), re-submitted, the reviewer's version approved
    {"id": "a1", "case_id": "A", "annotator_id": ANN, "status": "submitted", "created_at": at(2), "payload": payload(obj(1), obj(2))},
    {"id": "a2", "case_id": "A", "annotator_id": REV, "status": "rejected", "created_at": at(5), "payload": payload(obj(1, "accepted"), obj(2, "rejected", "boundary", 1))},
    {"id": "a3", "case_id": "A", "annotator_id": ANN, "status": "submitted", "created_at": at(8), "payload": payload(obj(1), obj(2), obj(2, instance=2))},
    {"id": "a4", "case_id": "A", "annotator_id": REV, "status": "approved", "created_at": at(10), "payload": payload(obj(1, "accepted"), obj(2, "accepted"), obj(2, "accepted", instance=2))},
    # B: the admin-ui review decides on the annotator's own row
    {"id": "b1", "case_id": "B", "annotator_id": ANN, "status": "approved", "created_at": at(3), "payload": payload(obj(1))},
    # C: submitted, not reviewed yet
    {"id": "c1", "case_id": "C", "annotator_id": ANN, "status": "draft", "created_at": at(1), "payload": payload()},
    {"id": "c2", "case_id": "C", "annotator_id": ANN, "status": "submitted", "created_at": at(4), "payload": payload(obj(2))},
    # E: rejected twice, still sent back
    {"id": "e1", "case_id": "E", "annotator_id": ANN, "status": "rejected", "created_at": at(2), "payload": payload(obj(1))},
    {"id": "e2", "case_id": "E", "annotator_id": ANN, "status": "rejected", "created_at": at(6), "payload": payload(obj(1))},
]
REVIEWS = [
    {"annotation_id": "a2", "reviewer_id": REV, "decision": "reject", "comment": "Mass 1: boundary too generous", "created_at": at(5)},
    {"annotation_id": "a4", "reviewer_id": REV, "decision": "approve", "comment": None, "created_at": at(10)},
    {"annotation_id": "b1", "reviewer_id": REV, "decision": "approve", "comment": None, "created_at": at(6)},
    {"annotation_id": "e1", "reviewer_id": REV, "decision": "reject", "comment": "missed a nodule", "created_at": at(3)},
    {"annotation_id": "e2", "reviewer_id": REV, "decision": "reject", "comment": "still missing", "created_at": at(7)},
]
STAGE = [{"card_id": "ann", "case_id": c, "occurred_at": at(0)} for c in "ABCDE"] + [{"card_id": "rev", "case_id": c, "occurred_at": at(1)} for c in "ABCE"]
EFFORT = [
    {"job_id": "ann", "case_id": "A", "user_ids": [ANN], "sittings": 2, "active_ms": 600_000, "undos": 3, "first_input_ms": [2000]},
    {"job_id": "ann", "case_id": "B", "user_ids": [ANN], "sittings": 1, "active_ms": 200_000, "undos": 0, "first_input_ms": [1000]},
    {"job_id": "rev", "case_id": "A", "user_ids": [REV], "sittings": 2, "active_ms": 120_000, "undos": 0, "first_input_ms": [1000]},
]


def one_review():
    h = stats.case_histories(ANNOTATIONS, REVIEWS, STAGE, ONE_REVIEW)
    return h, stats.cases_table(h, STAGE, ONE_REVIEW, EFFORT, {"A": "Case A"}, {"A": 120, "B": 80}, NAMES)


def test_events_are_read_from_both_review_flows_and_attributed_to_steps():
    h, _ = one_review()
    assert [(e["kind"], e["card_id"]) for e in h["A"]["events"]] == [("submitted", "ann"), ("rejected", "rev"), ("submitted", "ann"), ("approved", "rev")]
    assert [e["kind"] for e in h["B"]["events"]] == ["submitted", "approved"]


def test_case_states_steps_and_what_changed():
    _, rows = one_review()
    r = {row["case_id"]: row for row in rows}
    assert {k: v["state"] for k, v in r.items()} == {"A": "done", "B": "done", "C": "awaiting_review", "D": "not_started", "E": "sent_back"}
    a = r["A"]
    assert (a["rounds"], a["reviews"], a["sent_back"], a["first_pass"]) == (2, 2, 1, False)
    assert [(p["step"], p["kind"]) for p in a["path"]] == [("Annotate", "submitted"), ("Review", "rejected"), ("Annotate", "submitted"), ("Review", "approved")]
    assert a["lead_time_ms"] == 10 * 3_600_000 and a["slices"] == 120 and a["case_title"] == "Case A"
    assert (a["objects_first"], a["objects"], a["labels"]) == (2, 3, {"Nodule": 1, "Mass": 2})
    assert a["rejected_objects"] == [{"review": 1, "label": "Mass", "instance": 1, "reason": "boundary", "comment": None}]
    assert a["review_comments"][0]["text"] == "Mass 1: boundary too generous" and a["annotate_ms"] == 600_000 and a["review_ms"] == 120_000
    assert r["C"]["waiting_at"] == "rev" and r["E"]["waiting_at"] == "ann" and r["D"]["waiting_at"] == "ann"
    assert r["E"]["sent_back"] == 2 and [c["text"] for c in r["E"]["review_comments"]] == ["missed a nodule", "still missing"]
    assert rows[0]["case_id"] == "E" and rows[-1]["state"] == "done"  # open work first


def test_step_metrics_on_the_graph():
    h, rows = one_review()
    legs = [{"card_id": "ann", "case_id": "A", "queue_ms": 1000, "work_ms": 5000}, {"card_id": "rev", "case_id": "A", "queue_ms": 2000, "work_ms": 3000}]
    m = stats.card_metrics(ONE_REVIEW, STAGE, legs, EFFORT, h, rows)
    assert set(m) == {"ann", "rev"}
    assert (m["ann"]["entered"], m["ann"]["finished"], m["ann"]["submissions"], m["ann"]["sent_back"], m["ann"]["open"]) == (5, 4, 6, 3, 2)
    assert m["ann"]["first_pass_rate"] == round(1 / 3, 3)  # A rejected first, B approved, E rejected; C not decided
    assert (m["rev"]["finished"], m["rev"]["approved"], m["rev"]["rejected"], m["rev"]["open"]) == (3, 2, 3, 1)
    assert m["ann"]["hands_on_median_ms"] == 400_000 and m["ann"]["wait_median_ms"] == 1000


def test_labels_people_weekly_and_headline():
    h, rows = one_review()
    labels = {x["label"]: x for x in stats.label_table(h)}
    assert (labels["Mass"]["objects_first"], labels["Mass"]["objects"], labels["Mass"]["cases"]) == (2, 3, 2)
    assert (labels["Mass"]["reviewed"], labels["Mass"]["rejected"], labels["Mass"]["reasons"]) == (3, 1, [{"reason": "boundary", "count": 1}])
    people = {p["username"]: p for p in stats.people_table(h, [], EFFORT, ONE_REVIEW, NAMES)}
    assert (people["dr-test"]["annotated_cases"], people["dr-test"]["submissions"], people["dr-test"]["first_pass_rate"], people["dr-test"]["sent_back"]) == (4, 6, round(1 / 3, 3), 3)
    assert (people["dr-review"]["reviews"], people["dr-review"]["approved"], people["dr-review"]["rejected"]) == (5, 2, 3)
    assert stats.weekly_throughput(h) == [{"week": "2026-08-31", "submitted": 6, "approved": 2, "rejected": 3}]
    head = stats.headline(rows, EFFORT, ONE_REVIEW)
    assert head["states"] == {"sent_back": 1, "awaiting_review": 1, "awaiting_next": 0, "in_progress": 0, "not_started": 1, "done": 2}
    assert (head["problem_cases"], head["steps"], head["slices"], head["first_pass_rate"]) == (1, 2, 200, round(1 / 3, 3))


# ---------------------------------------------------------------- annotate -> review -> senior review

TWO_REVIEWS = stats.Board(
    [
        card("ann", "annotation", "Annotate", ANN),
        card("rev", "review", "Review", REV),
        card("ok1", "dataset", "Review (approved)", source="rev", handle="approved"),
        card("senior", "review", "Senior review", SENIOR),
        card("back2", "dataset", "Senior review (rejected)", source="senior", handle="rejected"),
    ],
    [
        {"source_card_id": "ann", "source_handle": "output", "target_card_id": "rev"},
        {"source_card_id": "ok1", "source_handle": "output", "target_card_id": "senior"},
        {"source_card_id": "back2", "source_handle": "output", "target_card_id": "ann"},
    ],
)


def test_a_second_review_step_is_a_step_of_its_own():
    annotations = [
        # P: approved by the first review, now waiting for the senior review
        {"id": "p1", "case_id": "P", "annotator_id": ANN, "status": "approved", "created_at": at(1), "payload": payload(obj(1))},
        # Q: approved by both reviews
        {"id": "q1", "case_id": "Q", "annotator_id": ANN, "status": "approved", "created_at": at(1), "payload": payload(obj(1))},
        # R: approved by the first, rejected by the senior -> back to annotation
        {"id": "r1", "case_id": "R", "annotator_id": ANN, "status": "rejected", "created_at": at(1), "payload": payload(obj(1))},
    ]
    reviews = [
        {"annotation_id": "p1", "reviewer_id": REV, "decision": "approve", "comment": None, "created_at": at(2)},
        {"annotation_id": "q1", "reviewer_id": REV, "decision": "approve", "comment": None, "created_at": at(2)},
        {"annotation_id": "q1", "reviewer_id": SENIOR, "decision": "approve", "comment": None, "created_at": at(4)},
        {"annotation_id": "r1", "reviewer_id": REV, "decision": "approve", "comment": None, "created_at": at(2)},
        {"annotation_id": "r1", "reviewer_id": SENIOR, "decision": "reject", "comment": "wrong label", "created_at": at(4)},
    ]
    stage = [{"card_id": "ann", "case_id": c, "occurred_at": at(0)} for c in "PQR"] + [{"card_id": "rev", "case_id": c, "occurred_at": at(1)} for c in "PQR"] + [{"card_id": "senior", "case_id": c, "occurred_at": at(3)} for c in "PQR"]
    h = stats.case_histories(annotations, reviews, stage, TWO_REVIEWS)
    rows = {r["case_id"]: r for r in stats.cases_table(h, stage, TWO_REVIEWS, [], {}, {}, NAMES)}
    assert (rows["P"]["state"], rows["P"]["waiting_at"]) == ("awaiting_review", "senior")
    assert rows["Q"]["state"] == "done" and [p["step"] for p in rows["Q"]["path"]] == ["Annotate", "Review", "Senior review"]
    assert (rows["R"]["state"], rows["R"]["waiting_at"], rows["R"]["first_pass"]) == ("sent_back", "ann", False)
    m = stats.card_metrics(TWO_REVIEWS, stage, [], [], h, list(rows.values()))
    assert (m["rev"]["approved"], m["rev"]["rejected"], m["rev"]["first_pass_rate"]) == (3, 0, 1.0)
    assert (m["senior"]["approved"], m["senior"]["rejected"], m["senior"]["open"], m["senior"]["first_pass_rate"]) == (1, 1, 1, 0.5)
    people = {p["username"]: p for p in stats.people_table(h, [], [], TWO_REVIEWS, NAMES)}
    assert people["dr-senior"]["reviews"] == 2 and people["dr-senior"]["rejected"] == 1


def test_an_annotation_only_workflow_finishes_at_submission():
    board = stats.Board([card("ds", "dataset", "All"), card("ann", "annotation", "Annotate", ANN)], [{"source_card_id": "ds", "source_handle": "output", "target_card_id": "ann"}])
    annotations = [{"id": "x1", "case_id": "X", "annotator_id": ANN, "status": "submitted", "created_at": at(2), "payload": payload(obj(1), obj(1, instance=2))}]
    stage = [{"card_id": "ann", "case_id": c, "occurred_at": at(0)} for c in "XY"]
    h = stats.case_histories(annotations, [], stage, board)
    rows = {r["case_id"]: r for r in stats.cases_table(h, stage, board, [], {}, {}, NAMES)}
    assert rows["X"]["state"] == "done" and rows["X"]["lead_time_ms"] == 2 * 3_600_000 and rows["X"]["first_pass"] is None
    assert rows["Y"]["state"] == "not_started"
    assert stats.headline(list(rows.values()), [], board)["first_pass_rate"] is None


def test_a_review_step_that_has_not_run_yet_still_counts_as_next():
    stage = [{"card_id": "ann", "case_id": "Z", "occurred_at": at(0)}]  # the Review card never ran
    annotations = [{"id": "z1", "case_id": "Z", "annotator_id": ANN, "status": "submitted", "created_at": at(1), "payload": payload()}]
    h = stats.case_histories(annotations, [], stage, ONE_REVIEW)
    [row] = stats.cases_table(h, stage, ONE_REVIEW, [], {}, {}, NAMES)
    assert (row["state"], row["waiting_at"]) == ("awaiting_review", "rev")


def test_a_review_step_counts_only_cases_handed_in(monkeypatch=None):
    """H-06: every case got a stage event for the review card when the
    board was Run, so a case never handed in (D, not started) counted as
    "In" at the review -- "In 4 · decided 3 · here now 0"."""
    h, rows = one_review()
    stage = STAGE + [{"card_id": "rev", "case_id": "D", "occurred_at": at(1)}]  # as the ripple writes it
    m = stats.card_metrics(ONE_REVIEW, stage, [], EFFORT, h, rows)
    assert m["rev"]["entered"] == 4  # A, B, C, E -- all handed in at some point; not D
    assert m["ann"]["entered"] == 5
