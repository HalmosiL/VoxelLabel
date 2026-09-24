"""Pure aggregation over pipeline "legs" -- one entry per (card, case)
that has a known queue-start (see CaseStageEvent). A leg covers exactly
one Annotation or Review card's own handling of one case: how long it
sat unqueued-and-untouched (queue), then how long it took once someone
opened it until the card's terminal action -- SUBMITTED for an
Annotation card, a decision for a Review card (work). A case's full
Annotation-then-Review cycle is two legs, not stitched into one row
(that would need walking workflow edges to pair an Annotation card with
its downstream Review card) -- summed medians across both card types
already give the four numbers a cycle-time view needs.

No database, no clock in the aggregate functions themselves (`now` is
always passed in) -- deterministic over the input, so
tests/test_pipeline_health_stats.py can pin every figure down on a
hand-written leg list, the same shape app/usage/stats.py's tests use."""
from collections import defaultdict
from datetime import datetime, timedelta
from statistics import mean, median

MIN_HISTORY_FOR_MEDIAN = 5
FALLBACK_FLAG_AFTER = timedelta(days=7)
FLAG_MULTIPLE = 2


def _ms(delta: timedelta) -> int:
    return int(delta.total_seconds() * 1000)


def leg_summary(legs: list[dict]) -> dict:
    """Per card type ("annotation"/"review"), the median/mean of queue_ms
    and work_ms over only the legs where that duration is actually
    known (an open leg's missing half doesn't count as zero)."""
    by_type: dict[str, dict[str, list[int]]] = defaultdict(lambda: {"queue_ms": [], "work_ms": []})
    for leg in legs:
        bucket = by_type[leg["card_type"]]
        if leg.get("queue_ms") is not None:
            bucket["queue_ms"].append(leg["queue_ms"])
        if leg.get("work_ms") is not None:
            bucket["work_ms"].append(leg["work_ms"])

    def stat(values: list[int]) -> dict:
        return {"count": len(values), "median_ms": int(median(values)) if values else None, "mean_ms": int(mean(values)) if values else None}

    return {card_type: {"queue": stat(b["queue_ms"]), "work": stat(b["work_ms"])} for card_type, b in by_type.items()}


def review_quality(legs: list[dict], since: datetime, until: datetime) -> dict:
    """How often an annotated case passes review first time, over the
    annotation legs whose first review decision fell in the window: the
    share approved first time, the share sent back at least once, and
    for approved cases how many submissions it took. Rework is the most
    expensive kind of cycle time -- the whole case goes round again."""
    decided = [leg["quality"] for leg in legs if leg.get("quality") and leg["quality"]["decided_at"] is not None and since <= leg["quality"]["decided_at"] <= until]
    approved = [q for q in decided if q["approved"]]
    return {
        "decided": len(decided),
        "first_pass_rate": round(sum(1 for q in decided if q["first_pass"]) / len(decided), 3) if decided else None,
        "sent_back_rate": round(sum(1 for q in decided if q["rejections"] > 0) / len(decided), 3) if decided else None,
        "rounds_to_approve": round(mean(1 + q["rejections"] for q in approved), 2) if approved else None,
    }


def _card_medians(legs: list[dict]) -> dict[tuple, dict[str, int | None]]:
    """(card_id, leg_kind) -> that card's own median duration, only when
    at least MIN_HISTORY_FOR_MEDIAN completed samples exist -- the
    statistical half of the bottleneck threshold; None means "not
    enough history yet, use the flat fallback"."""
    values: dict[tuple, list[int]] = defaultdict(list)
    for leg in legs:
        if leg.get("queue_ms") is not None:
            values[(leg["card_id"], "queue")].append(leg["queue_ms"])
        if leg.get("work_ms") is not None:
            values[(leg["card_id"], "work")].append(leg["work_ms"])
    return {key: (int(median(v)) if len(v) >= MIN_HISTORY_FOR_MEDIAN else None) for key, v in values.items()}


