"""Unit tests for app/usage/findings.py -- every rule fires at its
threshold and not below it, with the right severity and tab, on
hand-built summary dicts (the shapes usage/stats.summarize and
pipeline_health's build_summary produce)."""
from app.usage import findings as f


def usage(**overrides) -> dict:
    base = {
        "totals": {"events": 100, "active_users": 2, "sessions": 5, "avg_session_ms": 60_000, "errors": 0},
        "tasks": {"annotate": {"count": 0, "median_ms": None, "mean_ms": None}, "review": {"count": 0, "median_ms": None, "mean_ms": None}},
        "routes": [],
        "transitions": [],
        "actions": [],
        "friction": {"bounces": [], "back_and_forth": [], "rage_clicks": [], "dead_clicks": [], "errors": [], "idle_share": 0.0, "by_screen": []},
        "users": [],
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            base[key] = {**base[key], **value}
        else:
            base[key] = value
    return base


def screen(route, *, views=20, clicks=20, bounce_rate=0.0, back_rate=0.0, dead_rate=0.0, rage_bursts=0, errors=0) -> dict:
    return {
        "route": route,
        "views": views,
        "clicks": clicks,
        "bounces": round(bounce_rate * views),
        "bounce_rate": bounce_rate,
        "returns": round(back_rate * views),
        "back_rate": back_rate,
        "dead_clicks": round(dead_rate * clicks),
        "dead_rate": dead_rate,
        "rage_bursts": rage_bursts,
        "errors": errors,
        "score": 0,
    }


def pipeline(**overrides) -> dict:
    base = {"legs": {}, "bottlenecks": [], "assignee_load": []}
    base.update(overrides)
    return base


def ids(result):
    return [x["id"] for x in result]


def test_no_events_gives_a_single_no_data_finding():
    result = f.findings(usage(totals={"events": 0}), None, None, None, None)
    assert ids(result) == ["no_data"] and result[0]["severity"] == "info" and result[0]["tab"] == "settings"


def test_nothing_wrong_gives_a_good_all_clear():
    result = f.findings(usage(), None, pipeline(), None, None)
    assert ids(result) == ["all_clear"] and result[0]["severity"] == "good"


def test_flagged_bottleneck_is_critical_and_points_at_friction():
    p = pipeline(
        bottlenecks=[
            {"card_id": "c", "card_type": "review", "case_id": "x", "case_title": "CT 12", "assignee": "dr-review", "kind": "work", "waiting_ms": 3 * 86_400_000, "baseline_ms": 3_600_000, "flagged": True},
            {"card_id": "c", "card_type": "review", "case_id": "y", "case_title": None, "assignee": None, "kind": "queue", "waiting_ms": 1000, "baseline_ms": None, "flagged": False},
        ]
    )
    result = f.findings(usage(), None, p, None, None)
    top = result[0]
    assert top["id"] == "bottlenecks.flagged" and top["severity"] == "critical" and top["tab"] == "friction"
    assert "1 case is stuck" in top["title"] and "CT 12" in top["detail"] and "72h 00m" in top["detail"] and "dr-review" in top["detail"]


def test_many_open_legs_without_history_warns_per_card():
    rows = [{"card_id": "c1", "card_type": "annotation", "case_id": str(i), "kind": "queue", "waiting_ms": 1, "baseline_ms": None, "flagged": False} for i in range(f.OPEN_LEGS_NO_HISTORY_WARN + 1)]
    result = f.findings(usage(), None, pipeline(bottlenecks=rows), None, None)
    assert "bottlenecks.open_no_history.c1" in ids(result)
    # exactly the threshold does not warn
    result = f.findings(usage(), None, pipeline(bottlenecks=rows[:-1]), None, None)
    assert "bottlenecks.open_no_history.c1" not in ids(result)


def test_cycle_time_trend_both_directions():
    now = pipeline(legs={"annotation": {"queue": {}, "work": {"median_ms": 120_000}}, "review": {"queue": {}, "work": {"median_ms": 50_000}}})
    prev = pipeline(legs={"annotation": {"queue": {}, "work": {"median_ms": 100_000}}, "review": {"queue": {}, "work": {"median_ms": 100_000}}})
    result = {x["id"]: x for x in f.findings(usage(), None, now, prev, None)}
    assert result["cycle.slower.annotation"]["severity"] == "warn" and "20% slower" in result["cycle.slower.annotation"]["title"]
    assert result["cycle.faster.review"]["severity"] == "good" and "50% faster" in result["cycle.faster.review"]["title"]
    # just under the threshold: silent
    prev_close = pipeline(legs={"annotation": {"queue": {}, "work": {"median_ms": 110_000}}, "review": {"queue": {}, "work": {"median_ms": 50_000}}})
    assert not [i for i in ids(f.findings(usage(), None, now, prev_close, None)) if i.startswith("cycle.")]


def test_screen_rules_fire_at_thresholds_with_enough_traffic():
    u = usage(
        friction={
            "by_screen": [
                screen("/a", views=10, bounce_rate=0.30),
                screen("/b", views=9, bounce_rate=0.90),  # too few views
                screen("/c", rage_bursts=3),
                screen("/d", clicks=10, dead_rate=0.30),
                screen("/e", clicks=9, dead_rate=0.90),  # too few clicks
                screen("/f", views=10, back_rate=0.25),
            ]
        }
    )
    got = ids(f.findings(u, None, pipeline(), None, None))
    assert {"screen.bounce./a", "screen.rage./c", "screen.dead./d", "screen.back./f"} <= set(got)
    assert not any(i.endswith("/b") or i.endswith("/e") for i in got)
    assert all(x["tab"] == "friction" for x in f.findings(u, None, pipeline(), None, None) if x["id"].startswith("screen."))


def test_errors_escalate_when_many_or_rising():
    assert f.findings(usage(totals={"errors": 1}), None, pipeline(), None, None)[0]["severity"] == "warn"
    assert f.findings(usage(totals={"errors": f.ERRORS_CRITICAL}), None, pipeline(), None, None)[0]["severity"] == "critical"
    rising = f.findings(usage(totals={"errors": 2}), usage(totals={"errors": 1}), pipeline(), None, None)[0]
    assert rising["severity"] == "critical" and "Up from 1" in rising["detail"]


def test_idle_share_is_informational():
    result = f.findings(usage(friction={"idle_share": 0.4}), None, pipeline(), None, None)
    assert result[0]["id"] == "idle" and result[0]["severity"] == "info" and result[0]["tab"] == "behaviour"
    assert "idle" not in ids(f.findings(usage(friction={"idle_share": 0.39}), None, pipeline(), None, None))


def test_load_imbalance_needs_two_people_and_a_dominant_share():
    balanced = pipeline(assignee_load=[{"assignee_id": "a", "assignee": "A", "card_type": "annotation", "open_count": 5}, {"assignee_id": "b", "assignee": "B", "card_type": "annotation", "open_count": 5}])
    lopsided = pipeline(assignee_load=[{"assignee_id": "a", "assignee": "A", "card_type": "annotation", "open_count": 7}, {"assignee_id": "b", "assignee": "B", "card_type": "annotation", "open_count": 3}])
    alone = pipeline(assignee_load=[{"assignee_id": "a", "assignee": "A", "card_type": "annotation", "open_count": 10}])
    assert "load.imbalance.annotation" not in ids(f.findings(usage(), None, balanced, None, None))
    assert "load.imbalance.annotation" not in ids(f.findings(usage(), None, alone, None, None))
    hit = {x["id"]: x for x in f.findings(usage(), None, lopsided, None, None)}["load.imbalance.annotation"]
    assert hit["severity"] == "warn" and "A holds 70%" in hit["title"]


def test_learning_curve_flat_vs_improving():
    flat = [
        {"actor_id": "u1", "username": "dr-a", "card_type": "annotation", "week": 0, "median_ms": 60_000, "count": 3},
        {"actor_id": "u1", "username": "dr-a", "card_type": "annotation", "week": 2, "median_ms": 65_000, "count": 3},
    ]
    faster = [
        {"actor_id": "u2", "username": "dr-b", "card_type": "review", "week": 0, "median_ms": 60_000, "count": 3},
        {"actor_id": "u2", "username": "dr-b", "card_type": "review", "week": 3, "median_ms": 30_000, "count": 3},
    ]
    too_new = [
        {"actor_id": "u3", "username": "dr-c", "card_type": "annotation", "week": 0, "median_ms": 60_000, "count": 3},
        {"actor_id": "u3", "username": "dr-c", "card_type": "annotation", "week": 1, "median_ms": 90_000, "count": 3},
    ]
    result = {x["id"]: x for x in f.findings(usage(), None, pipeline(), None, flat + faster + too_new)}
    assert result["learning.flat.u1.annotation"]["severity"] == "info" and result["learning.flat.u1.annotation"]["tab"] == "people"
    assert result["learning.faster.u2.review"]["severity"] == "good" and "50% faster" in result["learning.faster.u2.review"]["title"]
    assert not any(i.endswith("u3.annotation") for i in result)


def test_unused_viewer_tools_are_listed_only_when_the_viewer_was_used():
    used = usage(actions=[{"name": "tool.paint", "count": 5}, {"name": "tool.cursor", "count": 9}, {"name": "save", "count": 2}])
    hit = {x["id"]: x for x in f.findings(used, None, pipeline(), None, None)}["tools.unused"]
    assert hit["severity"] == "info" and hit["evidence"]["unused"] == ["erase", "fill", "polygon", "auto", "histogram"]
    assert "tools.unused" not in ids(f.findings(usage(actions=[{"name": "save", "count": 2}]), None, pipeline(), None, None))


def test_findings_are_ordered_by_severity():
    u = usage(totals={"errors": 1}, friction={"idle_share": 0.5})
    p = pipeline(bottlenecks=[{"card_id": "c", "card_type": "review", "case_id": "x", "case_title": "T", "assignee": "R", "kind": "work", "waiting_ms": 1, "baseline_ms": 1, "flagged": True}])
    assert [x["severity"] for x in f.findings(u, None, p, None, None)] == ["critical", "warn", "info"]


def test_friction_score_is_view_weighted():
    u = usage(friction={"by_screen": [screen("/a", views=30) | {"score": 10}, screen("/b", views=10) | {"score": 50}]})
    assert f.friction_score(u) == 20  # (10*30 + 50*10) / 40
    assert f.friction_score(usage()) is None
