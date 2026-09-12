"""Unit tests for the workflow board's pure logic helpers -- the parts of
the app/api/workflow package that need no live DB or Keycloak. Run-time behavior
that requires a live Postgres (the actual Run endpoints, edge validation,
cascading delete) is exercised via curl against the docker-compose stack
instead, following this service's existing test/verification split (see
test_health.py's docstring for the same pattern in ingestion-service's
test_deidentify.py).
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.api.workflow import (
    _case_status,
    _cumulative_ratios,
    _dedupe_sorted,
    _is_stale,
    _job_status_from_entries,
    _matches_filter,
    _output_count,
    _split_case_ids,
    _split_parts,
)
from shared_models.models import AnnotationStatus, WorkflowCardType


def test_cumulative_ratios_two_equal_parts() -> None:
    assert _cumulative_ratios([{"ratio": 0.5}, {"ratio": 0.5}]) == [0.5, 1.0]


def test_cumulative_ratios_normalizes_when_not_summing_to_one() -> None:
    # 1/3-ish then pinned to 1.0, not the raw (unnormalized) 2.0 total.
    boundaries = _cumulative_ratios([{"ratio": 1}, {"ratio": 1}])
    assert boundaries[-1] == 1.0
    assert 0.4 < boundaries[0] < 0.6


def test_split_case_ids_is_deterministic_for_a_given_seed() -> None:
    cumulative = [0.5, 1.0]
    ids = [f"case-{i}" for i in range(10)]
    first = _split_case_ids(ids, "fixed-seed", cumulative)
    second = _split_case_ids(ids, "fixed-seed", cumulative)
    assert first == second


def test_split_case_ids_hits_the_exact_ratio_even_for_few_cases() -> None:
    """The whole point of sort-and-cut over an independent per-case hash
    draw: a small case count still lands on the exact requested ratio,
    not just something statistically close to it."""
    cumulative = [0.7, 1.0]
    ids = [f"case-{i}" for i in range(10)]
    buckets = _split_case_ids(ids, "fixed-seed", cumulative)
    assert [len(b) for b in buckets] == [7, 3]


def test_split_case_ids_exact_ratio_holds_at_larger_scale_too() -> None:
    cumulative = [0.5, 1.0]
    ids = [f"case-{i}" for i in range(500)]
    buckets = _split_case_ids(ids, "fixed-seed", cumulative)
    assert [len(b) for b in buckets] == [250, 250]


def test_split_case_ids_every_case_placed_exactly_once() -> None:
    cumulative = [0.3, 0.6, 1.0]
    ids = [f"case-{i}" for i in range(37)]  # odd count, doesn't divide evenly
    buckets = _split_case_ids(ids, "fixed-seed", cumulative)
    assert sorted(cid for bucket in buckets for cid in bucket) == sorted(ids)
    assert sum(len(b) for b in buckets) == len(ids)


def test_split_case_ids_mostly_stable_when_new_ids_join_the_pool() -> None:
    """Not perfectly stable like a per-case-independent hash draw would
    be, but close: growing the pool only moves cases whose rank lands
    near a cut boundary, not an arbitrary reshuffle."""
    cumulative = [0.5, 1.0]
    original_ids = [f"case-{i}" for i in range(20)]
    original_buckets = _split_case_ids(original_ids, "fixed-seed", cumulative)
    original_assignment = {cid: i for i, bucket in enumerate(original_buckets) for cid in bucket}

    grown_ids = original_ids + [f"new-case-{i}" for i in range(2)]
    grown_buckets = _split_case_ids(grown_ids, "fixed-seed", cumulative)
    grown_assignment = {cid: i for i, bucket in enumerate(grown_buckets) for cid in bucket}

    moved = [cid for cid in original_ids if grown_assignment[cid] != original_assignment[cid]]
    assert len(moved) <= 2  # only boundary-adjacent cases can move, not most of the 20


def test_split_case_ids_different_seed_gives_different_split() -> None:
    cumulative = [0.5, 1.0]
    ids = [f"case-{i}" for i in range(50)]
    split_a = _split_case_ids(ids, "seed-a", cumulative)
    split_b = _split_case_ids(ids, "seed-b", cumulative)
    assert split_a != split_b


def test_split_case_ids_supports_n_way_split() -> None:
    cumulative = _cumulative_ratios([{"ratio": 1}, {"ratio": 1}, {"ratio": 1}])
    ids = [f"case-{i}" for i in range(201)]
    buckets = _split_case_ids(ids, "fixed-seed", cumulative)
    assert [len(b) for b in buckets] == [67, 67, 67]


def test_split_parts_requires_at_least_two() -> None:
    with pytest.raises(HTTPException):
        _split_parts({"parts": [{"name": "Only one", "ratio": 1.0}]})
    with pytest.raises(HTTPException):
        _split_parts({})


def test_split_parts_returns_the_configured_list() -> None:
    parts = [{"name": "A", "ratio": 0.5}, {"name": "B", "ratio": 0.5}]
    assert _split_parts({"parts": parts}) == parts


def test_matches_filter_tag_criterion() -> None:
    config = {"criterion_type": "tag", "tag": "priority"}
    assert _matches_filter(["priority", "urgent"], config) is True
    assert _matches_filter(["urgent"], config) is False
    assert _matches_filter([], config) is False


def test_matches_filter_unknown_criterion_type_matches_nothing() -> None:
    assert _matches_filter(["priority"], {"criterion_type": "unknown"}) is False


def test_dedupe_sorted_removes_duplicates_and_sorts() -> None:
    assert _dedupe_sorted(["b", "a", "b", "c", "a"]) == ["a", "b", "c"]


def test_dedupe_sorted_empty_input() -> None:
    assert _dedupe_sorted([]) == []


def test_is_stale_true_when_source_ran_after_card() -> None:
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    later = now + timedelta(minutes=5)
    assert _is_stale(card_last_run_at=now, source_last_run_at=later) is True


def test_is_stale_false_when_card_ran_after_source() -> None:
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    later = now + timedelta(minutes=5)
    assert _is_stale(card_last_run_at=later, source_last_run_at=now) is False


def test_is_stale_true_when_card_never_ran_but_source_did() -> None:
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert _is_stale(card_last_run_at=None, source_last_run_at=now) is True


def test_is_stale_false_when_source_never_ran() -> None:
    """A Dataset card (which is never Run) can never make a downstream
    card look stale -- there's simply no run timestamp to compare."""
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert _is_stale(card_last_run_at=now, source_last_run_at=None) is False
    assert _is_stale(card_last_run_at=None, source_last_run_at=None) is False


