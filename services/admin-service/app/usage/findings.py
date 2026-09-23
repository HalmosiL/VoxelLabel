"""The Usage page's first pass at "so what?": plain-language findings
derived from the summaries the existing endpoints already produce
(usage/stats.summarize, pipeline_health's build_summary, the learning
curve). Rule based and deterministic -- every threshold is a module
constant so the sentence the admin reads and the number that triggered
it can never drift apart, and every rule is pinned down in
tests/test_usage_findings.py.

A finding is {id, severity, title, detail, tab, evidence}: `severity`
is one of critical / warn / info / good (good news is reported too, or
the page reads as nothing but complaints), `tab` is where on the Usage
page the reader should go next, `evidence` the raw numbers behind the
sentence."""
from statistics import mean

BOUNCE_RATE_WARN = 0.30
BOUNCE_MIN_VIEWS = 10
RAGE_BURSTS_WARN = 3
DEAD_CLICK_RATE_WARN = 0.30
DEAD_MIN_CLICKS = 10
BACK_AND_FORTH_WARN = 0.25
CYCLE_TREND_CHANGE = 0.20
# A trend (this period vs the last) is only reported when both periods
# have at least this many cases -- 1 case vs 1 case is noise.
TREND_MIN_CASES = 5
FIRST_PASS_WARN = 0.70
QUALITY_MIN_DECIDED = 5
FIRST_INPUT_WARN_MS = 15_000
FIRST_INPUT_MIN_VISITS = 5
# Per-screen findings of one kind are reported as one line naming the
# worst few screens -- one finding per problem, not per page.
SCREENS_NAMED = 3
RATING_DEMANDING = 3.5
RATING_MIN_ANSWERS = 5
REASON_DOMINANT_SHARE = 0.40
REASON_MIN_REJECTIONS = 5
SLOW_ENDPOINT_MS = 1500
FAILING_ENDPOINT_RATE = 0.05
ENDPOINT_MIN_CALLS = 10
GUIDE_MIN_OPENS = 5
GUIDE_FINISH_WARN = 0.50
DRIVER_STRONG_R = 0.60
DRIVER_MIN_CASES = 8
ERRORS_CRITICAL = 10
IDLE_SHARE_INFO = 0.40
LOAD_IMBALANCE_SHARE = 0.70
LEARNING_MIN_WEEKS = 3
OPEN_LEGS_NO_HISTORY_WARN = 5
VIEWER_TOOLS = ("cursor", "paint", "erase", "fill", "polygon", "auto", "histogram")

_SEVERITY_ORDER = {"critical": 0, "warn": 1, "info": 2, "good": 3}


def _finding(id_: str, severity: str, title: str, detail: str, tab: str, evidence: dict | None = None) -> dict:
    return {"id": id_, "severity": severity, "title": title, "detail": detail, "tab": tab, "evidence": evidence or {}}


def _pct(value: float) -> str:
    return f"{round(value * 100)}%"


