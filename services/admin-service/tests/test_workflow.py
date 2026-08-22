"""Unit tests for the workflow board's pure logic helpers -- the parts of
app/api/workflow.py that need no live DB or Keycloak. Run-time behavior
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
    _cumulative_ratios,
    _dedupe_sorted,
    _is_stale,
    _matches_filter,
    _output_count,
    _split_bucket_index,
    _split_parts,
)
from shared_models.models import WorkflowCardType


def test_cumulative_ratios_two_equal_parts() -> None:
    assert _cumulative_ratios([{"ratio": 0.5}, {"ratio": 0.5}]) == [0.5, 1.0]


def test_cumulative_ratios_normalizes_when_not_summing_to_one() -> None:
    # 1/3-ish then pinned to 1.0, not the raw (unnormalized) 2.0 total.
    boundaries = _cumulative_ratios([{"ratio": 1}, {"ratio": 1}])
    assert boundaries[-1] == 1.0
    assert 0.4 < boundaries[0] < 0.6


def test_split_bucket_index_is_deterministic_for_a_given_seed() -> None:
    cumulative = [0.5, 1.0]
    first = _split_bucket_index("case-1", "fixed-seed", cumulative)
    second = _split_bucket_index("case-1", "fixed-seed", cumulative)
    assert first == second


def test_split_bucket_index_distributes_roughly_by_ratio() -> None:
    cumulative = [0.5, 1.0]
    buckets = [_split_bucket_index(f"case-{i}", "fixed-seed", cumulative) for i in range(500)]
    first_part_fraction = buckets.count(0) / len(buckets)
    assert 0.4 < first_part_fraction < 0.6


def test_split_bucket_index_stable_when_new_ids_join_the_pool() -> None:
    """The whole point of hashing per case id (not shuffle-and-cut): a
    case's bucket never changes just because other cases were added."""
    cumulative = [0.7, 1.0]
    original_ids = [f"case-{i}" for i in range(20)]
    original_buckets = {cid: _split_bucket_index(cid, "fixed-seed", cumulative) for cid in original_ids}

    grown_ids = original_ids + [f"new-case-{i}" for i in range(5)]
    for cid in original_ids:
        assert _split_bucket_index(cid, "fixed-seed", cumulative) == original_buckets[cid]
    assert len(grown_ids) == 25  # sanity: the new ids really were added


def test_split_bucket_index_different_seed_gives_different_split() -> None:
    cumulative = [0.5, 1.0]
    ids = [f"case-{i}" for i in range(50)]
    split_a = {cid: _split_bucket_index(cid, "seed-a", cumulative) for cid in ids}
    split_b = {cid: _split_bucket_index(cid, "seed-b", cumulative) for cid in ids}
    assert split_a != split_b


def test_split_bucket_index_supports_n_way_split() -> None:
    cumulative = _cumulative_ratios([{"ratio": 1}, {"ratio": 1}, {"ratio": 1}])
    buckets = {_split_bucket_index(f"case-{i}", "fixed-seed", cumulative) for i in range(200)}
    assert buckets == {0, 1, 2}


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