def _entry(status: AnnotationStatus):
    return ("annotation-id", status, datetime(2026, 1, 1, tzinfo=timezone.utc))


def test_case_status_pending_when_no_annotation_exists() -> None:
    assert _case_status(None, review=False) == "pending"
    assert _case_status(None, review=True) == "pending"


def test_case_status_rejected_takes_priority_for_both_card_types() -> None:
    entry = _entry(AnnotationStatus.REJECTED)
    assert _case_status(entry, review=False) == "rejected"
    assert _case_status(entry, review=True) == "rejected"


def test_case_status_submitted_is_done_for_annotation_but_pending_for_review() -> None:
    """A Review card doesn't consider a case "done" until *it* has
    decided -- a bare SUBMITTED (awaiting that decision) stays "pending"
    there even though the annotator's own job already counts it done."""
    entry = _entry(AnnotationStatus.SUBMITTED)
    assert _case_status(entry, review=False) == "done"
    assert _case_status(entry, review=True) == "pending"


def test_case_status_approved_is_done_for_both_card_types() -> None:
    entry = _entry(AnnotationStatus.APPROVED)
    assert _case_status(entry, review=False) == "done"
    assert _case_status(entry, review=True) == "done"


def test_case_status_draft_only_is_pending_for_both_card_types() -> None:
    entry = _entry(AnnotationStatus.DRAFT)
    assert _case_status(entry, review=False) == "pending"
    assert _case_status(entry, review=True) == "pending"


class _FakeCard:
    def __init__(self, type_: WorkflowCardType) -> None:
        self.type = type_


def test_output_count_flat_list() -> None:
    card = _FakeCard(WorkflowCardType.FILTER)
    assert _output_count(card, ["a", "b", "c"]) == 3


def test_output_count_split_shape() -> None:
    card = _FakeCard(WorkflowCardType.SPLIT)
    assert _output_count(card, {"part_0": ["a", "b"], "part_1": ["c"]}) == {"part_0": 2, "part_1": 1}


