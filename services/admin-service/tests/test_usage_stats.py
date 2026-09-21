"""Unit tests for app/usage/stats.py and settings.effective_config --
the pure aggregation the Usage page draws from, pinned down on a small
hand-written event list. No DB, no clock."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.usage import stats
from app.usage.settings import allows, effective_config

T0 = datetime(2026, 9, 20, 9, 0, tzinfo=timezone.utc)
ALICE, BOB = "user-alice", "user-bob"


def ev(session, kind, route, *, at_s=0.0, user=ALICE, app="admin-ui", name=None, detail=None, duration_ms=None):
    return {
        "user_id": user,
        "session_id": session,
        "app": app,
        "event_type": kind,
        "route": route,
        "name": name,
        "detail": detail,
        "duration_ms": duration_ms,
        "occurred_at": T0 + timedelta(seconds=at_s),
    }


def _alice_session():
    """Alice: studies -> a study -> back to studies (a return), then the
    viewer where she annotates after 40 s; one bounce, a rage-click
    burst, a dead click, an idle gap and an error."""
    s = "s-alice"
    return [
        ev(s, "page_view", "/studies", at_s=0, detail={"viewport": [1600, 900]}),
        ev(s, "click", "/studies", at_s=1, detail={"x": 100, "y": 100, "viewport": [1600, 900], "target": "row"}),
        ev(s, "page_leave", "/studies", at_s=2, duration_ms=2000),  # bounce: < 3 s, then another page
        ev(s, "page_view", "/studies/:id", at_s=2),
        ev(s, "page_leave", "/studies/:id", at_s=12, duration_ms=10000),
        ev(s, "page_view", "/studies", at_s=12),  # A -> B -> A
        ev(s, "page_leave", "/studies", at_s=20, duration_ms=8000),
        ev(s, "page_view", "/viewer/:id", at_s=20, app="viewer"),
        ev(s, "action", "/viewer/:id", at_s=25, app="viewer", name="tool.paint"),
        # three clicks within 500 ms, 10 px apart: one rage burst
        ev(s, "click", "/viewer/:id", at_s=30.0, app="viewer", detail={"x": 500, "y": 500, "viewport": [1600, 900]}),
        ev(s, "click", "/viewer/:id", at_s=30.2, app="viewer", detail={"x": 505, "y": 505, "viewport": [1600, 900]}),
        ev(s, "click", "/viewer/:id", at_s=30.4, app="viewer", detail={"x": 510, "y": 510, "viewport": [1600, 900]}),
        # a lone click nothing follows within 2 s: dead
        ev(s, "click", "/viewer/:id", at_s=40, app="viewer", detail={"x": 50, "y": 50, "viewport": [1600, 900]}),
        ev(s, "mouse_trace", "/viewer/:id", at_s=50, app="viewer", detail={"points": [[0, 0, 0], [100, 30, 40], [200, 30, 40]]}),
        ev(s, "idle", "/viewer/:id", at_s=55, app="viewer", duration_ms=5000),
        ev(s, "action", "/viewer/:id", at_s=60, app="viewer", name="mark_annotated"),
        ev(s, "error", "/viewer/:id", at_s=61, app="viewer", detail={"message": "boom"}),
        ev(s, "page_leave", "/viewer/:id", at_s=70, app="viewer", duration_ms=50000),
    ]


def _bob_session():
    s = "s-bob"
    return [
        ev(s, "page_view", "/my-jobs", at_s=100, user=BOB),
        ev(s, "page_leave", "/my-jobs", at_s=110, user=BOB, duration_ms=10000),
        ev(s, "page_view", "/viewer/:id", at_s=110, user=BOB, app="viewer"),
        ev(s, "action", "/viewer/:id", at_s=130, user=BOB, app="viewer", name="submit_review"),
        ev(s, "page_leave", "/viewer/:id", at_s=140, user=BOB, app="viewer", duration_ms=30000),
    ]


EVENTS = _alice_session() + _bob_session()


def test_sessions_are_grouped_and_measured_newest_first():
    rows = stats.sessions(EVENTS)
    assert [s["session_id"] for s in rows] == ["s-bob", "s-alice"]
    alice = rows[1]
    assert alice["user_id"] == ALICE and alice["duration_ms"] == 70000
    assert alice["page_views"] == 4 and alice["actions"] == 2 and alice["clicks"] == 5 and alice["errors"] == 1
    assert alice["routes"] == ["/studies", "/studies/:id", "/studies", "/viewer/:id"]


def test_time_per_route_sums_dwell_and_counts_views():
    rows = {r["route"]: r for r in stats.time_per_route(EVENTS)}
    assert rows["/viewer/:id"] == {"route": "/viewer/:id", "views": 2, "total_ms": 80000, "avg_ms": 40000}
    assert rows["/studies"]["views"] == 2 and rows["/studies"]["total_ms"] == 10000
    assert stats.time_per_route(EVENTS)[0]["route"] == "/viewer/:id"  # most time first


def test_transitions_count_consecutive_page_pairs():
    rows = {(r["from"], r["to"]): r for r in stats.transitions(EVENTS)}
    assert rows[("/studies", "/studies/:id")]["count"] == 1
    assert rows[("/studies/:id", "/studies")]["count"] == 1
    assert rows[("/studies", "/viewer/:id")]["sessions"] == 1
    assert rows[("/my-jobs", "/viewer/:id")]["count"] == 1


def test_back_and_forth_counts_returns_to_the_page_two_steps_back():
    assert stats.back_and_forth(["/a", "/b", "/a", "/c"]) == (1, 3)
    assert stats.back_and_forth(["/a", "/b"]) == (0, 1)
    assert stats.back_and_forth([]) == (0, 0)


def test_action_counts_are_sorted_by_count():
    assert stats.action_counts(EVENTS) == [
        {"name": "mark_annotated", "count": 1},
        {"name": "submit_review", "count": 1},
        {"name": "tool.paint", "count": 1},
    ]


def test_task_durations_pair_viewer_open_with_the_finishing_action():
    tasks = stats.task_durations(EVENTS)
    assert tasks["annotate"] == {"count": 1, "median_ms": 40000, "mean_ms": 40000}
    assert tasks["review"] == {"count": 1, "median_ms": 20000, "mean_ms": 20000}


def test_task_durations_ignore_actions_without_a_viewer_page():
    events = [ev("s", "page_view", "/studies"), ev("s", "action", "/studies", at_s=5, name="mark_annotated")]
    assert stats.task_durations(events)["annotate"]["count"] == 0


def test_friction_signals():
    f = stats.friction(EVENTS)
    assert f["bounces"] == [{"route": "/studies", "bounces": 1, "rate": 0.5}]
    assert f["back_and_forth"] == [{"route": "/studies", "returns": 1, "rate": 0.5}]
    assert f["rage_clicks"] == [{"route": "/viewer/:id", "bursts": 1}]
    # the lone click at 40 s (nothing within 2 s) -- the burst's clicks
    # are followed by nothing either, so they count as dead too
    assert f["dead_clicks"] == [{"route": "/viewer/:id", "clicks": 4}]
    assert f["errors"] == [{"route": "/viewer/:id", "errors": 1}]
    # 5 s idle out of 70 s (alice) + 40 s (bob)
    assert f["idle_share"] == round(5000 / 110000, 3)


def test_rage_clicks_need_three_fast_clicks_in_the_same_spot():
    far = [
        ev("s", "click", "/x", at_s=0.0, detail={"x": 0, "y": 0}),
        ev("s", "click", "/x", at_s=0.1, detail={"x": 200, "y": 0}),
        ev("s", "click", "/x", at_s=0.2, detail={"x": 400, "y": 0}),
    ]
    slow = [
        ev("s", "click", "/x", at_s=0.0, detail={"x": 0, "y": 0}),
        ev("s", "click", "/x", at_s=1.0, detail={"x": 0, "y": 0}),
        ev("s", "click", "/x", at_s=2.0, detail={"x": 0, "y": 0}),
    ]
    assert stats.friction(far)["rage_clicks"] == []
    assert stats.friction(slow)["rage_clicks"] == []


def test_mouse_distance_sums_trace_segments():
    assert stats.mouse_distance(EVENTS) == 50.0  # (0,0)->(30,40) is 50, then no movement


def test_per_user_figures():
    users = {u["user_id"]: u for u in stats.per_user(EVENTS)}
    alice, bob = users[ALICE], users[BOB]
    assert alice["sessions"] == 1 and alice["total_ms"] == 70000 and alice["page_views"] == 4
    assert alice["pages_per_session"] == 4.0
    assert alice["avg_dwell_ms"] == int((2000 + 10000 + 8000 + 50000) / 4)
    assert alice["back_and_forth"] == round(1 / 3, 3)
    assert alice["clicks"] == 5 and alice["mouse_px_per_page"] == 12  # 50 px / 4 pages
    assert alice["annotated"] == 1 and alice["reviewed"] == 0 and alice["errors"] == 1
    assert bob["reviewed"] == 1 and bob["annotated"] == 0 and bob["clicks_per_min"] == 0.0
    assert stats.per_user(EVENTS)[0]["user_id"] == ALICE  # most time first


def test_click_points_normalise_by_viewport_and_skip_incomplete_ones():
    points = stats.click_points(EVENTS, "/studies")
    assert points == [{"x": round(100 / 1600, 4), "y": round(100 / 900, 4), "target": "row"}]
    no_viewport = [ev("s", "click", "/x", detail={"x": 1, "y": 1})]
    assert stats.click_points(no_viewport, "/x") == []


def test_summarize_totals():
    summary = stats.summarize(EVENTS)
    assert summary["totals"] == {"events": len(EVENTS), "active_users": 2, "sessions": 2, "avg_session_ms": 55000, "errors": 1}
    assert {u["user_id"] for u in summary["users"]} == {ALICE, BOB}
    assert stats.summarize([])["totals"]["sessions"] == 0


def _settings(**overrides):
    base = dict(
        enabled=True, track_pages=True, track_actions=True, track_clicks=True, track_mouse=True,
        track_scroll=True, track_keys=True, track_errors=True, mouse_sample_ms=100, disabled_user_ids=[],
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_effective_config_applies_master_switch_and_user_exclusion():
    on = effective_config(_settings(), ALICE)
    assert on["enabled"] is True and on["track_mouse"] is True and on["mouse_sample_ms"] == 100
    off_for_alice = effective_config(_settings(disabled_user_ids=[ALICE]), ALICE)
    assert off_for_alice["enabled"] is False and not any(off_for_alice[f] for f in ("track_pages", "track_mouse"))
    assert effective_config(_settings(disabled_user_ids=[ALICE]), BOB)["enabled"] is True
    master_off = effective_config(_settings(enabled=False), BOB)
    assert master_off["enabled"] is False and master_off["track_actions"] is False
    no_mouse = effective_config(_settings(track_mouse=False), ALICE)
    assert no_mouse["enabled"] is True and no_mouse["track_mouse"] is False and no_mouse["track_clicks"] is True


def test_allows_maps_event_types_to_their_switch():
    config = effective_config(_settings(track_mouse=False, track_keys=False), ALICE)
    assert allows(config, "page_view") and allows(config, "idle") and allows(config, "click")
    assert not allows(config, "mouse_trace") and not allows(config, "key")
    assert not allows(config, "made_up")
