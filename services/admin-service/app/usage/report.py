"""The Markdown summary report -- the Usage page's Overview as text
someone can paste into Jira, Slack or an e-mail for the monthly review.
Rendered from the same dicts the page and its findings use, so the
report can never disagree with what's on screen."""
from datetime import datetime

from .findings import friction_score

_SEVERITY_MARK = {"critical": "[!!]", "warn": "[!]", "info": "[i]", "good": "[+]"}


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


def _date(value: str | datetime | None) -> str:
    if value is None:
        return "–"
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M")
    return value[:16].replace("T", " ")


def _table(headers: list[str], rows: list[list[str]]) -> str:
    if not rows:
        return "_none_\n"
    line = "| " + " | ".join(headers) + " |\n| " + " | ".join("---" for _ in headers) + " |\n"
    return line + "".join("| " + " | ".join(str(c) for c in row) + " |\n" for row in rows)


def render_markdown(
    since, until, usage: dict, pipeline: dict | None, findings: list[dict], learning_curve: list[dict] | None, scope: str | None = None
) -> str:
    """`scope`: the person / study the page was filtered to, e.g. "person
    qa-h-rev · study QA-H" -- said up front, so a pasted report isn't read
    as platform-wide (H-02)."""
    totals = usage.get("totals", {})
    effort = usage.get("effort", {})
    basis = usage.get("basis", {})
    parts = [f"# Usage report · {_date(since)} – {_date(until)}\n"]
    if scope:
        parts.append(f"_Filtered to: {scope}._\n")
    if basis:
        parts.append(
            f"_Based on {basis.get('events', 0)} events from {basis.get('people', 0)} people in {basis.get('sessions', 0)} sessions"
            + (f"; {basis['not_counted']} accounts not counted (admins and test accounts)" if basis.get("not_counted") else "")
            + "._\n"
        )

    parts.append("## Findings\n")
    if findings:
        for f in findings:
            parts.append(f"- {_SEVERITY_MARK[f['severity']]} **{f['title']}** — {f['detail']}")
        parts.append("")
    else:
        parts.append("_none_\n")

    score = friction_score(usage)
    parts.append("## Headline numbers\n")
    parts.append(
        _table(
            ["Metric", "Value"],
            [
                ["Active people", totals.get("active_users", 0)],
                ["Sessions", totals.get("sessions", 0)],
                ["Average session", _duration(totals.get("avg_session_ms"))],
                ["Hands-on time per case, annotating", f"{_duration((effort.get('annotation') or {}).get('active_median_ms'))} ({(effort.get('annotation') or {}).get('cases', 0)} cases)"],
                ["Hands-on time per case, reviewing", f"{_duration((effort.get('review') or {}).get('active_median_ms'))} ({(effort.get('review') or {}).get('cases', 0)} cases)"],
                ["Time to first action in the viewer", f"{_duration((effort.get('all') or {}).get('first_input_median_ms'))} ({(effort.get('all') or {}).get('first_input_count', 0)} openings)"],
                ["Errors", totals.get("errors", 0)],
                ["Friction score (0–100)", score if score is not None else "–"],
                ["Time with no input (30 s+)", f"{round(usage.get('friction', {}).get('idle_share', 0) * 100)}%"],
            ],
        )
    )

    if pipeline:
        legs = pipeline.get("legs", {})
        parts.append("## Cycle time\n")
        parts.append(
            _table(
                ["Leg", "Median", "Cases"],
                [
                    [label, _duration((legs.get(ct) or {}).get(kind, {}).get("median_ms")), (legs.get(ct) or {}).get(kind, {}).get("count", 0)]
                    for ct, kind, label in (
                        ("annotation", "queue", "Waiting for an annotator"),
                        ("annotation", "work", "Annotating (opened → submitted)"),
                        ("review", "queue", "Waiting for a reviewer"),
                        ("review", "work", "Reviewing (opened → decided)"),
                    )
                ],
            )
        )
        quality = pipeline.get("quality") or {}
        if quality.get("decided"):
            parts.append(
                f"Review outcome: {round((quality.get('first_pass_rate') or 0) * 100)}% of {quality['decided']} cases passed first time"
                + (f"; approved cases took {quality['rounds_to_approve']} submissions on average." if quality.get("rounds_to_approve") else ".")
                + "\n"
            )
        flagged = [b for b in pipeline.get("bottlenecks", []) if b.get("flagged")]
        parts.append("## Bottlenecks\n")
        parts.append(
            _table(
                ["Case", "Card", "Assignee", "Waiting for", "Waiting"],
                [
                    [b.get("case_title") or b["case_id"], b["card_type"], b.get("assignee") or "–", ("an annotator to start" if b["card_type"] == "annotation" else "a reviewer to start") if b["kind"] == "queue" else ("the annotation to be submitted" if b["card_type"] == "annotation" else "the review decision"), _duration(b["waiting_ms"])]
                    for b in (flagged or pipeline.get("bottlenecks", [])[:5])
                ],
            )
        )

    screens = usage.get("friction", {}).get("by_screen", [])[:5]
    parts.append("## Screens by friction\n")
    parts.append(
        _table(
            ["Screen", "Score", "Views", "Bounce", "Back & forth", "Dead clicks", "Rage bursts", "Errors"],
            [
                [s["route"], s["score"], s["views"], f"{round(s['bounce_rate'] * 100)}%", f"{round(s['back_rate'] * 100)}%", (f"{round(s['dead_rate'] * 100)}%" if s.get("dead_rate") is not None else "–"), s["rage_bursts"], s["errors"]]
                for s in screens
            ],
        )
    )

    releases = usage.get("releases") or []
    if releases:
        parts.append("## Releases\n")
        parts.append(
            _table(
                ["App", "Build", "First seen", "People", "Cases", "Hands-on / case", "Wait before first action", "No response", "Friction"],
                [
                    [
                        r["app"],
                        r["version"],
                        _date(r["first_seen"]) if r.get("first_seen") else "–",
                        r["people"],
                        r["cases"],
                        _duration(r.get("active_median_ms")),
                        _duration(r.get("first_input_median_ms")),
                        f"{round(r['no_response_rate'] * 100)}%" if r.get("no_response_rate") is not None else "–",
                        r["friction_score"] if r.get("friction_score") is not None else "–",
                    ]
                    for r in releases
                ],
            )
        )

    complexity = usage.get("complexity") or {}
    if complexity.get("cases"):
        parts.append("## What makes a case expensive\n")
        drivers = complexity.get("drivers") or []
        parts.append(
            f"{complexity['cases']} cases worked; median hands-on time per object {_duration(complexity.get('per_object_median_ms'))}."
            + (" Moves with hands-on time: " + ", ".join(f"{d['label']} (r = {d['r']})" for d in drivers) + "." if drivers else "")
            + "\n"
        )
    ratings = usage.get("ratings") or {}
    if ratings.get("count"):
        parts.append(f"Felt difficulty: {ratings['mean']} of 5 from {ratings['count']} answers.\n")
    reasons = usage.get("reject_reasons") or {}
    if reasons.get("total"):
        parts.append("## Why objects were sent back\n")
        parts.append(_table(["Reason", "Rejections", "Share"], [[r["reason"], r["count"], f"{round(r['share'] * 100)}%"] for r in reasons["reasons"]]))
    perf = usage.get("performance") or []
    if perf:
        parts.append("## Slowest requests\n")
        parts.append(
            _table(
                ["Endpoint", "Calls", "Mean", "Worst", "Slow (>1 s)", "Failed"],
                [[r["endpoint"], r["calls"], _duration(r["mean_ms"]), _duration(r["max_ms"]), f"{round(r['slow_share'] * 100)}%", f"{round(r['failure_rate'] * 100)}%"] for r in perf[:8]],
            )
        )

    parts.append("## People\n")
    parts.append(
        _table(
            ["Person", "Sessions", "Total time", "Avg stay", "Back & forth", "Annotated", "Reviewed", "Errors"],
            [
                [u.get("name") or u.get("username") or u["user_id"], u["sessions"], _duration(u["total_ms"]), _duration(u["avg_dwell_ms"]), f"{round(u['back_and_forth'] * 100)}%", u["annotated"], u["reviewed"], u["errors"]]
                for u in usage.get("users", [])[:10]
            ],
        )
    )

    if learning_curve:
        parts.append("## Learning curve\n")
        by_person: dict = {}
        for row in learning_curve:
            by_person.setdefault((row.get("name") or row.get("username") or row["actor_id"], row["card_type"]), []).append(row)
        rows = []
        for (name, card_type), points in sorted(by_person.items()):
            points.sort(key=lambda r: r["week"])
            rows.append([name, card_type, f"week {points[0]['week']}: {_duration(points[0]['median_ms'])}", f"week {points[-1]['week']}: {_duration(points[-1]['median_ms'])}"])
        parts.append(_table(["Person", "Role", "First", "Latest"], rows))

    parts.append("_Generated by VoxelLabel · Usage. Patient data is never recorded._\n")
    return "\n".join(parts)
