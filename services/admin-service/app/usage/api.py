"""HTTP API for usage tracking. Two surfaces: what every signed-in
person's browser talks to (its effective recording config, and the
events it ships), and what only a global admin sees (the switches and
every read the Usage page draws from). `user_id` on a stored event is
always the caller's token subject -- the body never says who."""
import csv
import io
import json
import re
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Iterator, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field
from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import UsageEvent, WorkflowCard
from sqlalchemy.orm import Session

from app.keycloak_admin import list_realm_users
from app.pipeline_health.api import build_learning_curve
from app.pipeline_health.api import build_summary as build_pipeline_summary

from . import stats
from .findings import findings as compute_findings
from .findings import friction_score
from .report import render_markdown
from .settings import CATEGORY_FLAGS, allows, effective_config, get_settings, purge_expired

router = APIRouter(prefix="/admin/usage", tags=["admin:usage"])

MAX_EVENTS_PER_CALL = 500
MAX_TRACE_POINTS = 600
MAX_TEXT = 200
# The only keys a client may put in `detail` -- internal ids, geometry
# and short descriptors. Anything else (and any patient data someone
# might try to smuggle) is dropped before storage.
ALLOWED_DETAIL_KEYS = {
    "study_id", "case_id", "job_id", "series_id", "x", "y", "target", "points", "depth", "viewport", "message", "button",
    # click response signals (see stats._click_signal) and the tutorial-overlay flag
    "responded", "interactive", "pointer", "guide",
}  # fmt: skip
# Id-like runs inside a control's label ("Patient 09a1d4c3…", "Case 20931")
# become "#": they'd split one control into one row per record, and an
# identifier is not what a usage figure is about.
_ID_LIKE = re.compile(r"[0-9A-Fa-f]{6,}|[0-9]{4,}")
# A clock skewed this far ahead is still accepted, stamped "now".
MAX_CLOCK_SKEW = timedelta(minutes=5)

EventType = Literal["page_view", "page_leave", "action", "click", "mouse_trace", "scroll", "key", "focus", "idle", "error"]


class EventIn(BaseModel):
    session_id: str = Field(max_length=64)
    app: Literal["admin-ui", "viewer"]
    event_type: EventType
    route: str = Field(max_length=255)
    name: str | None = Field(default=None, max_length=64)
    detail: dict | None = None
    duration_ms: int | None = Field(default=None, ge=0, le=7 * 24 * 3600 * 1000)
    occurred_at: datetime


class EventsBody(BaseModel):
    events: list[EventIn] = Field(max_length=MAX_EVENTS_PER_CALL)


class SettingsPatch(BaseModel):
    enabled: bool | None = None
    track_pages: bool | None = None
    track_actions: bool | None = None
    track_clicks: bool | None = None
    track_mouse: bool | None = None
    track_scroll: bool | None = None
    track_keys: bool | None = None
    track_errors: bool | None = None
    mouse_sample_ms: int | None = Field(default=None, ge=20, le=2000)
    retention_days: int | None = Field(default=None, ge=1, le=3650)
    exclude_admins: bool | None = None


class UserSwitch(BaseModel):
    """Either switch, or both: `enabled` records the person at all;
    `counted` includes their recorded events in the page's figures."""

    enabled: bool | None = None
    counted: bool | None = None


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


def _clean_detail(detail: dict | None) -> dict | None:
    if not detail:
        return None
    cleaned: dict = {}
    for key, value in detail.items():
        if key not in ALLOWED_DETAIL_KEYS:
            continue
        if key == "points":
            if not isinstance(value, list):
                continue
            cleaned[key] = [
                [int(p[0]), int(p[1]), int(p[2])]
                for p in value[:MAX_TRACE_POINTS]
                if isinstance(p, (list, tuple)) and len(p) == 3 and all(isinstance(v, (int, float)) for v in p)
            ]
        elif key == "viewport":
            if isinstance(value, list) and len(value) == 2 and all(isinstance(v, (int, float)) for v in value):
                cleaned[key] = [int(value[0]), int(value[1])]
        elif key == "target" and isinstance(value, str):
            cleaned[key] = _ID_LIKE.sub("#", value)[:MAX_TEXT]
        elif isinstance(value, str):
            cleaned[key] = value[:MAX_TEXT]
        elif isinstance(value, (int, float, bool)):
            cleaned[key] = value
    return cleaned or None


