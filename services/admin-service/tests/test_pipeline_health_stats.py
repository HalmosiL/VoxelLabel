"""Unit tests for app/pipeline_health/stats.py -- pure aggregation over
hand-built "legs" (one entry per (card, case) with a known queue-start;
see the module's own docstring). No DB, no clock (now/tenure are always
passed in), mirroring tests/test_usage_stats.py's style."""
from datetime import datetime, timedelta, timezone

from app.pipeline_health import stats

T0 = datetime(2026, 9, 21, 9, 0, tzinfo=timezone.utc)
ALICE, BOB = "user-alice", "user-bob"
ANNOT_CARD, REVIEW_CARD = "card-annot", "card-review"


def leg(card_id, card_type, case_id, *, queue_start_h=0, first_touch_h=None, terminal_h=None, assignee=None, actor=None):
    queue_start = T0 + timedelta(hours=queue_start_h)
    first_touch = T0 + timedelta(hours=first_touch_h) if first_touch_h is not None else None
    terminal_at = T0 + timedelta(hours=terminal_h) if terminal_h is not None else None
    return {
        "card_id": card_id,
        "card_type": card_type,
        "case_id": case_id,
        "case_title": f"case {case_id}",
        "assignee_id": assignee,
        "queue_start": queue_start,
        "first_touch": first_touch,
        "terminal_at": terminal_at,
        "actor_id": actor,
        "queue_ms": int((first_touch - queue_start).total_seconds() * 1000) if first_touch else None,
        "work_ms": int((terminal_at - first_touch).total_seconds() * 1000) if (first_touch and terminal_at) else None,
    }


def test_leg_summary_only_counts_known_durations_per_card_type():
    legs = [
        leg(ANNOT_CARD, "annotation", "c1", queue_start_h=0, first_touch_h=1, terminal_h=3),  # queue 1h, work 2h
        leg(ANNOT_CARD, "annotation", "c2", queue_start_h=0, first_touch_h=2, terminal_h=5),  # queue 2h, work 3h
        leg(ANNOT_CARD, "annotation", "c3", queue_start_h=0, first_touch_h=None),  # still queued -- excluded from both
        leg(REVIEW_CARD, "review", "c1", queue_start_h=0, first_touch_h=1, terminal_h=2),  # queue 1h, work 1h
    ]
    summary = stats.leg_summary(legs)
    assert summary["annotation"]["queue"] == {"count": 2, "median_ms": 5_400_000, "mean_ms": 5_400_000}  # (1h+2h)/2
    assert summary["annotation"]["work"] == {"count": 2, "median_ms": 9_000_000, "mean_ms": 9_000_000}  # (2h+3h)/2
    assert summary["review"]["queue"]["count"] == 1 and summary["review"]["work"]["count"] == 1


def test_bottlenecks_lists_only_open_legs_longest_first():
    now = T0 + timedelta(hours=10)
    legs = [
        leg(ANNOT_CARD, "annotation", "done", queue_start_h=0, first_touch_h=1, terminal_h=2),  # finished -- not a bottleneck
        leg(ANNOT_CARD, "annotation", "still-queued", queue_start_h=0),  # open in "queue" since hour 0 -> waiting 10h
        leg(ANNOT_CARD, "annotation", "in-progress", queue_start_h=0, first_touch_h=8),  # open in "work" since hour 8 -> waiting 2h
    ]
    rows = stats.bottlenecks(legs, now)
    assert [r["case_id"] for r in rows] == ["still-queued", "in-progress"]
    assert rows[0]["kind"] == "queue" and rows[0]["waiting_ms"] == 10 * 3_600_000
    assert rows[1]["kind"] == "work" and rows[1]["waiting_ms"] == 2 * 3_600_000


def test_bottlenecks_flags_against_the_cards_own_median_with_enough_history():
    now = T0 + timedelta(hours=100)
    # 5 completed queue legs on ANNOT_CARD, median queue = 2h
    completed = [leg(ANNOT_CARD, "annotation", f"done{i}", queue_start_h=0, first_touch_h=h, terminal_h=h + 1) for i, h in enumerate([1, 2, 2, 2, 3])]
    open_leg_ok = leg(ANNOT_CARD, "annotation", "waiting-a-bit", queue_start_h=96)  # waiting 4h < 2*2h threshold
    open_leg_flagged = leg(ANNOT_CARD, "annotation", "waiting-ages", queue_start_h=50)  # waiting 50h > 2*2h threshold
    rows = {r["case_id"]: r for r in stats.bottlenecks(completed + [open_leg_ok, open_leg_flagged], now)}
    assert rows["waiting-a-bit"]["baseline_ms"] == 2 * 3_600_000 and rows["waiting-a-bit"]["flagged"] is False
    assert rows["waiting-ages"]["flagged"] is True


