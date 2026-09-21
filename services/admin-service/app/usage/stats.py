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
RAGE_WINDOW_MS = 500
RAGE_RADIUS_PX = 30
DEAD_CLICK_MS = 2000
VIEWER_ROUTE_PREFIX = "/viewer"
TASK_ACTIONS = {"annotate": "mark_annotated", "review": "submit_review"}


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


def _page_routes(rows: list[dict]) -> list[str]:
    """The ordered page sequence of one session, consecutive repeats
    collapsed (a reload isn't a navigation)."""
    routes: list[str] = []
    for e in rows:
        if e["event_type"] == "page_view" and (not routes or routes[-1] != e["route"]):
            routes.append(e["route"])
    return routes


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
    for e in events:
        if e["event_type"] == "page_view":
            views[e["route"]] += 1
        elif e["event_type"] == "page_leave" and e.get("duration_ms") is not None:
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


def friction(events: list[dict]) -> dict:
    bounces: Counter = Counter()
    views: Counter = Counter()
    returned_to: Counter = Counter()
    rage: Counter = Counter()
    dead: Counter = Counter()
    errors: Counter = Counter()
    idle_ms = 0
    total_ms = 0
    for rows in _by_session(events).values():
        if len(rows) > 1:
            total_ms += _ms(rows[-1]["occurred_at"]) - _ms(rows[0]["occurred_at"])
        routes = _page_routes(rows)
        for i in range(2, len(routes)):
            if routes[i] == routes[i - 2]:
                returned_to[routes[i]] += 1
        clicks_by_route: dict[str, list[dict]] = defaultdict(list)
        for idx, e in enumerate(rows):
            kind = e["event_type"]
            if kind == "page_view":
                views[e["route"]] += 1
            elif kind == "page_leave" and e.get("duration_ms") is not None and int(e["duration_ms"]) < BOUNCE_MS:
                if any(later["event_type"] == "page_view" for later in rows[idx + 1 :]):
                    bounces[e["route"]] += 1
            elif kind == "click":
                clicks_by_route[e["route"]].append(e)
                t = _ms(e["occurred_at"])
                followed = any(
                    later["event_type"] in ("action", "page_view") and _ms(later["occurred_at"]) - t <= DEAD_CLICK_MS
                    for later in rows[idx + 1 :]
                    if _ms(later["occurred_at"]) - t <= DEAD_CLICK_MS
                )
                if not followed:
                    dead[e["route"]] += 1
            elif kind == "idle":
                idle_ms += int(e.get("duration_ms") or 0)
            elif kind == "error":
                errors[e["route"]] += 1
        for route, clicks in clicks_by_route.items():
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
        "dead_clicks": ranked(dead, "clicks"),
        "errors": ranked(errors, "errors"),
        "idle_share": round(idle_ms / total_ms, 3) if total_ms else 0.0,
    }


def per_user(events: list[dict]) -> list[dict]:
    by_user: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        by_user[e["user_id"]].append(e)
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
    recorded in, so clicks from differently sized windows overlay."""
    points = []
    for e in events:
        if e["event_type"] != "click" or e["route"] != route:
            continue
        d = e.get("detail") or {}
        viewport = d.get("viewport") or []
        if len(viewport) != 2 or not viewport[0] or not viewport[1] or "x" not in d or "y" not in d:
            continue
        points.append({"x": round(d["x"] / viewport[0], 4), "y": round(d["y"] / viewport[1], 4), "target": d.get("target")})
    return points


def summarize(events: list[dict]) -> dict:
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
        "users": per_user(events),
    }
