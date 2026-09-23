"""Pure aggregation over usage events -- takes plain dicts (one per
usage_events row: user_id, session_id, app, event_type, route, name,
detail, duration_ms, occurred_at), returns what the Usage page draws.
No database, no clock: every function is deterministic over its input,
so tests/test_usage_stats.py can pin each figure down on a hand-written
event list.

Friction thresholds live here as constants so the page's wording ("left
within 3 s", "3 clicks within half a second") and the numbers behind it
can't drift apart."""
from collections import Counter, defaultdict
from datetime import datetime
from statistics import mean, median

BOUNCE_MS = 3000
# A page left in under a second was passed through, not used -- a
# redirect (the viewer's /viewer/series/:id hands over in ~90 ms) or a
# fast click through a menu. Dropped before anything is counted, so it
# can neither "bounce" nor appear as a step in someone's path.
REDIRECT_MS = 1000
RAGE_WINDOW_MS = 500
RAGE_RADIUS_PX = 30
VIEWER_ROUTE_PREFIX = "/viewer"
TASK_ACTIONS = {"annotate": "mark_annotated", "review": "submit_review"}
UNDO_ACTIONS = {"undo"}
# Before the tracker marked clicks inside the tutorial overlay
# (detail.guide), these were its buttons -- the tour's own clicks are
# not work on the page underneath.
LEGACY_GUIDE_TARGETS = {"button:Next", "button:Finish", "button:Back", "button:Skip tour"}
# Before the tracker recorded whether a click got a response
# (detail.responded), a click on one of these was on a real control.
_LEGACY_INTERACTIVE_PREFIXES = ("button", "a:", "testid:", "aria:", "guide:")


def _ms(value) -> int:
    if isinstance(value, datetime):
        return int(value.timestamp() * 1000)
    return int(value)