def test_bottlenecks_falls_back_to_flat_week_without_enough_history():
    now = T0 + timedelta(days=10)
    # Only 2 completed legs -- fewer than MIN_HISTORY_FOR_MEDIAN (5)
    completed = [leg(ANNOT_CARD, "annotation", f"done{i}", queue_start_h=0, first_touch_h=1, terminal_h=2) for i in range(2)]
    just_under = leg(ANNOT_CARD, "annotation", "under", queue_start_h=(10 * 24 - 6))  # waiting 6h < 7d
    just_over = leg(ANNOT_CARD, "annotation", "over", queue_start_h=0)  # waiting 10d > 7d fallback
    rows = {r["case_id"]: r for r in stats.bottlenecks(completed + [just_under, just_over], now)}
    assert rows["under"]["baseline_ms"] is None and rows["under"]["flagged"] is False
    assert rows["over"]["baseline_ms"] is None and rows["over"]["flagged"] is True


def test_assignee_load_counts_open_legs_and_their_oldest_start():
    legs = [
        leg(ANNOT_CARD, "annotation", "c1", queue_start_h=0, assignee=ALICE),  # open (queued)
        leg(ANNOT_CARD, "annotation", "c2", queue_start_h=5, first_touch_h=6, assignee=ALICE),  # open (in progress)
        leg(ANNOT_CARD, "annotation", "c3", queue_start_h=0, first_touch_h=1, terminal_h=2, assignee=ALICE),  # finished -- not open
        leg(REVIEW_CARD, "review", "c4", queue_start_h=2, assignee=BOB),
        leg(ANNOT_CARD, "annotation", "c5", queue_start_h=0, assignee=None),  # unassigned -- excluded
    ]
    rows = {(r["assignee_id"], r["card_type"]): r for r in stats.assignee_load(legs)}
    assert rows[(ALICE, "annotation")]["open_count"] == 2
    assert rows[(ALICE, "annotation")]["oldest_since"] == T0
    assert rows[(BOB, "review")]["open_count"] == 1
    assert (None, "annotation") not in rows
    # most-loaded first
    assert stats.assignee_load(legs)[0]["assignee_id"] == ALICE


def test_learning_curve_buckets_by_weeks_since_the_persons_own_tenure_start():
    tenure_start = T0
    legs = [
        leg(ANNOT_CARD, "annotation", "c1", queue_start_h=0, first_touch_h=0, terminal_h=1, actor=ALICE),  # week 0
        leg(ANNOT_CARD, "annotation", "c2", queue_start_h=0, first_touch_h=int(9 * 24), terminal_h=int(9 * 24) + 1, actor=ALICE),  # ~week 1
        leg(REVIEW_CARD, "review", "c3", queue_start_h=0, first_touch_h=0, terminal_h=2, actor=BOB),
        leg(ANNOT_CARD, "annotation", "open", queue_start_h=0, actor=ALICE),  # not finished -- excluded
    ]
    tenure = {(ALICE, "annotation"): tenure_start, (BOB, "review"): tenure_start}
    rows = {(r["actor_id"], r["card_type"], r["week"]): r for r in stats.learning_curve(legs, tenure)}
    assert rows[(ALICE, "annotation", 0)]["median_ms"] == 3_600_000
    assert rows[(ALICE, "annotation", 1)]["median_ms"] == 3_600_000
    assert rows[(BOB, "review", 0)]["count"] == 1
    assert (ALICE, "annotation", 2) not in rows  # no data in that bucket


def test_learning_curve_skips_actors_with_no_known_tenure_start():
    legs = [leg(ANNOT_CARD, "annotation", "c1", queue_start_h=0, first_touch_h=0, terminal_h=1, actor="no-tenure-user")]
    assert stats.learning_curve(legs, {}) == []


def test_a_leg_decided_without_a_recorded_first_touch_is_not_open():
    """H-04: a review decided from the admin-ui or the API has no viewer
    page view, so no first touch -- it was listed as "waiting for a
    reviewer" (and flagged after a week, forever) although it is done."""
    now = T0 + timedelta(days=30)
    legs = [
        leg(REVIEW_CARD, "review", "approved-from-admin-ui", queue_start_h=0, terminal_h=1, assignee=BOB),
        leg(REVIEW_CARD, "review", "really-waiting", queue_start_h=0, assignee=BOB),
    ]
    assert [r["case_id"] for r in stats.bottlenecks(legs, now)] == ["really-waiting"]
    assert [r["open_count"] for r in stats.assignee_load(legs)] == [1]
