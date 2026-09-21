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


def render_markdown(since, until, usage: dict, pipeline: dict | None, findings: list[dict], learning_curve: list[dict] | None) -> str:
    totals = usage.get("totals", {})
    tasks = usage.get("tasks", {})
    parts = [f"# Usage report · {_date(since)} – {_date(until)}\n"]

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
                ["Median time to annotate", f"{_duration(tasks.get('annotate', {}).get('median_ms'))} ({tasks.get('annotate', {}).get('count', 0)} cases)"],
                ["Median time to review", f"{_duration(tasks.get('review', {}).get('median_ms'))} ({tasks.get('review', {}).get('count', 0)} cases)"],
                ["Errors", totals.get("errors", 0)],
                ["Friction score (0–100)", score if score is not None else "–"],
                ["Idle share", f"{round(usage.get('friction', {}).get('idle_share', 0) * 100)}%"],
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
                        ("annotation", "queue", "Waiting to be annotated"),
                        ("annotation", "work", "Being annotated"),
                        ("review", "queue", "Waiting to be reviewed"),
                        ("review", "work", "Being reviewed"),
                    )
                ],
            )
        )
        flagged = [b for b in pipeline.get("bottlenecks", []) if b.get("flagged")]
        parts.append("## Bottlenecks\n")
        parts.append(
            _table(
                ["Case", "Card", "Assignee", "Waiting for", "Waiting"],
                [
                    [b.get("case_title") or b["case_id"], b["card_type"], b.get("assignee") or "–", "someone to start" if b["kind"] == "queue" else "a decision", _duration(b["waiting_ms"])]
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
                [s["route"], s["score"], s["views"], f"{round(s['bounce_rate'] * 100)}%", f"{round(s['back_rate'] * 100)}%", f"{round(s['dead_rate'] * 100)}%", s["rage_bursts"], s["errors"]]
                for s in screens
            ],
        )
    )

    parts.append("## People\n")
    parts.append(
        _table(
            ["Person", "Sessions", "Total time", "Avg stay", "Back & forth", "Annotated", "Reviewed", "Errors"],
            [
                [u.get("username") or u["user_id"], u["sessions"], _duration(u["total_ms"]), _duration(u["avg_dwell_ms"]), f"{round(u['back_and_forth'] * 100)}%", u["annotated"], u["reviewed"], u["errors"]]
                for u in usage.get("users", [])[:10]
            ],
        )
    )

    if learning_curve:
        parts.append("## Learning curve\n")
        by_person: dict = {}
        for row in learning_curve:
            by_person.setdefault((row.get("username") or row["actor_id"], row["card_type"]), []).append(row)
        rows = []
        for (name, card_type), points in sorted(by_person.items()):
            points.sort(key=lambda r: r["week"])
            rows.append([name, card_type, f"week {points[0]['week']}: {_duration(points[0]['median_ms'])}", f"week {points[-1]['week']}: {_duration(points[-1]['median_ms'])}"])
        parts.append(_table(["Person", "Role", "First", "Latest"], rows))

    parts.append("_Generated by VoxelLabel · Usage. Patient data is never recorded._\n")
    return "\n".join(parts)
