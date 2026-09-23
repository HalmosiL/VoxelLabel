"""Unit tests for app/study_analytics/stats.py on a hand-built study:
one case round-tripped through the viewer's per-object review (rejected,
fixed, approved), one approved first time through the admin-ui's
whole-annotation review, one awaiting review, one only entered."""
from datetime import datetime, timedelta, timezone

from app.study_analytics import stats

T0 = datetime(2026, 9, 1, 9, 0, tzinfo=timezone.utc)
ANN, REV = "u-ann", "u-rev"
A_CARD, R_CARD = "card-ann", "card-rev"
CARD_TYPES = {A_CARD: "annotation", R_CARD: "review"}
NAMES = {ANN: "dr-test", REV: "dr-review"}
LABELS = [{"id": 1, "name": "Nodule"}, {"id": 2, "name": "Mass"}]


def at(hours):
    return T0 + timedelta(hours=hours)


def payload(*objects):
    return {"labels": LABELS, "objects": list(objects)}


def obj(label_id, review_status=None, reason=None):
    o = {"id": 1, "label_id": label_id}
    if review_status:
        o["review_status"] = review_status
    if reason:
        o["reject_reason"] = reason
    return o


ANNOTATIONS = [
    # case A: submitted, reviewer's version rejected, re-submitted, reviewer's version approved
    {"id": "a1", "case_id": "A", "annotator_id": ANN, "status": "submitted", "created_at": at(2), "payload": payload(obj(1), obj(2))},
    {"id": "a2", "case_id": "A", "annotator_id": REV, "status": "rejected", "created_at": at(5), "payload": payload(obj(1, "accepted"), obj(2, "rejected", "boundary"))},
    {"id": "a3", "case_id": "A", "annotator_id": ANN, "status": "submitted", "created_at": at(8), "payload": payload(obj(1), obj(2), obj(2))},
    {"id": "a4", "case_id": "A", "annotator_id": REV, "status": "approved", "created_at": at(10), "payload": payload(obj(1, "accepted"), obj(2, "accepted"), obj(2, "accepted"))},
    # case B: admin-ui review decides on the annotator's own row
    {"id": "b1", "case_id": "B", "annotator_id": ANN, "status": "approved", "created_at": at(3), "payload": payload(obj(1))},
    # case C: submitted, not reviewed yet
    {"id": "c1", "case_id": "C", "annotator_id": ANN, "status": "draft", "created_at": at(1), "payload": payload()},
    {"id": "c2", "case_id": "C", "annotator_id": ANN, "status": "submitted", "created_at": at(4), "payload": payload(obj(2))},
]
REVIEWS = [
    {"annotation_id": "a2", "reviewer_id": REV, "decision": "reject", "created_at": at(5)},
    {"annotation_id": "a4", "reviewer_id": REV, "decision": "approve", "created_at": at(10)},
    {"annotation_id": "b1", "reviewer_id": REV, "decision": "approve", "created_at": at(6)},
]
STAGE = [{"card_id": A_CARD, "case_id": c, "occurred_at": at(0)} for c in ("A", "B", "C", "D")]
EFFORT = [
    {"job_id": A_CARD, "case_id": "A", "user_ids": [ANN], "sittings": 2, "active_ms": 600_000, "undos": 3, "first_input_ms": [2000]},
    {"job_id": A_CARD, "case_id": "B", "user_ids": [ANN], "sittings": 1, "active_ms": 200_000, "undos": 0, "first_input_ms": [1000]},
    {"job_id": R_CARD, "case_id": "A", "user_ids": [REV], "sittings": 2, "active_ms": 120_000, "undos": 0, "first_input_ms": [1000]},
]


def histories():
    return stats.case_histories(ANNOTATIONS, REVIEWS)


def test_submissions_and_decisions_are_read_from_both_review_flows():
    h = histories()
    assert [s["id"] for s in h["A"]["submissions"]] == ["a1", "a3"]  # the reviewer's own versions are not submissions
    assert [d["decision"] for d in h["A"]["decisions"]] == ["reject", "approve"]
    assert [s["id"] for s in h["B"]["submissions"]] == ["b1"] and h["B"]["decisions"][0]["decision"] == "approve"
    assert {k: stats.case_state(v) for k, v in h.items()} == {"A": "approved", "B": "approved", "C": "awaiting_review"}