def _serialize_settings(row) -> dict:
    return {
        "enabled": row.enabled,
        **{flag: getattr(row, flag) for flag in CATEGORY_FLAGS},
        "mouse_sample_ms": row.mouse_sample_ms,
        "retention_days": row.retention_days,
        "disabled_user_ids": list(row.disabled_user_ids or []),
        "excluded_user_ids": list(row.excluded_user_ids or []),
        "exclude_admins": bool(row.exclude_admins),
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _serialize_event(e: UsageEvent) -> dict:
    return {
        "id": str(e.id),
        "user_id": e.user_id,
        "session_id": e.session_id,
        "app": e.app,
        "event_type": e.event_type,
        "route": e.route,
        "name": e.name,
        "detail": e.detail,
        "duration_ms": e.duration_ms,
        "occurred_at": e.occurred_at.isoformat() if e.occurred_at else None,
    }


def _rows_as_dicts(rows: list[UsageEvent]) -> list[dict]:
    return [
        {
            "user_id": e.user_id,
            "session_id": e.session_id,
            "app": e.app,
            "event_type": e.event_type,
            "route": e.route,
            "name": e.name,
            "detail": e.detail,
            "duration_ms": e.duration_ms,
            "occurred_at": e.occurred_at,
        }
        for e in rows
    ]


def _people() -> dict[str, dict]:
    """Every realm account: username, email, whether it holds the global
    admin role. Fetched once per request and passed down."""
    try:
        return {u["id"]: {"username": u.get("username") or u["id"], "email": u.get("email"), "is_admin": bool(u.get("is_admin"))} for u in list_realm_users()}
    except Exception:  # noqa: BLE001 -- names are a nicety, the figures are the point
        return {}


def _usernames() -> dict[str, dict]:
    return _people()


def _not_counted(settings, people: dict[str, dict]) -> set[str]:
    """Accounts recorded but left out of every figure: the explicit
    exclusion list, plus every admin account when exclude_admins is on."""
    out = set(settings.excluded_user_ids or [])
    if settings.exclude_admins:
        out |= {uid for uid, p in people.items() if p.get("is_admin")}
    return out


def _window(days: int, since: datetime | None, until: datetime | None) -> tuple[datetime, datetime]:
    """An explicit `since`/`until` (the Usage page's calendar picker, a
    specific day and hour range) always wins over `days` (the quick
    7/30/90 presets); `until` defaults to now when only `since` is
    given. Both are normalised to timezone-aware UTC -- a naive
    datetime from a client without a `Z`/offset would otherwise compare
    incorrectly against `occurred_at`."""
    if since is None and until is None:
        return datetime.now(timezone.utc) - timedelta(days=days), datetime.now(timezone.utc)
    if since is not None and since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    if until is not None and until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    since, until = since or datetime.now(timezone.utc) - timedelta(days=days), until or datetime.now(timezone.utc)
    if since >= until:
        raise HTTPException(status_code=422, detail="'from' must be before 'to'")
    return since, until


def _load(db: Session, since: datetime, until: datetime, user_id: str | None = None, not_counted: set[str] | None = None) -> list[dict]:
    query = db.query(UsageEvent).filter(UsageEvent.occurred_at >= since, UsageEvent.occurred_at <= until)
    if user_id:
        query = query.filter(UsageEvent.user_id == user_id)
    if not_counted:
        query = query.filter(UsageEvent.user_id.notin_(not_counted))
    return _rows_as_dicts(query.order_by(UsageEvent.occurred_at).all())


def _iso(value) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else value


# ---------------------------------------------------------------- everyone


@router.get("/config")
def read_config(db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    """The recording flags as they apply to the caller -- what their
    browser's tracker turns on. Polled, so a flipped switch reaches every
    open tab without a reload."""
    return effective_config(get_settings(db), user.subject)


@router.post("/events")
def ingest_events(body: EventsBody, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    """Stores the batch under the caller's own subject. Filtered by the
    caller's effective config here too, not just in the browser, so a
    stale tab (or a hand-built request) can't store a category an admin
    switched off. Also the hook for the hourly retention purge."""
    settings = get_settings(db)
    config = effective_config(settings, user.subject)
    accepted = 0
    now = datetime.now(timezone.utc)
    if config["enabled"]:
        for item in body.events:
            if not allows(config, item.event_type):
                continue
            occurred_at = item.occurred_at if item.occurred_at.tzinfo else item.occurred_at.replace(tzinfo=timezone.utc)
            if occurred_at > now + MAX_CLOCK_SKEW:
                occurred_at = now  # a client clock far ahead; keep the event, not the date
            db.add(
                UsageEvent(
                    id=uuid.uuid4(),
                    user_id=user.subject,
                    session_id=item.session_id,
                    app=item.app,
                    event_type=item.event_type,
                    route=item.route,
                    name=item.name,
                    detail=_clean_detail(item.detail),
                    duration_ms=item.duration_ms,
                    occurred_at=occurred_at,
                )
            )
            accepted += 1
        db.commit()
    purge_expired(db, settings)
    return {"accepted": accepted}


# ---------------------------------------------------------------- admin only


@router.get("/settings")
def read_settings(db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    _require_global_admin(user)
    return _serialize_settings(get_settings(db))


@router.put("/settings")
def update_settings(body: SettingsPatch, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    _require_global_admin(user)
    row = get_settings(db)
    for name, value in body.model_dump(exclude_none=True).items():
        setattr(row, name, value)
    db.commit()
    db.refresh(row)
    return _serialize_settings(row)


@router.put("/settings/users/{user_id}")
def set_user_switch(
    user_id: str, body: UserSwitch, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)
) -> dict:
    """Per-person switches. `enabled` false stops recording them at all;
    `counted` false keeps recording but leaves them out of the figures
    (a test or demo account). Everyone not on a list is on."""
    _require_global_admin(user)
    row = get_settings(db)
    if body.enabled is not None:
        disabled = [u for u in (row.disabled_user_ids or []) if u != user_id]
        if not body.enabled:
            disabled.append(user_id)
        row.disabled_user_ids = disabled
    if body.counted is not None:
        excluded = [u for u in (row.excluded_user_ids or []) if u != user_id]
        if not body.counted:
            excluded.append(user_id)
        row.excluded_user_ids = excluded
    db.commit()
    db.refresh(row)
    return _serialize_settings(row)


def _effort_by_type(db: Session, entries: list[dict]) -> dict:
    """case_effort() entries split by the kind of job they were for --
    annotating or reviewing -- via the workflow card the viewer page was
    opened from."""
    job_ids = set()
    for e in entries:
        try:
            job_ids.add(uuid.UUID(e["job_id"]))
        except ValueError:
            continue
    types = {str(c.id): c.type.value for c in db.query(WorkflowCard.id, WorkflowCard.type).filter(WorkflowCard.id.in_(job_ids)).all()} if job_ids else {}
    split: dict[str, list[dict]] = {"annotation": [], "review": []}
    for e in entries:
        kind = types.get(e["job_id"])
        if kind in split:
            split[kind].append(e)
    return {kind: stats.effort_summary(rows) for kind, rows in split.items()} | {"all": stats.effort_summary(entries)}


def build_usage_summary(db: Session, window_since: datetime, window_until: datetime, user_id: str | None = None, people: dict | None = None) -> dict:
    """The /summary payload for an explicit window (usernames resolved,
    friction score and per-case effort attached, excluded accounts left
    out) -- shared by /summary, /overview, /findings and /report.md so a
    finding's number is the number the page shows."""
    people = _people() if people is None else people
    settings = get_settings(db)
    not_counted = _not_counted(settings, people)
    events = _load(db, window_since, window_until, user_id, not_counted)
    summary = stats.summarize(events)
    summary["effort"] = _effort_by_type(db, summary.pop("_effort"))
    for row in summary["users"]:
        row.update({k: v for k, v in people.get(row["user_id"], {"username": row["user_id"], "email": None}).items() if k in ("username", "email")})
        row["last_seen_at"] = _iso(row["last_seen_at"])
    summary["since"] = window_since.isoformat()
    summary["until"] = window_until.isoformat()
    summary["friction_score"] = friction_score(summary)
    summary["recording"] = {
        "enabled": settings.enabled,
        "disabled_user_ids": list(settings.disabled_user_ids or []),
    }
    summary["basis"] = {
        "events": len(events),
        "people": summary["totals"]["active_users"],
        "sessions": summary["totals"]["sessions"],
        "not_counted": len(not_counted),
        "admins_left_out": bool(settings.exclude_admins),
    }
    return summary


def _previous_window(window_since: datetime, window_until: datetime) -> tuple[datetime, datetime]:
    """The same-length period immediately before -- what "vs last period"
    compares against (mirrors admin-ui's previousRange)."""
    return window_since - (window_until - window_since), window_since


def _build_findings_bundle(db: Session, window_since: datetime, window_until: datetime, user_id: str | None) -> dict:
    prev_since, prev_until = _previous_window(window_since, window_until)
    people = _people()
    usage = build_usage_summary(db, window_since, window_until, user_id, people)
    usage_previous = build_usage_summary(db, prev_since, prev_until, user_id, people)
    pipeline = build_pipeline_summary(db, window_since, window_until, person_id=user_id)
    pipeline_previous = build_pipeline_summary(db, prev_since, prev_until, person_id=user_id)
    learning = build_learning_curve(db)
    return {
        "since": window_since.isoformat(),
        "until": window_until.isoformat(),
        "usage": usage,
        "usage_previous": usage_previous,
        "pipeline": pipeline,
        "pipeline_previous": pipeline_previous,
        "learning_curve": learning,
        "findings": compute_findings(usage, usage_previous, pipeline, pipeline_previous, learning),
    }


@router.get("/summary")
def read_summary(
    days: int = Query(30, ge=1, le=365),
    since: datetime | None = Query(None, alias="from"),
    until: datetime | None = Query(None, alias="to"),
    user_id: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)
    window_since, window_until = _window(days, since, until)
    return {"days": days, **build_usage_summary(db, window_since, window_until, user_id)}


@router.get("/overview")
def read_overview(
    days: int = Query(30, ge=1, le=365),
    since: datetime | None = Query(None, alias="from"),
    until: datetime | None = Query(None, alias="to"),
    user_id: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Everything the Usage page needs for one window in one call: the
    usage summary and the previous period's, the pipeline figures and
    theirs, the learning curve and the findings drawn from all of it.
    Each is computed once -- the page used to ask for the same summary
    four times over."""
    _require_global_admin(user)
    window_since, window_until = _window(days, since, until)
    bundle = _build_findings_bundle(db, window_since, window_until, user_id)
    return {
        "since": bundle["since"],
        "until": bundle["until"],
        "summary": bundle["usage"],
        "previous": bundle["usage_previous"],
        "pipeline": bundle["pipeline"],
        "pipeline_previous": bundle["pipeline_previous"],
        "learning_curve": bundle["learning_curve"],
        "findings": bundle["findings"],
    }


@router.get("/people")
def read_people(db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    """Every account with its two switches -- recorded at all, counted in
    the figures -- for the Settings tab. Admin accounts show as not
    counted while exclude_admins is on, whatever their own switch says."""
    _require_global_admin(user)
    settings = get_settings(db)
    disabled = set(settings.disabled_user_ids or [])
    excluded = set(settings.excluded_user_ids or [])
    rows = []
    for uid, p in _people().items():
        rows.append(
            {
                "user_id": uid,
                "username": p["username"],
                "email": p.get("email"),
                "is_admin": p.get("is_admin", False),
                "recorded": bool(settings.enabled) and uid not in disabled,
                "counted": uid not in excluded and not (settings.exclude_admins and p.get("is_admin")),
                "counted_switch": uid not in excluded,
            }
        )
    rows.sort(key=lambda r: (r["is_admin"], r["username"].lower()))
    return rows


@router.get("/findings")
def read_findings(
    days: int = Query(30, ge=1, le=365),
    since: datetime | None = Query(None, alias="from"),
    until: datetime | None = Query(None, alias="to"),
    user_id: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """The page's own first pass at "so what?" -- see findings.py. Returns
    the findings plus the exact summaries they were derived from, so the
    Overview can render both from one call."""
    _require_global_admin(user)
    window_since, window_until = _window(days, since, until)
    bundle = _build_findings_bundle(db, window_since, window_until, user_id)
    return {"since": bundle["since"], "until": bundle["until"], "findings": bundle["findings"], "friction_score": bundle["usage"]["friction_score"]}


@router.get("/report.md")
def read_report(
    days: int = Query(30, ge=1, le=365),
    since: datetime | None = Query(None, alias="from"),
    until: datetime | None = Query(None, alias="to"),
    user_id: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> PlainTextResponse:
    """The Overview as Markdown, for pasting into Jira/Slack/e-mail --
    rendered from the same bundle /findings uses."""
    _require_global_admin(user)
    window_since, window_until = _window(days, since, until)
    bundle = _build_findings_bundle(db, window_since, window_until, user_id)
    text = render_markdown(window_since, window_until, bundle["usage"], bundle["pipeline"], bundle["findings"], bundle["learning_curve"])
    return PlainTextResponse(text, media_type="text/markdown; charset=utf-8")


EXPORT_COLUMNS = ["occurred_at", "user_id", "username", "session_id", "app", "event_type", "route", "name", "duration_ms", "detail"]


def _safe_cell(value):
    """A text cell a spreadsheet would run as a formula (=, +, -, @,
    tab, CR at the start) gets a leading apostrophe -- shown as text."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def _events_csv(db: Session, window_since: datetime, window_until: datetime, user_id: str | None, include_mouse: bool) -> Iterator[str]:
    """Streams one CSV row per event -- a generator so a 90-day window
    is never built in memory. Mouse traces (bulky, rarely wanted in a
    spreadsheet) only with include_mouse. `detail` is JSON text."""
    people = _people()
    names = people
    not_counted = _not_counted(get_settings(db), people)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(EXPORT_COLUMNS)
    yield "﻿" + buffer.getvalue()  # BOM so Excel reads UTF-8 correctly
    buffer.seek(0)
    buffer.truncate(0)
    query = db.query(UsageEvent).filter(UsageEvent.occurred_at >= window_since, UsageEvent.occurred_at <= window_until)
    if user_id:
        query = query.filter(UsageEvent.user_id == user_id)
    if not include_mouse:
        query = query.filter(UsageEvent.event_type != "mouse_trace")
    if not_counted:
        query = query.filter(UsageEvent.user_id.notin_(not_counted))
    for e in query.order_by(UsageEvent.occurred_at).yield_per(1000):
        writer.writerow(
            [_safe_cell(v) for v in [
                e.occurred_at.isoformat() if e.occurred_at else "",
                e.user_id,
                names.get(e.user_id, {}).get("username", e.user_id),
                e.session_id,
                e.app,
                e.event_type,
                e.route,
                e.name or "",
                e.duration_ms if e.duration_ms is not None else "",
                json.dumps(e.detail, separators=(",", ":")) if e.detail else "",
            ]]
        )
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)


@router.get("/export/events.csv")
def export_events_csv(
    days: int = Query(30, ge=1, le=365),
    since: datetime | None = Query(None, alias="from"),
    until: datetime | None = Query(None, alias="to"),
    user_id: str | None = None,
    include_mouse: bool = False,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> StreamingResponse:
    """Every recorded event in the window as CSV, for analysis outside
    the platform (Python/R/BI). Internal ids and short control
    descriptors only -- the same "never patient data, never typed text"
    rule ingestion enforces."""
    _require_global_admin(user)
    window_since, window_until = _window(days, since, until)
    name = f"usage-events-{window_since.strftime('%Y%m%d')}-{window_until.strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        _events_csv(db, window_since, window_until, user_id, include_mouse),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@router.get("/sessions")
def list_sessions(
    days: int = Query(30, ge=1, le=365),
    since: datetime | None = Query(None, alias="from"),
    until: datetime | None = Query(None, alias="to"),
    user_id: str | None = None,
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    _require_global_admin(user)
    window_since, window_until = _window(days, since, until)
    names = _usernames()
    rows = stats.sessions(_load(db, window_since, window_until, user_id))[:limit]
    for s in rows:
        s["username"] = names.get(s["user_id"], {}).get("username", s["user_id"])
        s["started_at"] = _iso(s["started_at"])
        s["ended_at"] = _iso(s["ended_at"])
    return rows


@router.get("/sessions/{session_id}")
def read_session(session_id: str, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    """The full ordered timeline of one sitting, mouse traces and clicks
    included -- what the replay panel plays back."""
    _require_global_admin(user)
    rows = db.query(UsageEvent).filter(UsageEvent.session_id == session_id).order_by(UsageEvent.occurred_at).all()
    if not rows:
        raise HTTPException(status_code=404, detail="Session not found")
    names = _usernames()
    return {
        "session_id": session_id,
        "user_id": rows[0].user_id,
        "username": names.get(rows[0].user_id, {}).get("username", rows[0].user_id),
        "app": rows[0].app,
        "events": [_serialize_event(e) for e in rows],
    }


@router.get("/heatmap")
def read_heatmap(
    route: str,
    days: int = Query(30, ge=1, le=365),
    since: datetime | None = Query(None, alias="from"),
    until: datetime | None = Query(None, alias="to"),
    user_id: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)
    window_since, window_until = _window(days, since, until)
    query = db.query(UsageEvent).filter(
        UsageEvent.occurred_at >= window_since,
        UsageEvent.occurred_at <= window_until,
        UsageEvent.event_type == "click",
        UsageEvent.route == route,
    )
    if user_id:
        query = query.filter(UsageEvent.user_id == user_id)
    names = _people()
    not_counted = _not_counted(get_settings(db), names)
    if not_counted:
        query = query.filter(UsageEvent.user_id.notin_(not_counted))
    rows = query.order_by(UsageEvent.occurred_at).all()
    points = stats.click_points(_rows_as_dicts(rows), route)
    # Who clicked, most clicks first -- the heatmap's legend and colour key.
    clicks_by_user = Counter(p["user_id"] for p in points)
    users = [
        {"user_id": user_id, "username": names.get(user_id, {}).get("username", user_id), "clicks": n}
        for user_id, n in sorted(clicks_by_user.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    return {"route": route, "days": days, "points": points, "users": users}