def _by_session(events: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        grouped[e["session_id"]].append(e)
    for rows in grouped.values():
        rows.sort(key=lambda e: _ms(e["occurred_at"]))
    return grouped


def _is_guide_click(e: dict) -> bool:
    d = e.get("detail") or {}
    if "guide" in d:
        return bool(d["guide"])
    return d.get("target") in LEGACY_GUIDE_TARGETS


def _legacy_interactive(target: str) -> bool:
    return target in ("a", "canvas") or target.startswith(_LEGACY_INTERACTIVE_PREFIXES)


def prepare(events: list[dict]) -> list[dict]:
    """What every figure is computed over: the recorded events minus the
    ones that aren't the person's own work -- pages passed through in
    under REDIRECT_MS (the page_view and its page_leave both go) and
    clicks inside the tutorial overlay. Returned grouped by session,
    each session in time order."""
    out: list[dict] = []
    for rows in _by_session(events).values():
        drop: set[int] = set()
        open_view: dict[str, int] = {}
        for i, e in enumerate(rows):
            kind = e["event_type"]
            if kind == "page_view":
                open_view[e["route"]] = i
            elif kind == "page_leave":
                duration = e.get("duration_ms")
                if duration is not None and int(duration) < REDIRECT_MS:
                    drop.add(i)
                    j = open_view.pop(e["route"], None)
                    if j is not None:
                        drop.add(j)
            elif kind == "click" and _is_guide_click(e):
                drop.add(i)
        out.extend(e for i, e in enumerate(rows) if i not in drop)
    return out


def _page_routes(rows: list[dict]) -> list[str]:
    """The ordered page sequence of one session, consecutive repeats
    collapsed (a reload isn't a navigation)."""
    routes: list[str] = []
    for e in rows:
        if e["event_type"] == "page_view" and (not routes or routes[-1] != e["route"]):
            routes.append(e["route"])
    return routes


def _visits(rows: list[dict]) -> Counter:
    """How many times each screen was opened in one session. A page_view
    is the direct evidence, but a page_leave is proof of a visit too --
    older trackers dropped the first page_view of a fresh load (the
    config hadn't arrived yet) while still sending its page_leave -- so
    a screen counts the larger of the two, never fewer visits than
    departures. Keeps every per-visit rate at or under 100%."""
    views: Counter = Counter()
    leaves: Counter = Counter()
    for e in rows:
        if e["event_type"] == "page_view":
            views[e["route"]] += 1
        elif e["event_type"] == "page_leave":
            leaves[e["route"]] += 1
    return Counter({route: max(views[route], leaves[route]) for route in set(views) | set(leaves)})


def back_and_forth(routes: list[str]) -> tuple[int, int]:
    """How many navigations went straight back to the page visited two
    steps earlier (A -> B -> A), out of all navigations after the first.
    A person who keeps flipping between two screens to compare or copy
    something is carrying state in their head the UI should be holding
    for them -- the cognitive-load proxy the Usage page ranks by."""
    if len(routes) < 3:
        return 0, max(len(routes) - 1, 0)
    returns = sum(1 for i in range(2, len(routes)) if routes[i] == routes[i - 2])
    return returns, len(routes) - 1


def mouse_distance(rows: list[dict]) -> float:
    """Total pointer travel in CSS pixels across the mouse traces."""
    total = 0.0
    for e in rows:
        if e["event_type"] != "mouse_trace":
            continue
        points = (e.get("detail") or {}).get("points") or []
        for a, b in zip(points, points[1:]):
            total += ((b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2) ** 0.5
    return total


def sessions(events: list[dict]) -> list[dict]:
    result = []
    for session_id, rows in _by_session(events).items():
        first, last = rows[0], rows[-1]
        started, ended = _ms(first["occurred_at"]), _ms(last["occurred_at"])
        types = Counter(e["event_type"] for e in rows)
        result.append(
            {
                "session_id": session_id,
                "user_id": first["user_id"],
                "app": first["app"],
                "started_at": first["occurred_at"],
                "ended_at": last["occurred_at"],
                "duration_ms": ended - started,
                "page_views": types["page_view"],
                "actions": types["action"],
                "clicks": types["click"],
                "errors": types["error"],
                "routes": _page_routes(rows),
            }
        )
    result.sort(key=lambda s: _ms(s["started_at"]), reverse=True)
    return result


def time_per_route(events: list[dict]) -> list[dict]:
    views: Counter = Counter()
    dwell: dict[str, list[int]] = defaultdict(list)
    for rows in _by_session(events).values():
        views.update(_visits(rows))
    for e in events:
        if e["event_type"] == "page_leave" and e.get("duration_ms") is not None:
            dwell[e["route"]].append(int(e["duration_ms"]))
    routes = set(views) | set(dwell)
    rows = [
        {
            "route": route,
            "views": views[route],
            "total_ms": sum(dwell[route]),
            "avg_ms": int(mean(dwell[route])) if dwell[route] else 0,
        }
        for route in routes
    ]
    rows.sort(key=lambda r: (-r["total_ms"], -r["views"], r["route"]))
    return rows


def transitions(events: list[dict], top: int = 15) -> list[dict]:
    pairs: Counter = Counter()
    session_pairs: dict[tuple, set] = defaultdict(set)
    for session_id, rows in _by_session(events).items():
        routes = _page_routes(rows)
        for a, b in zip(routes, routes[1:]):
            pairs[(a, b)] += 1
            session_pairs[(a, b)].add(session_id)
    ranked = sorted(pairs.items(), key=lambda kv: (-kv[1], kv[0]))[:top]
    return [{"from": a, "to": b, "count": n, "sessions": len(session_pairs[(a, b)])} for (a, b), n in ranked]


def action_counts(events: list[dict]) -> list[dict]:
    counts = Counter(e["name"] for e in events if e["event_type"] == "action" and e.get("name"))
    return [{"name": name, "count": n} for name, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def task_durations(events: list[dict]) -> dict:
    """Viewer page opened -> the task's finishing action in the same
    session: how long annotating (Mark as Annotated) and reviewing
    (Submit review) a case really takes, wall-clock. Each finishing
    action is paired with the most recent viewer page_view before it."""
    samples: dict[str, list[int]] = {task: [] for task in TASK_ACTIONS}
    for rows in _by_session(events).values():
        opened_at: int | None = None
        for e in rows:
            if e["event_type"] == "page_view":
                opened_at = _ms(e["occurred_at"]) if e["route"].startswith(VIEWER_ROUTE_PREFIX) else None
            elif e["event_type"] == "action" and opened_at is not None:
                for task, action in TASK_ACTIONS.items():
                    if e.get("name") == action:
                        samples[task].append(_ms(e["occurred_at"]) - opened_at)
                        opened_at = None
    return {
        task: {
            "count": len(values),
            "median_ms": int(median(values)) if values else None,
            "mean_ms": int(mean(values)) if values else None,
        }
        for task, values in samples.items()
    }


def case_effort(events: list[dict]) -> list[dict]:
    """What working one case in the viewer actually cost, per (job,
    case), across every sitting: active time (time on the case's viewer
    page minus idle stretches), how many sittings it took, undo count,
    and -- per visit -- how long until the first click, key or action
    (loading plus getting oriented: the wait before work can start).
    Keyed by the job_id/case_id the viewer stamps on its page_view."""
    per: dict[tuple, dict] = {}
    for session_id, rows in _by_session(events).items():
        current: tuple | None = None
        idle = 0
        opened = 0
        waiting_for_input = False
        for e in rows:
            kind = e["event_type"]
            if kind == "page_view":
                d = e.get("detail") or {}
                current = None
                if e["route"].startswith(VIEWER_ROUTE_PREFIX) and d.get("case_id") and d.get("job_id"):
                    current = (str(d["job_id"]), str(d["case_id"]))
                    entry = per.setdefault(
                        current,
                        {"job_id": current[0], "case_id": current[1], "user_ids": set(), "sessions": set(), "active_ms": 0, "undos": 0, "first_input_ms": []},
                    )
                    entry["sessions"].add(session_id)
                    entry["user_ids"].add(e["user_id"])
                    idle, opened, waiting_for_input = 0, _ms(e["occurred_at"]), True
                continue
            if current is None:
                continue
            entry = per[current]
            if kind == "idle":
                idle += int(e.get("duration_ms") or 0)
            elif kind == "page_leave":
                if e.get("duration_ms") is not None:
                    entry["active_ms"] += max(int(e["duration_ms"]) - idle, 0)
                current = None
            elif kind in ("click", "key", "action"):
                if waiting_for_input:
                    entry["first_input_ms"].append(_ms(e["occurred_at"]) - opened)
                    waiting_for_input = False
                if kind == "action" and e.get("name") in UNDO_ACTIONS:
                    entry["undos"] += 1
    return [
        {
            "job_id": v["job_id"],
            "case_id": v["case_id"],
            "user_ids": sorted(v["user_ids"]),
            "sittings": len(v["sessions"]),
            "active_ms": v["active_ms"],
            "undos": v["undos"],
            "first_input_ms": v["first_input_ms"],
        }
        for v in per.values()
    ]


def effort_summary(entries: list[dict]) -> dict:
    """Medians over case_effort() entries: what one case typically costs."""
    active = [e["active_ms"] for e in entries if e["active_ms"] > 0]
    sittings = [e["sittings"] for e in entries]
    first_input = [ms for e in entries for ms in e["first_input_ms"]]
    return {
        "cases": len(entries),
        "active_median_ms": int(median(active)) if active else None,
        "sittings_median": median(sittings) if sittings else None,
        "undos_per_case": round(sum(e["undos"] for e in entries) / len(entries), 1) if entries else None,
        "first_input_median_ms": int(median(first_input)) if first_input else None,
        "first_input_count": len(first_input),
    }


def _rage_clicks(clicks: list[dict]) -> int:
    """Bursts of 3+ clicks within RAGE_WINDOW_MS landing within
    RAGE_RADIUS_PX of the first -- someone hammering a control that
    isn't responding (or doesn't look like it has)."""
    bursts = 0
    i = 0
    while i < len(clicks):
        t0 = _ms(clicks[i]["occurred_at"])
        d0 = clicks[i].get("detail") or {}
        j = i + 1
        while j < len(clicks) and _ms(clicks[j]["occurred_at"]) - t0 <= RAGE_WINDOW_MS:
            d = clicks[j].get("detail") or {}
            if abs(d.get("x", 0) - d0.get("x", 0)) > RAGE_RADIUS_PX or abs(d.get("y", 0) - d0.get("y", 0)) > RAGE_RADIUS_PX:
                break
            j += 1
        if j - i >= 3:
            bursts += 1
            i = j
        else:
            i += 1
    return bursts


def _click_signal(e: dict) -> bool | None:
    """True for a dead click, False for a live one, None when unknown.
    A click is dead when it landed on something that looks clickable (a
    control, or anything with a pointer cursor) and nothing on the page
    changed within a second -- the tracker watches the DOM for that
    (detail.responded). Clicks on bare background, on the viewer's image
    canvas (drawing doesn't touch the DOM) and clicks recorded before
    the tracker measured it are unknown, and left out of the rate."""
    d = e.get("detail") or {}
    if "responded" not in d:
        return None
    if not (d.get("interactive") or d.get("pointer")):
        return None
    return not d["responded"]


def _rage_candidate(e: dict) -> bool:
    """A click that could be part of a rage burst: one that got no
    response (or, for older clicks, one not on a real control). Hammering
    a Next button that does step each time is fast work, not rage."""
    d = e.get("detail") or {}
    if "responded" in d:
        return not d["responded"]
    return not _legacy_interactive(d.get("target") or "")


def friction(events: list[dict]) -> dict:
    """The friction signals per screen, over prepare()d events. Linear
    in the number of events per session (a working day in the viewer is
    thousands of them)."""
    bounces: Counter = Counter()
    views: Counter = Counter()
    returned_to: Counter = Counter()
    rage: Counter = Counter()
    dead: Counter = Counter()
    measured: Counter = Counter()
    errors: Counter = Counter()
    clicks_total: Counter = Counter()
    idle_ms = 0
    total_ms = 0
    for rows in _by_session(events).values():
        if len(rows) > 1:
            total_ms += _ms(rows[-1]["occurred_at"]) - _ms(rows[0]["occurred_at"])
        routes = _page_routes(rows)
        for i in range(2, len(routes)):
            if routes[i] == routes[i - 2]:
                returned_to[routes[i]] += 1
        views.update(_visits(rows))
        last_view = max((i for i, e in enumerate(rows) if e["event_type"] == "page_view"), default=-1)
        rage_by_route: dict[str, list[dict]] = defaultdict(list)
        for idx, e in enumerate(rows):
            kind = e["event_type"]
            if kind == "page_leave" and e.get("duration_ms") is not None and int(e["duration_ms"]) < BOUNCE_MS:
                if idx < last_view:  # left for another page, not the end of the sitting
                    bounces[e["route"]] += 1
            elif kind == "click":
                clicks_total[e["route"]] += 1
                signal = _click_signal(e)
                if signal is not None:
                    measured[e["route"]] += 1
                    if signal:
                        dead[e["route"]] += 1
                if _rage_candidate(e):
                    rage_by_route[e["route"]].append(e)
            elif kind == "idle":
                idle_ms += int(e.get("duration_ms") or 0)
            elif kind == "error":
                errors[e["route"]] += 1
        for route, clicks in rage_by_route.items():
            rage[route] += _rage_clicks(clicks)

    def ranked(counter: Counter, key: str, *, rate_of: Counter | None = None) -> list[dict]:
        rows_out = []
        for route, n in counter.items():
            if n <= 0:
                continue
            entry = {"route": route, key: n}
            if rate_of is not None:
                entry["rate"] = round(n / rate_of[route], 3) if rate_of[route] else None
            rows_out.append(entry)
        rows_out.sort(key=lambda r: (-(r.get("rate") or 0), -r[key], r["route"]))
        return rows_out[:10]

    return {
        "bounces": ranked(bounces, "bounces", rate_of=views),
        "back_and_forth": ranked(returned_to, "returns", rate_of=views),
        "rage_clicks": ranked(rage, "bursts"),
        "dead_clicks": ranked(dead, "clicks", rate_of=measured),
        "errors": ranked(errors, "errors"),
        "idle_share": round(idle_ms / total_ms, 3) if total_ms else 0.0,
        "by_screen": _by_screen(views, bounces, returned_to, rage, dead, measured, clicks_total, errors),
    }


# Weights of the per-screen friction score. Bounces weigh most (leaving
# within seconds is the clearest "this isn't it" signal), then flipping
# back and forth, then clicks that did nothing, then rage bursts.
SCORE_WEIGHTS = {"bounce": 0.35, "back": 0.25, "dead": 0.20, "rage": 0.20}


def _by_screen(views: Counter, bounces: Counter, returned_to: Counter, rage: Counter, dead: Counter, measured: Counter, clicks_total: Counter, errors: Counter) -> list[dict]:
    """One row per screen with every friction component as a rate and a
    single 0-100 score -- `100 * (0.35*bounce_rate + 0.25*back_rate +
    0.20*dead_click_rate + 0.20*min(rage_bursts/views, 1))` -- so
    screens rank by one number while the components stay visible next
    to it. Rates are per view (bounces, returns, rage) or per measured
    click (dead -- only clicks whose response was measured count, see
    _click_signal; None when there were none, and it then adds 0 to the
    score). Worst first, then most viewed."""
    routes = set(views) | set(bounces) | set(returned_to) | set(rage) | set(dead) | set(clicks_total) | set(errors)
    rows = []
    for route in routes:
        v, c, m = views[route], clicks_total[route], measured[route]
        bounce_rate = bounces[route] / v if v else 0.0
        back_rate = returned_to[route] / v if v else 0.0
        dead_rate = dead[route] / m if m else None
        rage_rate = min(rage[route] / v, 1.0) if v else (1.0 if rage[route] else 0.0)
        score = round(100 * (SCORE_WEIGHTS["bounce"] * bounce_rate + SCORE_WEIGHTS["back"] * back_rate + SCORE_WEIGHTS["dead"] * (dead_rate or 0.0) + SCORE_WEIGHTS["rage"] * rage_rate))
        rows.append(
            {
                "route": route,
                "views": v,
                "clicks": c,
                "bounces": bounces[route],
                "bounce_rate": round(bounce_rate, 3),
                "returns": returned_to[route],
                "back_rate": round(back_rate, 3),
                "measured_clicks": m,
                "dead_clicks": dead[route],
                "dead_rate": round(dead_rate, 3) if dead_rate is not None else None,
                "rage_bursts": rage[route],
                "errors": errors[route],
                "score": score,
            }
        )
    rows.sort(key=lambda r: (-r["score"], -r["views"], r["route"]))
    return rows


def per_user(events: list[dict], effort: list[dict] | None = None) -> list[dict]:
    by_user: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        by_user[e["user_id"]].append(e)
    active_by_user: dict[str, list[int]] = defaultdict(list)
    for entry in effort or []:
        if entry["active_ms"] > 0:
            for uid in entry["user_ids"]:
                active_by_user[uid].append(entry["active_ms"])
    result = []
    for user_id, rows in by_user.items():
        user_sessions = sessions(rows)
        total_ms = sum(s["duration_ms"] for s in user_sessions)
        page_views = sum(s["page_views"] for s in user_sessions)
        dwells = [int(e["duration_ms"]) for e in rows if e["event_type"] == "page_leave" and e.get("duration_ms") is not None]
        returns = navs = 0
        for s in user_sessions:
            r, n = back_and_forth(s["routes"])
            returns += r
            navs += n
        clicks = sum(s["clicks"] for s in user_sessions)
        actions = Counter(e["name"] for e in rows if e["event_type"] == "action")
        result.append(
            {
                "user_id": user_id,
                "sessions": len(user_sessions),
                "total_ms": total_ms,
                "page_views": page_views,
                "pages_per_session": round(page_views / len(user_sessions), 1) if user_sessions else 0,
                "avg_dwell_ms": int(mean(dwells)) if dwells else 0,
                "back_and_forth": round(returns / navs, 3) if navs else 0.0,
                "clicks": clicks,
                "clicks_per_min": round(clicks / (total_ms / 60000), 1) if total_ms else 0.0,
                "mouse_px_per_page": int(mouse_distance(rows) / page_views) if page_views else 0,
                "active_per_case_ms": int(median(active_by_user[user_id])) if active_by_user[user_id] else None,
                "cases_worked": len(active_by_user[user_id]),
                "annotated": actions.get(TASK_ACTIONS["annotate"], 0),
                "reviewed": actions.get(TASK_ACTIONS["review"], 0),
                "errors": sum(s["errors"] for s in user_sessions),
                "last_seen_at": max(s["ended_at"] for s in user_sessions) if user_sessions else None,
            }
        )
    result.sort(key=lambda u: -u["total_ms"])
    return result


def click_points(events: list[dict], route: str) -> list[dict]:
    """Every click on `route`, normalised to 0..1 by the viewport it was
    recorded in, so clicks from differently sized windows overlay. Each
    carries who clicked, so the heatmap can colour people apart, and
    whether it was dead. Tutorial-overlay clicks are left out."""
    points = []
    for e in events:
        if e["event_type"] != "click" or e["route"] != route or _is_guide_click(e):
            continue
        d = e.get("detail") or {}
        viewport = d.get("viewport") or []
        if len(viewport) != 2 or not viewport[0] or not viewport[1] or "x" not in d or "y" not in d:
            continue
        points.append({"x": round(d["x"] / viewport[0], 4), "y": round(d["y"] / viewport[1], 4), "target": d.get("target"), "user_id": e["user_id"], "dead": _click_signal(e) is True})
    return points


def summarize(events: list[dict]) -> dict:
    """Everything the Usage page draws, over prepare()d events. Also
    returns the raw case_effort() entries (under "_effort") so the API
    layer can split them by job type, which needs the database."""
    events = prepare(events)
    effort = case_effort(events)
    all_sessions = sessions(events)
    durations = [s["duration_ms"] for s in all_sessions]
    return {
        "totals": {
            "events": len(events),
            "active_users": len({e["user_id"] for e in events}),
            "sessions": len(all_sessions),
            "avg_session_ms": int(mean(durations)) if durations else 0,
            "errors": sum(1 for e in events if e["event_type"] == "error"),
        },
        "tasks": task_durations(events),
        "routes": time_per_route(events),
        "transitions": transitions(events),
        "actions": action_counts(events),
        "friction": friction(events),
        "users": per_user(events, effort),
        "_effort": effort,
    }