def bottlenecks(legs: list[dict], now: datetime) -> list[dict]:
    """Every leg still open (queued-but-untouched, or touched-but-not-
    yet-decided) with how long it's been waiting so far, ranked against
    that exact card's own historical median for the same kind of wait
    (>= MIN_HISTORY_FOR_MEDIAN completed legs), falling back to a flat
    FALLBACK_FLAG_AFTER when a card doesn't have enough history yet --
    a brand-new job shouldn't report zero bottlenecks just because
    nothing has ever finished on it. `flagged` is True once the wait
    exceeds FLAG_MULTIPLE times the threshold. Longest-waiting first."""
    card_medians = _card_medians(legs)
    rows = []
    for leg in legs:
        # A leg with its terminal action is finished, touched or not: a
        # review decided from the admin-ui or the API has no recorded
        # viewer visit, so no first touch, and used to be listed as still
        # waiting for the reviewer (H-04).
        if leg.get("terminal_at") is not None:
            continue
        if leg.get("first_touch") is None:
            kind, since, baseline_key = "queue", leg["queue_start"], (leg["card_id"], "queue")
        else:
            kind, since, baseline_key = "work", leg["first_touch"], (leg["card_id"], "work")
        waiting_ms = _ms(now - since)
        baseline_ms = card_medians.get(baseline_key)
        threshold_ms = baseline_ms * FLAG_MULTIPLE if baseline_ms is not None else _ms(FALLBACK_FLAG_AFTER)
        rows.append(
            {
                "card_id": leg["card_id"],
                "card_type": leg["card_type"],
                "case_id": leg["case_id"],
                "case_title": leg.get("case_title"),
                "assignee_id": leg.get("assignee_id"),
                "kind": kind,
                "waiting_ms": waiting_ms,
                "baseline_ms": baseline_ms,
                "flagged": waiting_ms > threshold_ms,
            }
        )
    rows.sort(key=lambda r: -r["waiting_ms"])
    return rows


def assignee_load(legs: list[dict]) -> list[dict]:
    """Per assignee, how many legs are currently open and how old the
    oldest one is -- who's sitting on a growing pile. `now` isn't
    needed here: age comparison between assignees only needs the
    relative order, not the absolute wait."""
    open_since: dict[tuple[str, str], list[datetime]] = defaultdict(list)
    for leg in legs:
        if leg.get("assignee_id") is None:
            continue
        if leg.get("terminal_at") is not None:
            continue  # finished, even without a recorded first touch (H-04)
        since = leg["queue_start"] if leg.get("first_touch") is None else leg["first_touch"]
        open_since[(leg["assignee_id"], leg["card_type"])].append(since)
    rows = [
        {"assignee_id": assignee_id, "card_type": card_type, "open_count": len(times), "oldest_since": min(times)}
        for (assignee_id, card_type), times in open_since.items()
    ]
    rows.sort(key=lambda r: -r["open_count"])
    return rows


def learning_curve(legs: list[dict], tenure_start: dict[tuple[str, str], datetime]) -> list[dict]:
    """Each person's own work_ms values, bucketed by how many weeks into
    *their own* tenure (first tracked action of that same card_type --
    `tenure_start[(user_id, card_type)]`) each one happened. A flat or
    falling line across buckets is someone still getting faster; a flat
    line at a high value from week 1 onward is someone who reached
    their ceiling immediately -- either way it's about their own
    history, never compared to anyone else's."""
    buckets: dict[tuple[str, str, int], list[int]] = defaultdict(list)
    for leg in legs:
        if leg.get("work_ms") is None or leg.get("actor_id") is None or leg.get("terminal_at") is None:
            continue
        key = (leg["actor_id"], leg["card_type"])
        start = tenure_start.get(key)
        if start is None:
            continue
        week = max(int((leg["terminal_at"] - start).days // 7), 0)
        buckets[(leg["actor_id"], leg["card_type"], week)].append(leg["work_ms"])

    rows = [
        {"actor_id": actor_id, "card_type": card_type, "week": week, "median_ms": int(median(values)), "count": len(values)}
        for (actor_id, card_type, week), values in buckets.items()
    ]
    rows.sort(key=lambda r: (r["actor_id"], r["card_type"], r["week"]))
    return rows