def test_output_count_split_n_way_shape() -> None:
    card = _FakeCard(WorkflowCardType.SPLIT)
    assert _output_count(card, {"part_0": ["a"], "part_1": ["b"], "part_2": ["c", "d"]}) == {
        "part_0": 1,
        "part_1": 1,
        "part_2": 2,
    }


def test_output_count_none_when_never_run() -> None:
    card = _FakeCard(WorkflowCardType.UNION)
    assert _output_count(card, None) is None


# _detect_create_dataset_intent/_mock_llm_reply (the keyword-matched
# mock) were removed once the Clinical Trial module got a real model +
# MCP server -- see test_llm_client.py for the real chat loop's own
# pure-function tests.


def test_job_status_annotation_todo_when_every_case_is_untouched() -> None:
    latest_per_case: dict = {}
    assert _job_status_from_entries(["c1", "c2"], latest_per_case, review=False) == "todo"


def test_job_status_annotation_todo_with_no_cases_at_all() -> None:
    assert _job_status_from_entries([], {}, review=False) == "todo"


def test_job_status_annotation_done_when_every_case_is_submitted_or_approved() -> None:
    latest_per_case = {"c1": _entry(AnnotationStatus.SUBMITTED), "c2": _entry(AnnotationStatus.APPROVED)}
    assert _job_status_from_entries(["c1", "c2"], latest_per_case, review=False) == "done"


def test_job_status_annotation_in_progress_when_a_draft_is_mixed_in() -> None:
    latest_per_case = {"c1": _entry(AnnotationStatus.SUBMITTED), "c2": _entry(AnnotationStatus.DRAFT)}
    assert _job_status_from_entries(["c1", "c2"], latest_per_case, review=False) == "in_progress"


def test_job_status_annotation_in_progress_when_a_case_is_rejected() -> None:
    latest_per_case = {"c1": _entry(AnnotationStatus.SUBMITTED), "c2": _entry(AnnotationStatus.REJECTED)}
    assert _job_status_from_entries(["c1", "c2"], latest_per_case, review=False) == "in_progress"


def test_job_status_annotation_in_progress_when_some_done_and_some_never_touched() -> None:
    """Not literally spelled out by the "in-progress-or-rejected" rule,
    but a job with 1 of 3 cases already annotated is clearly under way,
    not "todo" -- anything short of *every* case being untouched or
    *every* case being done falls to in_progress."""
    latest_per_case = {"c1": _entry(AnnotationStatus.APPROVED)}
    assert _job_status_from_entries(["c1", "c2", "c3"], latest_per_case, review=False) == "in_progress"


def test_job_status_annotation_looks_up_case_ids_as_uuid_objects() -> None:
    """Regression test: card.output_case_ids (JSONB) comes back as plain
    strings, but _latest_annotation_per_case's dict is keyed by the
    native UUID objects the DB query returns -- a naive `dict.get(cid)`
    using the string case_ids directly always misses, silently making
    every case look untouched (a real bug found while verifying this
    against live data: a job with a draft and two done cases came back
    "todo" instead of "in_progress")."""
    import uuid

    cid = uuid.uuid4()
    latest_per_case = {cid: _entry(AnnotationStatus.APPROVED)}
    assert _job_status_from_entries([str(cid)], latest_per_case, review=False) == "done"


def test_job_status_review_todo_when_nothing_has_ever_been_submitted() -> None:
    assert _job_status_from_entries(["c1"], {}, review=True) == "todo"


def test_job_status_review_in_progress_when_a_case_is_awaiting_a_decision() -> None:
    latest_per_case = {"c1": _entry(AnnotationStatus.APPROVED), "c2": _entry(AnnotationStatus.SUBMITTED)}
    assert _job_status_from_entries(["c1", "c2"], latest_per_case, review=True) == "in_progress"


def test_job_status_review_done_when_everything_submitted_is_approved_or_rejected() -> None:
    latest_per_case = {"c1": _entry(AnnotationStatus.APPROVED), "c2": _entry(AnnotationStatus.REJECTED)}
    assert _job_status_from_entries(["c1", "c2"], latest_per_case, review=True) == "done"


def test_job_status_review_done_when_everything_is_rejected() -> None:
    latest_per_case = {"c1": _entry(AnnotationStatus.REJECTED)}
    assert _job_status_from_entries(["c1"], latest_per_case, review=True) == "done"
