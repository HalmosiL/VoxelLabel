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
        "measured_clicks": clicks,
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
    now = pipeline(legs={"annotation": {"queue": {}, "work": {"median_ms": 120_000, "count": 5}}, "review": {"queue": {}, "work": {"median_ms": 50_000, "count": 5}}})
    prev = pipeline(legs={"annotation": {"queue": {}, "work": {"median_ms": 100_000, "count": 5}}, "review": {"queue": {}, "work": {"median_ms": 100_000, "count": 5}}})
    result = {x["id"]: x for x in f.findings(usage(), None, now, prev, None)}
    assert result["cycle.slower.annotation"]["severity"] == "warn" and "20% slower" in result["cycle.slower.annotation"]["title"]
    assert result["cycle.faster.review"]["severity"] == "good" and "50% faster" in result["cycle.faster.review"]["title"]
    # just under the threshold: silent
    prev_close = pipeline(legs={"annotation": {"queue": {}, "work": {"median_ms": 110_000, "count": 5}}, "review": {"queue": {}, "work": {"median_ms": 50_000, "count": 5}}})
    assert not [i for i in ids(f.findings(usage(), None, now, prev_close, None)) if i.startswith("cycle.")]
    # a big change over too few cases is noise, not a trend
    thin = pipeline(legs={"annotation": {"queue": {}, "work": {"median_ms": 10_000, "count": 4}}, "review": {"queue": {}, "work": {"median_ms": 10_000, "count": 4}}})
    assert not [i for i in ids(f.findings(usage(), None, now, thin, None)) if i.startswith("cycle.")]


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
    result = {x["id"]: x for x in f.findings(u, None, pipeline(), None, None)}
    assert {"screens.bounce", "screens.rage", "screens.dead", "screens.back"} <= set(result)
    routes = {kind: [sc["route"] for sc in result[f"screens.{kind}"]["evidence"]["screens"]] for kind in ("bounce", "rage", "dead", "back")}
    assert routes == {"bounce": ["/a"], "rage": ["/c"], "dead": ["/d"], "back": ["/f"]}  # /b, /e: too little traffic
    assert all(x["tab"] == "friction" for x in result.values() if x["id"].startswith("screens."))


def test_one_finding_per_problem_naming_the_worst_screens():
    u = usage(friction={"by_screen": [screen(f"/s{i}", views=20, bounce_rate=0.3 + i / 100) for i in range(5)]})
    bounce = [x for x in f.findings(u, None, pipeline(), None, None) if x["id"] == "screens.bounce"]
    assert len(bounce) == 1 and bounce[0]["title"] == "People leave 5 screens within seconds"
    assert bounce[0]["detail"].startswith("/s4 34% (7 of 20 visits), /s3 33%") and ", and 2 more." in bounce[0]["detail"]


def test_rework_and_hands_on_time_rules():
    q = pipeline(quality={"decided": 10, "first_pass_rate": 0.6, "sent_back_rate": 0.4, "rounds_to_approve": 1.5})
    prev = pipeline(quality={"decided": 10, "first_pass_rate": 0.8, "sent_back_rate": 0.2, "rounds_to_approve": 1.2})
    result = {x["id"]: x for x in f.findings(usage(), None, q, prev, None)}
    assert result["quality.rework"]["title"] == "40% of reviewed cases were sent back"
    assert result["quality.trend"]["severity"] == "warn" and "fell to 60%" in result["quality.trend"]["title"]
    few = pipeline(quality={"decided": 4, "first_pass_rate": 0.0, "sent_back_rate": 1.0, "rounds_to_approve": None})
    assert not [i for i in ids(f.findings(usage(), None, few, None, None)) if i.startswith("quality.")]

    def effort(ms, cases, first=None, visits=0):
        return {"annotation": {"cases": cases, "active_median_ms": ms}, "review": {}, "all": {"first_input_median_ms": first, "first_input_count": visits}}

    slower = {x["id"]: x for x in f.findings(usage(effort=effort(130_000, 5, 20_000, 5)), usage(effort=effort(100_000, 5)), pipeline(), None, None)}
    assert slower["effort.annotation"]["severity"] == "warn" and "rose 30%" in slower["effort.annotation"]["title"]
    assert slower["effort.first_input"]["title"] == "It takes 20s before anyone can act on a case"
    assert "effort.first_input" not in ids(f.findings(usage(effort=effort(1, 5, 20_000, 4)), None, pipeline(), None, None))


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


def test_release_case_performance_and_guide_rules():
    releases = [
        {"app": "viewer", "version": "0.1.0+a", "cases": 6, "active_median_ms": 100_000},
        {"app": "viewer", "version": "0.1.0+b", "cases": 6, "active_median_ms": 70_000},
    ]
    u = usage(
        releases=releases,
        ratings={"count": 6, "mean": 3.8, "distribution": {}},
        complexity={"cases": 10, "per_object_median_ms": 1000, "drivers": [{"factor": "objects", "label": "objects drawn", "r": 0.82, "n": 10}, {"factor": "slices", "label": "slices", "r": 0.2, "n": 10}]},
        reject_reasons={"total": 6, "reasons": [{"reason": "boundary", "count": 4, "share": 0.667}]},
        performance=[{"endpoint": "/volume", "calls": 12, "mean_ms": 2400, "failure_rate": 0.1}, {"endpoint": "/fast", "calls": 50, "mean_ms": 100, "failure_rate": 0.0}],
        guides={"tours": [{"app": "admin-ui", "route": "/studies", "opened": 6, "finished": 1, "skipped": 5, "finish_rate": 0.167, "skipped_at_median": 1}], "finished_user_ids": []},
    )
    result = {x["id"]: x for x in f.findings(u, None, pipeline(), None, None)}
    assert result["release.viewer"]["severity"] == "good" and "fell 30%" in result["release.viewer"]["title"]
    assert result["cases.demanding"]["tab"] == "cases"
    assert "cases.driver.objects" in result and "cases.driver.slices" not in result
    assert "boundary (67%)" in result["review.reason"]["title"]
    assert result["perf.slow"]["title"] == "1 request is slow enough to wait on" and "perf.failing" in result
    assert "typical exit is step 2" in result["guide.admin-ui./studies"]["detail"]
