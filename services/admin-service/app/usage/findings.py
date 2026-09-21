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
        now_ms = (pipeline.get("legs", {}).get(card_type) or {}).get("work", {}).get("median_ms")
        prev_ms = (pipeline_previous.get("legs", {}).get(card_type) or {}).get("work", {}).get("median_ms")
        if not now_ms or not prev_ms:
            continue
        change = (now_ms - prev_ms) / prev_ms
        if change >= CYCLE_TREND_CHANGE:
            out.append(
                _finding(
                    f"cycle.slower.{card_type}",
                    "warn",
                    f"{label.capitalize()} a case got {_pct(change)} slower",
                    f"Median {_duration(now_ms)} now vs {_duration(prev_ms)} in the previous period.",
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
                    f"Median {_duration(now_ms)} now vs {_duration(prev_ms)} in the previous period.",
                    "overview",
                    {"card_type": card_type, "now_ms": now_ms, "previous_ms": prev_ms, "change": round(change, 3)},
                )
            )
    return out


def _screen_findings(usage: dict) -> list[dict]:
    out = []
    for screen in usage.get("friction", {}).get("by_screen", []):
        route = screen["route"]
        if screen["views"] >= BOUNCE_MIN_VIEWS and screen["bounce_rate"] >= BOUNCE_RATE_WARN:
            out.append(
                _finding(
                    f"screen.bounce.{route}",
                    "warn",
                    f"People leave {route} within seconds {_pct(screen['bounce_rate'])} of the time",
                    f"{screen['bounces']} of {screen['views']} visits bounced -- either it isn't what they expected, or what they need isn't visible.",
                    "friction",
                    {"route": route, "bounce_rate": screen["bounce_rate"], "views": screen["views"]},
                )
            )
        if screen["rage_bursts"] >= RAGE_BURSTS_WARN:
            out.append(
                _finding(
                    f"screen.rage.{route}",
                    "warn",
                    f"{screen['rage_bursts']} rage-click bursts on {route}",
                    "Someone hammered the same spot repeatedly -- a control that doesn't respond, or doesn't look like it did.",
                    "friction",
                    {"route": route, "rage_bursts": screen["rage_bursts"]},
                )
            )
        if screen["clicks"] >= DEAD_MIN_CLICKS and screen["dead_rate"] >= DEAD_CLICK_RATE_WARN:
            out.append(
                _finding(
                    f"screen.dead.{route}",
                    "warn",
                    f"{_pct(screen['dead_rate'])} of clicks on {route} do nothing",
                    f"{screen['dead_clicks']} of {screen['clicks']} clicks weren't followed by any action or navigation -- things that look clickable but aren't.",
                    "friction",
                    {"route": route, "dead_rate": screen["dead_rate"], "clicks": screen["clicks"]},
                )
            )
        if screen["views"] >= BOUNCE_MIN_VIEWS and screen["back_rate"] >= BACK_AND_FORTH_WARN:
            out.append(
                _finding(
                    f"screen.back.{route}",
                    "warn",
                    f"People flip back and forth to {route} {_pct(screen['back_rate'])} of the time",
                    "Returning to the previous screen right away usually means carrying information in your head the UI should show side by side.",
                    "friction",
                    {"route": route, "back_rate": screen["back_rate"], "views": screen["views"]},
                )
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
            f"{_pct(share)} of session time is idle",
            "Long pauses inside sessions -- waiting on something to load, or on someone else -- rather than active work.",
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


def findings(usage: dict, usage_previous: dict | None, pipeline: dict | None, pipeline_previous: dict | None, learning_curve: list[dict] | None) -> list[dict]:
    if not usage.get("totals", {}).get("events"):
        return [_finding("no_data", "info", "Nothing recorded in this period yet", "Findings appear once people have used the platform with recording on.", "settings")]
    out: list[dict] = []
    out += _bottleneck_findings(pipeline)
    out += _cycle_findings(pipeline, pipeline_previous)
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