def test_case_table_rounds_rework_lead_time_and_what_was_drawn():
    rows = {r["case_id"]: r for r in stats.cases_table(histories(), STAGE, EFFORT, CARD_TYPES, {"A": "Case A"}, NAMES)}
    a = rows["A"]
    assert (a["state"], a["rounds"], a["sent_back"], a["first_pass"]) == ("approved", 2, 1, False)
    assert a["lead_time_ms"] == 10 * 3_600_000 and a["annotate_ms"] == 600_000 and a["review_ms"] == 120_000
    assert a["labels"] == {"Nodule": 1, "Mass": 2} and a["objects"] == 3
    assert a["annotators"] == ["dr-test"] and a["reviewers"] == ["dr-review"] and a["case_title"] == "Case A"
    assert rows["B"]["first_pass"] is True and rows["B"]["lead_time_ms"] == 6 * 3_600_000
    assert rows["C"]["state"] == "awaiting_review" and rows["C"]["first_pass"] is None
    assert rows["D"]["state"] == "not_started" and rows["D"]["rounds"] == 0
    # open work first, approved last
    assert [r["state"] for r in stats.cases_table(histories(), STAGE, EFFORT, CARD_TYPES, {}, NAMES)][-1] == "approved"


def test_label_table_counts_objects_and_per_object_verdicts():
    labels = {r["label"]: r for r in stats.label_table(histories())}
    assert labels["Mass"]["objects"] == 3 and labels["Mass"]["cases"] == 2  # A's latest (2) + C (1)
    assert labels["Mass"]["reviewed"] == 3 and labels["Mass"]["rejected"] == 1 and labels["Mass"]["rejection_rate"] == round(1 / 3, 3)
    assert labels["Mass"]["reasons"] == [{"reason": "boundary", "count": 1}]
    assert labels["Nodule"]["rejected"] == 0 and labels["Nodule"]["objects"] == 2


def test_people_table_covers_both_sides_of_the_work():
    legs = [
        {"card_id": R_CARD, "card_type": "review", "case_id": "A", "actor_id": REV, "assignee_id": REV, "work_ms": 60_000, "terminal_at": at(5)},
        {"card_id": A_CARD, "card_type": "annotation", "case_id": "D", "actor_id": None, "assignee_id": ANN, "work_ms": None, "terminal_at": None},
    ]
    people = {p["username"]: p for p in stats.people_table(histories(), legs, EFFORT, CARD_TYPES, NAMES)}
    ann = people["dr-test"]
    assert (ann["annotated_cases"], ann["submissions"], ann["sent_back"], ann["first_pass_rate"]) == (3, 4, 1, 0.5)
    assert ann["objects"] == 3 + 1 + 1 and ann["annotate_total_ms"] == 800_000 and ann["annotate_per_case_ms"] == 400_000
    assert ann["open_now"] == 1
    rev = people["dr-review"]
    assert (rev["reviews"], rev["approved"], rev["rejected"], rev["review_turnaround_ms"], rev["review_total_ms"]) == (3, 2, 1, 60_000, 120_000)


def test_card_metrics_and_weekly_throughput():
    cards = [{"id": A_CARD, "type": "annotation", "title": "Annotate"}, {"id": R_CARD, "type": "review", "title": "Review"}, {"id": "ds", "type": "dataset", "title": "All"}]
    legs = [
        {"card_id": A_CARD, "card_type": "annotation", "case_id": "A", "queue_ms": 1000, "work_ms": 5000, "terminal_at": at(2), "queue_start": at(0), "quality": {"first_pass": False, "rejections": 1}},
        {"card_id": A_CARD, "card_type": "annotation", "case_id": "D", "queue_ms": None, "work_ms": None, "terminal_at": None, "queue_start": at(0), "quality": None},
        {"card_id": R_CARD, "card_type": "review", "case_id": "A", "queue_ms": 2000, "work_ms": 3000, "terminal_at": at(5), "queue_start": at(2), "quality": None},
    ]
    m = stats.card_metrics(cards, legs, EFFORT, histories())
    assert set(m) == {A_CARD, R_CARD}
    assert (m[A_CARD]["entered"], m[A_CARD]["finished"], m[A_CARD]["open"], m[A_CARD]["first_pass_rate"], m[A_CARD]["sent_back"]) == (2, 1, 1, 0.0, 1)
    assert m[A_CARD]["hands_on_median_ms"] == 400_000
    assert (m[R_CARD]["approved"], m[R_CARD]["rejected"]) == (0, 1)
    weeks = stats.weekly_throughput(histories())
    assert weeks == [{"week": "2026-08-31", "submitted": 4, "approved": 2, "rejected": 1}]


def test_headline_sums_it_up():
    cases = stats.cases_table(histories(), STAGE, EFFORT, CARD_TYPES, {}, NAMES)
    h = stats.headline(cases, EFFORT, CARD_TYPES)
    assert h["cases"] == 4 and h["states"] == {"approved": 2, "awaiting_review": 1, "in_progress": 0, "sent_back": 0, "not_started": 1}
    assert h["first_pass_rate"] == 0.5 and h["lead_time_median_ms"] == 8 * 3_600_000 and h["rounds_median"] == 1.5
    assert h["hands_on_total_ms"] == 920_000 and h["objects"] == 3 + 1 + 1