def _duration(ms: int | None) -> str:
    if ms is None:
        return "–"
    s = round(ms / 1000)
    if s < 60:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}m {s:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h {m:02d}m"


def _bottleneck_findings(pipeline: dict | None) -> list[dict]:
    if not pipeline:
        return []
    out = []
    flagged = [b for b in pipeline.get("bottlenecks", []) if b.get("flagged")]
    if flagged:
        worst = flagged[0]
        who = worst.get("assignee") or "nobody"
        out.append(
            _finding(
                "bottlenecks.flagged",
                "critical",
                f"{len(flagged)} case{'s are' if len(flagged) != 1 else ' is'} stuck far longer than usual",
                f"The longest, \"{worst.get('case_title') or worst.get('case_id')}\", has waited {_duration(worst['waiting_ms'])} "
                f"for {'someone to start' if worst.get('kind') == 'queue' else 'a decision'} ({who}, {worst.get('card_type')}).",
                "friction",
                {"flagged": len(flagged), "worst": worst},
            )
        )
    open_no_history = [b for b in pipeline.get("bottlenecks", []) if b.get("baseline_ms") is None]
    per_card: dict = {}
    for b in open_no_history:
        per_card[b["card_id"]] = per_card.get(b["card_id"], 0) + 1
    for card_id, n in per_card.items():
        if n > OPEN_LEGS_NO_HISTORY_WARN:
            out.append(
                _finding(
                    f"bottlenecks.open_no_history.{card_id}",
                    "warn",
                    f"{n} open cases on a job with no completed history yet",
                    "Nothing has finished on this job, so there is no baseline to judge waits against -- the flat one-week rule applies until it has.",
                    "friction",
                    {"card_id": card_id, "open": n},
                )
            )
    return out


def _cycle_findings(pipeline: dict | None, pipeline_previous: dict | None) -> list[dict]:
    if not pipeline or not pipeline_previous:
        return []
    out = []
    for card_type, label in (("annotation", "annotating"), ("review", "reviewing")):
        now_leg = (pipeline.get("legs", {}).get(card_type) or {}).get("work", {})
        prev_leg = (pipeline_previous.get("legs", {}).get(card_type) or {}).get("work", {})
        now_ms, prev_ms = now_leg.get("median_ms"), prev_leg.get("median_ms")
        if not now_ms or not prev_ms or min(now_leg.get("count", 0), prev_leg.get("count", 0)) < TREND_MIN_CASES:
            continue
        change = (now_ms - prev_ms) / prev_ms
        if change >= CYCLE_TREND_CHANGE:
            out.append(
                _finding(
                    f"cycle.slower.{card_type}",
                    "warn",
                    f"{label.capitalize()} a case got {_pct(change)} slower",
                    f"From first opening a case to finishing it: median {_duration(now_ms)} over {now_leg['count']} cases, vs {_duration(prev_ms)} over {prev_leg['count']} in the previous period.",
                    "overview",
                    {"card_type": card_type, "now_ms": now_ms, "previous_ms": prev_ms, "change": round(change, 3)},
                )
            )
        elif change <= -CYCLE_TREND_CHANGE:
            out.append(
                _finding(
                    f"cycle.faster.{card_type}",
                    "good",
                    f"{label.capitalize()} a case got {_pct(-change)} faster",
                    f"From first opening a case to finishing it: median {_duration(now_ms)} over {now_leg['count']} cases, vs {_duration(prev_ms)} over {prev_leg['count']} in the previous period.",
                    "overview",
                    {"card_type": card_type, "now_ms": now_ms, "previous_ms": prev_ms, "change": round(change, 3)},
                )
            )
    return out


def _grouped(kind: str, screens: list[dict], rate_key: str, headline, detail_of, why: str) -> list[dict]:
    """One finding for every screen showing the same problem: the title
    names the problem and how widespread, the detail the worst few
    screens with their numbers."""
    if not screens:
        return []
    screens = sorted(screens, key=lambda sc: (-(sc[rate_key] or 0), -sc["views"]))
    named = ", ".join(detail_of(sc) for sc in screens[:SCREENS_NAMED])
    more = f", and {len(screens) - SCREENS_NAMED} more" if len(screens) > SCREENS_NAMED else ""
    return [
        _finding(
            f"screens.{kind}",
            "warn",
            headline(screens),
            f"{named}{more}. {why}",
            "friction",
            {"screens": [{"route": sc["route"], rate_key: sc[rate_key], "views": sc["views"]} for sc in screens]},
        )
    ]


def _screen_findings(usage: dict) -> list[dict]:
    screens = usage.get("friction", {}).get("by_screen", [])
    bounce = [sc for sc in screens if sc["views"] >= BOUNCE_MIN_VIEWS and sc["bounce_rate"] >= BOUNCE_RATE_WARN]
    back = [sc for sc in screens if sc["views"] >= BOUNCE_MIN_VIEWS and sc["back_rate"] >= BACK_AND_FORTH_WARN]
    dead = [sc for sc in screens if sc.get("measured_clicks", 0) >= DEAD_MIN_CLICKS and (sc["dead_rate"] or 0) >= DEAD_CLICK_RATE_WARN]
    rage = [sc | {"rage_rate": sc["rage_bursts"]} for sc in screens if sc["rage_bursts"] >= RAGE_BURSTS_WARN]

    out: list[dict] = []
    out += _grouped(
        "bounce",
        bounce,
        "bounce_rate",
        lambda g: f"People leave {g[0]['route']} within seconds {_pct(g[0]['bounce_rate'])} of the time" if len(g) == 1 else f"People leave {len(g)} screens within seconds",
        lambda sc: f"{sc['route']} {_pct(sc['bounce_rate'])} ({sc['bounces']} of {sc['views']} visits)",
        "Leaving within 3 s for another screen: it wasn't what they expected, or what they needed wasn't visible.",
    )
    out += _grouped(
        "back",
        back,
        "back_rate",
        lambda g: f"People flip back and forth to {g[0]['route']}" if len(g) == 1 else f"People flip back and forth between {len(g)} screens",
        lambda sc: f"{sc['route']} {_pct(sc['back_rate'])} of visits",
        "Going straight back to the screen before usually means carrying something in your head the UI should show side by side.",
    )
    out += _grouped(
        "dead",
        dead,
        "dead_rate",
        lambda g: f"Clicks on {g[0]['route']} often get no response" if len(g) == 1 else f"Clicks often get no response on {len(g)} screens",
        lambda sc: f"{sc['route']} {_pct(sc['dead_rate'])} ({sc['dead_clicks']} of {sc['measured_clicks']} clicks)",
        "Something that looks clickable (a control, a pointer cursor) was clicked and nothing on the page changed within a second.",
    )
    out += _grouped(
        "rage",
        rage,
        "rage_rate",
        lambda g: f"{g[0]['rage_bursts']} rage-click bursts on {g[0]['route']}" if len(g) == 1 else f"Rage-click bursts on {len(g)} screens",
        lambda sc: f"{sc['route']} {sc['rage_bursts']} bursts",
        "Three or more quick clicks on one spot that got no response -- a control that doesn't react, or doesn't look like it did.",
    )
    return out


def _error_findings(usage: dict, usage_previous: dict | None) -> list[dict]:
    errors = usage.get("totals", {}).get("errors", 0)
    if not errors:
        return []
    previous = (usage_previous or {}).get("totals", {}).get("errors", 0)
    rising = previous and errors > previous
    top = usage.get("friction", {}).get("errors", [])
    where = f", most on {top[0]['route']}" if top else ""
    severity = "critical" if errors >= ERRORS_CRITICAL or rising else "warn"
    return [
        _finding(
            "errors",
            severity,
            f"{errors} JavaScript error{'s' if errors != 1 else ''} hit users{where}",
            (f"Up from {previous} in the previous period. " if rising else "") + "Every one of these is a moment the app broke for someone.",
            "friction",
            {"errors": errors, "previous": previous, "by_route": top[:3]},
        )
    ]


def _idle_findings(usage: dict) -> list[dict]:
    share = usage.get("friction", {}).get("idle_share", 0.0)
    if share < IDLE_SHARE_INFO:
        return []
    return [
        _finding(
            "idle",
            "info",
            f"{_pct(share)} of session time has no input",
            "Stretches of 30 s or more without a click, key or mouse move. In the viewer that is often reading an image -- look at where it happens before calling it waste.",
            "behaviour",
            {"idle_share": share},
        )
    ]


def _load_findings(pipeline: dict | None) -> list[dict]:
    if not pipeline:
        return []
    out = []
    for card_type in ("annotation", "review"):
        rows = [r for r in pipeline.get("assignee_load", []) if r.get("card_type") == card_type]
        total = sum(r["open_count"] for r in rows)
        if len(rows) < 2 or not total:
            continue
        top = max(rows, key=lambda r: r["open_count"])
        share = top["open_count"] / total
        if share >= LOAD_IMBALANCE_SHARE:
            out.append(
                _finding(
                    f"load.imbalance.{card_type}",
                    "warn",
                    f"{top.get('assignee') or top['assignee_id']} holds {_pct(share)} of open {card_type} work",
                    f"{top['open_count']} of {total} open cases sit with one person while {len(rows) - 1} other{'s' if len(rows) > 2 else ''} share the rest.",
                    "friction",
                    {"card_type": card_type, "assignee": top.get("assignee"), "share": round(share, 3), "open": top["open_count"], "total": total},
                )
            )
    return out


def _learning_findings(learning_curve: list[dict] | None) -> list[dict]:
    if not learning_curve:
        return []
    out = []
    by_person: dict = {}
    for row in learning_curve:
        by_person.setdefault((row["actor_id"], row["card_type"]), []).append(row)
    for (actor_id, card_type), rows in by_person.items():
        rows.sort(key=lambda r: r["week"])
        if rows[-1]["week"] + 1 < LEARNING_MIN_WEEKS:
            continue
        first, last = rows[0], rows[-1]
        name = last.get("username") or actor_id
        if last["median_ms"] >= first["median_ms"] and first["median_ms"] > 0:
            out.append(
                _finding(
                    f"learning.flat.{actor_id}.{card_type}",
                    "info",
                    f"{name} isn't getting faster at {card_type}",
                    f"Week {first['week']}: {_duration(first['median_ms'])} per case; week {last['week']}: {_duration(last['median_ms'])}. Worth asking what's slowing them down.",
                    "people",
                    {"actor_id": actor_id, "card_type": card_type, "first_ms": first["median_ms"], "last_ms": last["median_ms"]},
                )
            )
        elif first["median_ms"] > 0:
            change = (first["median_ms"] - last["median_ms"]) / first["median_ms"]
            if change >= CYCLE_TREND_CHANGE:
                out.append(
                    _finding(
                        f"learning.faster.{actor_id}.{card_type}",
                        "good",
                        f"{name} got {_pct(change)} faster at {card_type} since week {first['week']}",
                        f"{_duration(first['median_ms'])} per case then, {_duration(last['median_ms'])} now.",
                        "people",
                        {"actor_id": actor_id, "card_type": card_type, "first_ms": first["median_ms"], "last_ms": last["median_ms"]},
                    )
                )
    return out


def _tool_findings(usage: dict) -> list[dict]:
    used = {a["name"].removeprefix("tool.") for a in usage.get("actions", []) if a["name"].startswith("tool.")}
    if not used:
        return []
    unused = [tool for tool in VIEWER_TOOLS if tool not in used]
    if not unused:
        return []
    return [
        _finding(
            "tools.unused",
            "info",
            f"{len(unused)} viewer tool{'s' if len(unused) != 1 else ''} never used in this period: {', '.join(unused)}",
            "Candidates to hide by default or move out of the main toolbar -- fewer visible choices is less to think about.",
            "behaviour",
            {"unused": unused, "used": sorted(used)},
        )
    ]


def _quality_findings(pipeline: dict | None, pipeline_previous: dict | None) -> list[dict]:
    q = (pipeline or {}).get("quality") or {}
    if not q.get("decided") or q["decided"] < QUALITY_MIN_DECIDED or q.get("first_pass_rate") is None:
        return []
    out = []
    if q["first_pass_rate"] < FIRST_PASS_WARN:
        out.append(
            _finding(
                "quality.rework",
                "warn",
                f"{_pct(1 - q['first_pass_rate'])} of reviewed cases were sent back",
                f"Only {_pct(q['first_pass_rate'])} of {q['decided']} cases passed review first time"
                + (f"; approved cases took {q['rounds_to_approve']} submissions on average" if q.get("rounds_to_approve") else "")
                + ". Every rejection sends the whole case round the pipeline again -- the costliest kind of cycle time.",
                "overview",
                q,
            )
        )
    prev = (pipeline_previous or {}).get("quality") or {}
    if prev.get("decided", 0) >= QUALITY_MIN_DECIDED and prev.get("first_pass_rate") is not None:
        delta = q["first_pass_rate"] - prev["first_pass_rate"]
        if abs(delta) >= 0.10:
            out.append(
                _finding(
                    "quality.trend",
                    "good" if delta > 0 else "warn",
                    f"First-time review pass rate {'rose' if delta > 0 else 'fell'} to {_pct(q['first_pass_rate'])}",
                    f"From {_pct(prev['first_pass_rate'])} in the previous period ({q['decided']} vs {prev['decided']} cases decided).",
                    "overview",
                    {"now": q["first_pass_rate"], "previous": prev["first_pass_rate"]},
                )
            )
    return out


def _effort_findings(usage: dict, usage_previous: dict | None) -> list[dict]:
    out = []
    labels = {"annotation": "annotating", "review": "reviewing"}
    for kind, label in labels.items():
        now = (usage.get("effort") or {}).get(kind) or {}
        prev = ((usage_previous or {}).get("effort") or {}).get(kind) or {}
        if not now.get("active_median_ms") or not prev.get("active_median_ms") or min(now.get("cases", 0), prev.get("cases", 0)) < TREND_MIN_CASES:
            continue
        change = (now["active_median_ms"] - prev["active_median_ms"]) / prev["active_median_ms"]
        if abs(change) >= CYCLE_TREND_CHANGE:
            out.append(
                _finding(
                    f"effort.{kind}",
                    "warn" if change > 0 else "good",
                    f"Hands-on time {label} a case {'rose' if change > 0 else 'fell'} {_pct(abs(change))}",
                    f"Active time in the viewer per case: median {_duration(now['active_median_ms'])} over {now['cases']} cases, vs {_duration(prev['active_median_ms'])} over {prev['cases']}.",
                    "overview",
                    {"kind": kind, "now_ms": now["active_median_ms"], "previous_ms": prev["active_median_ms"]},
                )
            )
    first = (usage.get("effort") or {}).get("all") or {}
    if first.get("first_input_count", 0) >= FIRST_INPUT_MIN_VISITS and (first.get("first_input_median_ms") or 0) >= FIRST_INPUT_WARN_MS:
        out.append(
            _finding(
                "effort.first_input",
                "warn",
                f"It takes {_duration(first['first_input_median_ms'])} before anyone can act on a case",
                f"Median time from opening a case in the viewer to the first click or key, over {first['first_input_count']} openings -- image loading plus getting oriented, paid on every case.",
                "overview",
                {"median_ms": first["first_input_median_ms"], "visits": first["first_input_count"]},
            )
        )
    return out


def _release_findings(usage: dict) -> list[dict]:
    """The newest build of each app against the one before it."""
    out = []
    by_app: dict[str, list[dict]] = {}
    for row in usage.get("releases") or []:
        by_app.setdefault(row["app"], []).append(row)
    for app, rows in by_app.items():
        if len(rows) < 2:
            continue
        before, now = rows[-2], rows[-1]
        if min(before.get("cases") or 0, now.get("cases") or 0) < TREND_MIN_CASES or not before.get("active_median_ms") or not now.get("active_median_ms"):
            continue
        change = (now["active_median_ms"] - before["active_median_ms"]) / before["active_median_ms"]
        if abs(change) < CYCLE_TREND_CHANGE:
            continue
        out.append(
            _finding(
                f"release.{app}",
                "good" if change < 0 else "warn",
                f"Since {app} {now['version']}, hands-on time per case {'fell' if change < 0 else 'rose'} {_pct(abs(change))}",
                f"Median {_duration(now['active_median_ms'])} over {now['cases']} cases, vs {_duration(before['active_median_ms'])} over {before['cases']} with {before['version']}. Other things changed too -- check the cases were comparable (Cases tab).",
                "overview",
                {"app": app, "now": now["version"], "before": before["version"], "change": round(change, 3)},
            )
        )
    return out


def _case_findings(usage: dict) -> list[dict]:
    out = []
    r = usage.get("ratings") or {}
    if r.get("count", 0) >= RATING_MIN_ANSWERS and (r.get("mean") or 0) >= RATING_DEMANDING:
        out.append(
            _finding(
                "cases.demanding",
                "info",
                f"People rate their cases {r['mean']} of 5 on how demanding they were",
                f"From {r['count']} answers (1 easy, 5 very demanding). The Cases tab shows which cases, and whether objects, slices or rework drive it.",
                "cases",
                r,
            )
        )
    for d in (usage.get("complexity") or {}).get("drivers", []):
        if abs(d["r"]) >= DRIVER_STRONG_R and d["n"] >= DRIVER_MIN_CASES:
            out.append(
                _finding(
                    f"cases.driver.{d['factor']}",
                    "info",
                    f"Hands-on time goes {'up' if d['r'] > 0 else 'down'} with {d['label']}",
                    f"Correlation r = {d['r']} over {d['n']} cases. A description, not a cause -- but it says where making each case cheaper pays off.",
                    "cases",
                    d,
                )
            )
    reasons = usage.get("reject_reasons") or {}
    if reasons.get("total", 0) >= REASON_MIN_REJECTIONS and reasons["reasons"] and reasons["reasons"][0]["share"] >= REASON_DOMINANT_SHARE:
        top = reasons["reasons"][0]
        out.append(
            _finding(
                "review.reason",
                "info",
                f"Most rejected objects are for one reason: {top['reason']} ({_pct(top['share'])})",
                f"{top['count']} of {reasons['total']} tagged rejections. One recurring reason is a guideline or tool problem, not a people problem.",
                "overview",
                reasons,
            )
        )
    return out


def _performance_findings(usage: dict) -> list[dict]:
    rows = [r for r in usage.get("performance") or [] if r["calls"] >= ENDPOINT_MIN_CALLS]
    out = []
    slow = [r for r in rows if r["mean_ms"] >= SLOW_ENDPOINT_MS]
    if slow:
        named = ", ".join(f"{r['endpoint']} {_duration(r['mean_ms'])} avg over {r['calls']} calls" for r in slow[:SCREENS_NAMED])
        out.append(_finding("perf.slow", "warn", f"{len(slow)} request{'s are' if len(slow) != 1 else ' is'} slow enough to wait on", f"{named}. Every one of these is waiting that looks like work in the cycle time.", "friction", {"endpoints": slow}))
    failing = [r for r in rows if r["failure_rate"] >= FAILING_ENDPOINT_RATE]
    if failing:
        named = ", ".join(f"{r['endpoint']} {_pct(r['failure_rate'])} of {r['calls']}" for r in failing[:SCREENS_NAMED])
        out.append(_finding("perf.failing", "warn", f"{len(failing)} request{'s' if len(failing) != 1 else ''} often fail", f"{named}.", "friction", {"endpoints": failing}))
    return out


def _guide_findings(usage: dict) -> list[dict]:
    tours = [t for t in (usage.get("guides") or {}).get("tours", []) if t["opened"] >= GUIDE_MIN_OPENS and (t["finish_rate"] or 0) < GUIDE_FINISH_WARN]
    return [
        _finding(
            f"guide.{t['app']}.{t['route']}",
            "info",
            f"Most people leave the {t['route']} tutorial before the end",
            f"{_pct(t['finish_rate'])} of {t['opened']} finished it" + (f"; the typical exit is step {t['skipped_at_median'] + 1}" if t.get("skipped_at_median") is not None else "") + ". That step is where it loses them.",
            "people",
            t,
        )
        for t in tours
    ]


def findings(usage: dict, usage_previous: dict | None, pipeline: dict | None, pipeline_previous: dict | None, learning_curve: list[dict] | None) -> list[dict]:
    if not usage.get("totals", {}).get("events"):
        return [_finding("no_data", "info", "Nothing recorded in this period yet", "Findings appear once people have used the platform with recording on.", "settings")]
    out: list[dict] = []
    out += _bottleneck_findings(pipeline)
    out += _cycle_findings(pipeline, pipeline_previous)
    out += _quality_findings(pipeline, pipeline_previous)
    out += _effort_findings(usage, usage_previous)
    out += _release_findings(usage)
    out += _case_findings(usage)
    out += _performance_findings(usage)
    out += _guide_findings(usage)
    out += _screen_findings(usage)
    out += _error_findings(usage, usage_previous)
    out += _idle_findings(usage)
    out += _load_findings(pipeline)
    out += _learning_findings(learning_curve)
    out += _tool_findings(usage)
    if not out:
        avg = usage.get("totals", {}).get("avg_session_ms")
        out.append(
            _finding(
                "all_clear",
                "good",
                "Nothing stands out",
                f"No stuck cases, no screens people bounce off, no errors. Average session {_duration(avg) if avg else '–'}."
                if avg is not None
                else "No stuck cases, no screens people bounce off, no errors.",
                "overview",
                {},
            )
        )
    out.sort(key=lambda f: _SEVERITY_ORDER[f["severity"]])
    return out


def friction_score(usage: dict) -> int | None:
    """One headline number for the Overview tile: the view-weighted mean
    of every screen's friction score (see stats.friction's by_screen),
    None when nothing was viewed."""
    screens = usage.get("friction", {}).get("by_screen", [])
    weighted = [(s["score"], s["views"]) for s in screens if s["views"] > 0]
    if not weighted:
        return None
    total_views = sum(v for _, v in weighted)
    return round(sum(s * v for s, v in weighted) / total_views) if total_views else round(mean(s for s, _ in weighted))
