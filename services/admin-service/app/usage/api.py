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
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from statistics import mean, median
from typing import Iterator, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field
from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import (
    Annotation,
    AnnotationStatus,
    Case,
    ImagingStudy,
    Instance,
    Series,
    Study,
    UsageClear,
    UsageEvent,
    UsageSnapshot,
    WorkflowCard,
)
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.audit import record as audit
from app.keycloak_admin import list_realm_users
from app.pipeline_health.api import build_learning_curve
from app.pipeline_health.api import build_summary as build_pipeline_summary

from . import clearing, snapshots, stats
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
    # page_view: input device; actions: review decision, rejection reason,
    # a finished case's difficulty rating, tutorial step
    "device", "decision", "reason", "rating", "task", "step", "steps",
    # perf: one API endpoint's timings aggregated over a flush interval
    "endpoint", "count", "ms", "max", "slow", "failures",
    # layout: the screen as boxes (see _clean_layout), and its background
    "elements", "bg",
    # click: where inside its target element (0..1)
    "rx", "ry",
}  # fmt: skip
MAX_LAYOUT_ELEMENTS = 400
LAYOUT_KINDS = {"panel", "media", "heading", "button", "link", "input"}
_CSS_COLOR = re.compile(r"^(#[0-9a-fA-F]{3,8}|rgba?\([0-9., ]+\))$")
# Id-like runs inside a control's label ("Patient 09a1d4c3…", "Case 20931")
# become "#": they'd split one control into one row per record, and an
# identifier is not what a usage figure is about.
_ID_LIKE = re.compile(r"[0-9A-Fa-f]{6,}|[0-9]{4,}")
# A clock skewed this far ahead is still accepted, stamped "now".
MAX_CLOCK_SKEW = timedelta(minutes=5)

EventType = Literal["page_view", "page_leave", "action", "click", "mouse_trace", "scroll", "key", "focus", "idle", "error", "perf", "layout"]


class EventIn(BaseModel):
    session_id: str = Field(max_length=64)
    app: Literal["admin-ui", "viewer"]
    event_type: EventType
    route: str = Field(max_length=255)
    name: str | None = Field(default=None, max_length=64)
    detail: dict | None = None
    duration_ms: int | None = Field(default=None, ge=0, le=7 * 24 * 3600 * 1000)
    occurred_at: datetime
    app_version: str | None = Field(default=None, max_length=40)


class SnapshotIn(BaseModel):
    """One screen snapshot from the tracker (captureSnapshot): its HTML
    (plain or gzip+base64) and, the first time a build's stylesheets are
    seen in a session, those too -- keyed by css_hash either way."""

    session_id: str = Field(max_length=64)
    app: Literal["admin-ui", "viewer"]
    app_version: str | None = Field(default=None, max_length=40)
    route: str = Field(max_length=255)
    job_id: str | None = Field(default=None, max_length=64)
    viewport: list[int] = Field(min_length=2, max_length=2)
    occurred_at: datetime
    html: str | None = None
    html_gz: str | None = Field(default=None, max_length=4_000_000)
    css_hash: str | None = Field(default=None, max_length=64)
    css: str | None = None
    css_gz: str | None = Field(default=None, max_length=3_000_000)
    anchors: list | None = Field(default=None, max_length=2000)
    study_id: str | None = Field(default=None, max_length=64)
    structure_key: str | None = Field(default=None, max_length=64)


def _clean_anchors(value: list | None) -> list | None:
    """[[descriptor, x, y, w, h], ...] -- descriptors normalised exactly
    as click targets are (see _clean_detail), so the two match."""
    if not value:
        return None
    out = []
    for a in value[:2000]:
        if isinstance(a, (list, tuple)) and len(a) == 5 and isinstance(a[0], str) and all(isinstance(v, (int, float)) and -10_000 <= v <= 20_000 for v in a[1:]):
            out.append([_ID_LIKE.sub("#", a[0])[:MAX_TEXT], *(int(v) for v in a[1:])])
    return out or None


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
    track_perf: bool | None = None
    track_screen_images: bool | None = None
    rating_every_n: int | None = Field(default=None, ge=0, le=50)


class UserSwitch(BaseModel):
    """Either switch, or both: `enabled` records the person at all;
    `counted` includes their recorded events in the page's figures."""

    enabled: bool | None = None
    counted: bool | None = None


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


def _clean_color(value) -> str | None:
    return value if isinstance(value, str) and len(value) <= 32 and _CSS_COLOR.match(value) else None


def _clean_layout(value) -> list | None:
    """[x, y, w, h, kind, label?, background?] boxes only: numbers in
    range, a known kind, a short label with id-like runs masked, a CSS
    colour -- anything else in a box is dropped."""
    if not isinstance(value, list):
        return None
    out = []
    for box in value[:MAX_LAYOUT_ELEMENTS]:
        if not isinstance(box, (list, tuple)) or len(box) < 5 or box[4] not in LAYOUT_KINDS:
            continue
        if not all(isinstance(v, (int, float)) and -10_000 <= v <= 20_000 for v in box[:4]):
            continue
        clean = [int(v) for v in box[:4]] + [box[4]]
        label = box[5] if len(box) > 5 and isinstance(box[5], str) else ""
        color = _clean_color(box[6]) if len(box) > 6 else None
        # only controls and headings carry words; an image or a field never does
        label = _ID_LIKE.sub("#", label)[:40] if box[4] in ("button", "link", "heading") else ""
        if label or color:
            clean.append(label)
        if color:
            clean.append(color)
        out.append(clean)
    return out


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
        elif key == "elements":
            boxes = _clean_layout(value)
            if boxes is not None:
                cleaned[key] = boxes
        elif key == "bg":
            color = _clean_color(value)
            if color:
                cleaned[key] = color
        elif key == "viewport":
            if isinstance(value, list) and len(value) == 2 and all(isinstance(v, (int, float)) for v in value):
                cleaned[key] = [int(value[0]), int(value[1])]
        elif key in ("target", "endpoint") and isinstance(value, str):
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
        "rating_every_n": row.rating_every_n,
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
        "app_version": e.app_version,
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
            "app_version": e.app_version,
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


_MODIFIERS = ("Ctrl+", "Meta+", "Alt+")


def _key_name(name: str | None) -> str | None:
    """A shortcut stays as it is; a plain character (with or without Shift)
    is stored as "char" -- which character was typed is never kept, even
    from an older client that still sends it (K1)."""
    if not name:
        return name
    bare = name[len("Shift+"):] if name.startswith("Shift+") else name
    if len(bare) == 1 and bare != " " and not name.startswith(_MODIFIERS):
        return "char"
    return name


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
                    name=_key_name(item.name) if item.event_type == "key" else item.name,
                    detail=_clean_detail(item.detail),
                    duration_ms=item.duration_ms,
                    occurred_at=occurred_at,
                    app_version=item.app_version,
                )
            )
            accepted += 1
        db.commit()
    purge_expired(db, settings)
    return {"accepted": accepted}


@router.post("/snapshots")
def ingest_snapshot(body: SnapshotIn, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    """Stores one screen snapshot under the caller's own subject -- only
    while their clicks are being recorded (the snapshot is the picture
    behind those clicks). Cleaned again here; see snapshots.py."""
    settings = get_settings(db)
    if not allows(effective_config(settings, user.subject), "click"):
        return {"stored": False}
    keep_images = bool(effective_config(settings, user.subject).get("track_screen_images"))
    try:
        html = snapshots.decode(body.html, body.html_gz, snapshots.MAX_HTML_BYTES)
        css = snapshots.decode(body.css, body.css_gz, snapshots.MAX_CSS_BYTES)
    except snapshots.SnapshotTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    if not html:
        raise HTTPException(status_code=422, detail="html is required")
    style = snapshots.style_key(user.subject, body.css_hash) if body.css_hash else None
    if css and style:
        snapshots.store_style(db, style, css)
    occurred_at = body.occurred_at if body.occurred_at.tzinfo else body.occurred_at.replace(tzinfo=timezone.utc)
    cleaned = snapshots.clean_html(html, keep_images=keep_images)
    db.add(
        UsageSnapshot(
            id=uuid.uuid4(),
            user_id=user.subject,
            session_id=body.session_id,
            app=body.app,
            app_version=body.app_version,
            route=body.route,
            job_id=body.job_id,
            viewport_w=max(1, min(body.viewport[0], 20_000)),
            viewport_h=max(1, min(body.viewport[1], 20_000)),
            html_gz=snapshots.gz(cleaned),
            has_images=snapshots.has_images(cleaned),
            css_hash=style,
            occurred_at=min(occurred_at, datetime.now(timezone.utc) + MAX_CLOCK_SKEW),
            anchors=_clean_anchors(body.anchors),
            study_id=body.study_id,
            structure_key=body.structure_key,
        )
    )
    db.flush()
    snapshots.trim(db, body.app, body.route, user.subject)
    db.commit()
    return {"stored": True}


# ---------------------------------------------------------------- admin only


@router.get("/snapshots/{snapshot_id}")
def read_snapshot(snapshot_id: uuid.UUID, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    """One snapshot as a self-contained HTML document, for a sandboxed
    iframe (scripts never run in it)."""
    _require_global_admin(user)
    snap = db.get(UsageSnapshot, snapshot_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    return {**snapshots.meta(snap), "document": snapshots.as_document(db, snap)}


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
    audit(db, user, "usage_settings.update", "settings", "usage", body.model_dump(exclude_none=True))
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
    audit(db, user, "usage_user_switch.update", "user", user_id, body.model_dump(exclude_none=True))
    db.commit()
    db.refresh(row)
    return _serialize_settings(row)


class ClearIn(BaseModel):
    # Must be sent explicitly -- a stray POST never empties the log.
    confirm: Literal[True]


def _clear_or_404(db: Session, clear_id: str) -> UsageClear:
    try:
        row = db.get(UsageClear, uuid.UUID(clear_id))
    except ValueError:
        row = None
    if row is None:
        raise HTTPException(status_code=404, detail="Clear not found")
    return row


def _clears_payload(db: Session) -> dict:
    remaining = clearing.archived_counts(db)
    names = _people()
    rows = db.query(UsageClear).order_by(UsageClear.cleared_at.desc()).all()
    return {"live": clearing.live_counts(db), "clears": [clearing.serialize(c, remaining.get(str(c.id)), names) for c in rows]}


@router.get("/clears")
def list_clears(db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    """What is in the live log now, and every clear so far -- restorable
    ones first in line for the Settings tab's "Cleared logs" list."""
    _require_global_admin(user)
    return _clears_payload(db)


@router.post("/clear")
def clear_log(body: ClearIn, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    """Empties the usage log -- every event and screen snapshot moves to
    the archive, restorable until deleted for good (or aged out by the
    retention period). 409 when the log is already empty."""
    _require_global_admin(user)
    clear = clearing.clear_all(db, user.subject)
    if clear is None:
        db.rollback()
        raise HTTPException(status_code=409, detail="The usage log is already empty.")
    audit(db, user, "usage.clear", "usage_clear", clear.id, {"events": clear.events, "snapshots": clear.snapshots})
    db.commit()
    db.refresh(clear)
    return {"clear": clearing.serialize(clear, {"events": clear.events, "snapshots": clear.snapshots}, _people()), **_clears_payload(db)}


@router.post("/clears/{clear_id}/restore")
def restore_clear(clear_id: str, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    """Puts a cleared log back; whatever was recorded since stays too."""
    _require_global_admin(user)
    clear = _clear_or_404(db, clear_id)
    try:
        back = clearing.restore(db, clear, user.subject)
    except clearing.ClearStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    audit(db, user, "usage.restore", "usage_clear", clear.id, back)
    db.commit()
    return {"restored": back, **_clears_payload(db)}


@router.delete("/clears/{clear_id}")
def delete_clear(clear_id: str, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    """Deletes a cleared log's data for good. Cannot be undone."""
    _require_global_admin(user)
    clear = _clear_or_404(db, clear_id)
    try:
        clearing.delete_for_good(db, clear, user.subject)
    except clearing.ClearStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    audit(db, user, "usage.delete_cleared", "usage_clear", clear.id, None)
    db.commit()
    return _clears_payload(db)


def _card_types(db: Session, entries: list[dict]) -> dict[str, str]:
    """job_id -> "annotation" / "review", for the jobs the viewer was opened from."""
    job_ids = set()
    for e in entries:
        try:
            job_ids.add(uuid.UUID(e["job_id"]))
        except ValueError:
            continue
    if not job_ids:
        return {}
    return {str(c.id): c.type.value for c in db.query(WorkflowCard.id, WorkflowCard.type).filter(WorkflowCard.id.in_(job_ids)).all()}


def _effort_by_type(entries: list[dict], card_types: dict[str, str]) -> dict:
    """case_effort() entries split by the kind of job they were for --
    annotating or reviewing."""
    split: dict[str, list[dict]] = {"annotation": [], "review": []}
    for e in entries:
        kind = card_types.get(e["job_id"])
        if kind in split:
            split[kind].append(e)
    return {kind: stats.effort_summary(rows) for kind, rows in split.items()} | {"all": stats.effort_summary(entries)}


MAX_CASE_ROWS = 300


def _case_table(db: Session, entries: list[dict], rating_rows: list[dict], card_types: dict[str, str], people: dict[str, dict]) -> tuple[list[dict], dict]:
    """One row per case worked in the viewer in the window, with what
    made it hard: slices in its largest series, objects in its latest
    annotation, times it was sent back, and the felt difficulty people
    reported -- next to the hands-on time it took. Plus a summary of how
    strongly each of those moves with hands-on time."""
    case_ids: set[uuid.UUID] = set()
    for e in entries:
        try:
            case_ids.add(uuid.UUID(e["case_id"]))
        except ValueError:
            continue
    if not case_ids:
        return [], {"cases": 0, "per_object_median_ms": None, "drivers": []}
    titles = {str(c.id): c.title for c in db.query(Case.id, Case.title).filter(Case.id.in_(case_ids)).all()}
    series_rows = (
        db.query(ImagingStudy.case_id, Series.id, func.count(Instance.id))
        .join(Series, Series.imaging_study_id == ImagingStudy.id)
        .outerjoin(Instance, Instance.series_id == Series.id)
        .filter(ImagingStudy.case_id.in_(case_ids))
        .group_by(ImagingStudy.case_id, Series.id)
        .all()
    )
    slices: dict[str, int] = {}
    case_of_series: dict[uuid.UUID, str] = {}
    for case_id, series_id, n in series_rows:
        slices[str(case_id)] = max(slices.get(str(case_id), 0), int(n))
        case_of_series[series_id] = str(case_id)
    objects: dict[str, int] = {}
    rejections: Counter = Counter()
    if case_of_series:
        for target_id, payload, status in (
            db.query(Annotation.target_id, Annotation.payload, Annotation.status)
            .filter(Annotation.target_type == "series", Annotation.target_id.in_(case_of_series.keys()))
            .order_by(Annotation.created_at)
            .all()
        ):
            cid = case_of_series.get(target_id)
            if cid is None:
                continue
            objects[cid] = len((payload or {}).get("objects") or [])  # the latest version wins
            if status == AnnotationStatus.REJECTED:
                rejections[cid] += 1
    felt: dict[tuple, list[int]] = defaultdict(list)
    for r in rating_rows:
        felt[(str(r.get("job_id")), str(r.get("case_id")))].append(r["rating"])

    rows = []
    for e in entries:
        n_objects = objects.get(e["case_id"])
        ratings_here = felt.get((e["job_id"], e["case_id"]), [])
        rows.append(
            {
                "case_id": e["case_id"],
                "case_title": titles.get(e["case_id"]),
                "job_id": e["job_id"],
                "job_type": card_types.get(e["job_id"]),
                "people": [people.get(uid, {}).get("username", uid) for uid in e["user_ids"]],
                "sittings": e["sittings"],
                "active_ms": e["active_ms"],
                "slices": slices.get(e["case_id"]),
                "objects": n_objects,
                "per_object_ms": int(e["active_ms"] / n_objects) if n_objects and e["active_ms"] else None,
                "undos": e["undos"],
                "first_input_ms": int(median(e["first_input_ms"])) if e["first_input_ms"] else None,
                "rating": round(mean(ratings_here), 1) if ratings_here else None,
                "sent_back": rejections.get(e["case_id"], 0),
            }
        )
    rows.sort(key=lambda r: (-r["active_ms"], r["case_id"]))
    worked = [r for r in rows if r["active_ms"] > 0]
    active = [r["active_ms"] for r in worked]
    drivers = []
    for factor, label in (("objects", "objects drawn"), ("slices", "slices in the series"), ("rating", "felt difficulty"), ("sent_back", "times sent back"), ("undos", "undos")):
        r = stats.correlation([row[factor] for row in worked], active)
        if r is not None:
            drivers.append({"factor": factor, "label": label, "r": r, "n": sum(1 for row in worked if row[factor] is not None)})
    drivers.sort(key=lambda d: -abs(d["r"]))
    per_object = [r["per_object_ms"] for r in worked if r["per_object_ms"]]
    return rows[:MAX_CASE_ROWS], {"cases": len(worked), "per_object_median_ms": int(median(per_object)) if per_object else None, "drivers": drivers}


def build_usage_summary(db: Session, window_since: datetime, window_until: datetime, user_id: str | None = None, people: dict | None = None, study_id: str | None = None) -> dict:
    """The /summary payload for an explicit window (usernames resolved,
    friction score and per-case effort attached, excluded accounts left
    out) -- shared by /summary, /overview, /findings and /report.md so a
    finding's number is the number the page shows."""
    people = _people() if people is None else people
    settings = get_settings(db)
    not_counted = _not_counted(settings, people)
    events = _load(db, window_since, window_until, user_id, not_counted)
    if study_id:
        events = stats.within_study(events, study_id)
    summary = stats.summarize(events)
    entries, rating_rows = summary.pop("_effort"), summary.pop("_ratings")
    card_types = _card_types(db, entries)
    summary["effort"] = _effort_by_type(entries, card_types)
    summary["cases"], summary["complexity"] = _case_table(db, entries, rating_rows, card_types, people)
    for row in summary["releases"]:
        row["first_seen"], row["last_seen"] = _iso(row["first_seen"]), _iso(row["last_seen"])
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


def _build_findings_bundle(db: Session, window_since: datetime, window_until: datetime, user_id: str | None, study_id: str | None = None) -> dict:
    prev_since, prev_until = _previous_window(window_since, window_until)
    people = _people()
    usage = build_usage_summary(db, window_since, window_until, user_id, people, study_id)
    usage_previous = build_usage_summary(db, prev_since, prev_until, user_id, people, study_id)
    pipeline = build_pipeline_summary(db, window_since, window_until, person_id=user_id, study_id=study_id)
    pipeline_previous = build_pipeline_summary(db, prev_since, prev_until, person_id=user_id, study_id=study_id)
    not_counted = _not_counted(get_settings(db), people)
    try:
        study_uuid = uuid.UUID(study_id) if study_id else None
    except ValueError:
        raise HTTPException(status_code=422, detail=f"'{study_id}' is not a valid id") from None
    learning = build_learning_curve(db, person_id=user_id, study_id=study_uuid, not_counted=not_counted)
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
    study_id: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)
    window_since, window_until = _window(days, since, until)
    return {"days": days, **build_usage_summary(db, window_since, window_until, user_id, study_id=study_id)}


@router.get("/overview")
def read_overview(
    days: int = Query(30, ge=1, le=365),
    since: datetime | None = Query(None, alias="from"),
    until: datetime | None = Query(None, alias="to"),
    user_id: str | None = None,
    study_id: str | None = None,
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
    bundle = _build_findings_bundle(db, window_since, window_until, user_id, study_id)
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
    study_id: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """The page's own first pass at "so what?" -- see findings.py. Returns
    the findings plus the exact summaries they were derived from, so the
    Overview can render both from one call."""
    _require_global_admin(user)
    window_since, window_until = _window(days, since, until)
    bundle = _build_findings_bundle(db, window_since, window_until, user_id, study_id)
    return {"since": bundle["since"], "until": bundle["until"], "findings": bundle["findings"], "friction_score": bundle["usage"]["friction_score"]}


@router.get("/report.md")
def read_report(
    days: int = Query(30, ge=1, le=365),
    since: datetime | None = Query(None, alias="from"),
    until: datetime | None = Query(None, alias="to"),
    user_id: str | None = None,
    study_id: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> PlainTextResponse:
    """The Overview as Markdown, for pasting into Jira/Slack/e-mail --
    rendered from the same bundle /findings uses."""
    _require_global_admin(user)
    window_since, window_until = _window(days, since, until)
    bundle = _build_findings_bundle(db, window_since, window_until, user_id, study_id)
    scope = []
    if user_id:
        scope.append(f"person {_people().get(user_id, {}).get('username', user_id)}")
    if study_id:
        study = db.get(Study, uuid.UUID(study_id))
        scope.append(f"study {study.name if study else study_id}")
    text = render_markdown(
        window_since, window_until, bundle["usage"], bundle["pipeline"], bundle["findings"], bundle["learning_curve"], scope=" · ".join(scope) or None
    )
    return PlainTextResponse(text, media_type="text/markdown; charset=utf-8")


EXPORT_COLUMNS = ["occurred_at", "user_id", "username", "session_id", "app", "event_type", "route", "name", "duration_ms", "detail", "app_version"]


def _safe_cell(value):
    """A text cell a spreadsheet would run as a formula (=, +, -, @,
    tab, CR at the start) gets a leading apostrophe -- shown as text."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def _events_csv(db: Session, window_since: datetime, window_until: datetime, user_id: str | None, include_mouse: bool, study_id: str | None = None) -> Iterator[str]:
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
        # the bulky visual records: pointer traces and screen layouts
        query = query.filter(UsageEvent.event_type.notin_(("mouse_trace", "layout")))
    if not_counted:
        query = query.filter(UsageEvent.user_id.notin_(not_counted))
    if study_id:
        # the sittings that opened a page of the study; within them, only
        # the events on its pages -- stats.within_study's rule, which every
        # study-filtered figure uses. Whole sessions made the spreadsheet
        # disagree with the page (H-01).
        sessions_of_study = db.query(UsageEvent.session_id).filter(UsageEvent.event_type == "page_view", UsageEvent.detail["study_id"].astext == study_id).distinct()
        query = query.filter(UsageEvent.session_id.in_(sessions_of_study))
    page_study: dict[str, str | None] = {}  # session -> the study of its current page
    for e in query.order_by(UsageEvent.occurred_at, UsageEvent.id).yield_per(1000):
        if study_id:
            if e.event_type == "page_view":
                page_study[e.session_id] = (e.detail or {}).get("study_id")
            if page_study.get(e.session_id) != study_id:
                continue
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
                e.app_version or "",
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
    study_id: str | None = None,
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
        _events_csv(db, window_since, window_until, user_id, include_mouse, study_id),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@router.get("/sessions")
def list_sessions(
    days: int = Query(30, ge=1, le=365),
    since: datetime | None = Query(None, alias="from"),
    until: datetime | None = Query(None, alias="to"),
    user_id: str | None = None,
    study_id: str | None = None,
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    _require_global_admin(user)
    window_since, window_until = _window(days, since, until)
    names = _usernames()
    events = _load(db, window_since, window_until, user_id)
    if study_id:
        events = stats.within_study(events, study_id)
    rows = stats.sessions(events)[:limit]
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
    events = [_serialize_event(e) for e in rows]
    job_types = _job_types(db, {(e["detail"] or {}).get("job_id") for e in events if e["event_type"] == "page_view"})
    for e in events:
        job_id = (e["detail"] or {}).get("job_id") if e["event_type"] == "page_view" else None
        if job_id in job_types:
            e["detail"] = {**e["detail"], "job_type": job_types[job_id]}
    snaps = db.query(UsageSnapshot).filter(UsageSnapshot.session_id == session_id).order_by(UsageSnapshot.occurred_at).all()
    return {
        "session_id": session_id,
        "user_id": rows[0].user_id,
        "username": names.get(rows[0].user_id, {}).get("username", rows[0].user_id),
        "app": rows[0].app,
        "events": events,
        "snapshots": [snapshots.meta(snap) for snap in snaps],
    }


def _job_types(db: Session, job_ids: set) -> dict[str, str]:
    """job_id -> "annotation" / "review" for the ids that are job cards."""
    ids = set()
    for j in job_ids:
        try:
            ids.add(uuid.UUID(str(j)))
        except (TypeError, ValueError):
            continue
    if not ids:
        return {}
    return {str(c.id): c.type.value for c in db.query(WorkflowCard.id, WorkflowCard.type).filter(WorkflowCard.id.in_(ids)).all() if c.type.value in ("annotation", "review")}


@router.get("/heatmap")
def read_heatmap(
    route: str,
    days: int = Query(30, ge=1, le=365),
    since: datetime | None = Query(None, alias="from"),
    until: datetime | None = Query(None, alias="to"),
    user_id: str | None = None,
    study_id: str | None = None,
    mode: Literal["annotation", "review", "other"] | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Every click on one screen, each with who made it, whether it got a
    response and the kind of job it was made in (annotation / review /
    other -- `mode` filters to one), plus the most recent recorded
    layout of that screen (in that kind of job), to draw behind them."""
    _require_global_admin(user)
    window_since, window_until = _window(days, since, until)
    query = db.query(UsageEvent).filter(
        UsageEvent.occurred_at >= window_since,
        UsageEvent.occurred_at <= window_until,
        UsageEvent.event_type.in_(("click", "page_view", "layout")),
        UsageEvent.route == route,
    )
    if user_id:
        query = query.filter(UsageEvent.user_id == user_id)
    names = _people()
    not_counted = _not_counted(get_settings(db), names)
    if not_counted:
        query = query.filter(UsageEvent.user_id.notin_(not_counted))
    events = _rows_as_dicts(query.order_by(UsageEvent.occurred_at).all())
    points = stats.click_points(events, route)
    if study_id:
        points = [p for p in points if p["study_id"] == study_id]
    layouts = stats.screen_layouts(events, route)
    snap_query = db.query(UsageSnapshot).filter(UsageSnapshot.route == route)
    if study_id:
        snap_query = snap_query.filter(UsageSnapshot.study_id == study_id)
    snaps = snap_query.order_by(UsageSnapshot.occurred_at.desc()).limit(snapshots.KEEP_PER_SCREEN).all()
    job_types = _job_types(db, {p["job_id"] for p in points} | {lay["job_id"] for lay in layouts} | {snap.job_id for snap in snaps})
    for p in points:
        p["mode"] = job_types.get(p.pop("job_id"), "other")
    for lay in layouts:
        lay["mode"] = job_types.get(lay.pop("job_id"), "other")
    modes = Counter(p["mode"] for p in points)
    if mode:
        points = [p for p in points if p["mode"] == mode]
    layout = next((lay for lay in layouts if not mode or lay["mode"] == mode), None)
    # the picture that can show the most of these clicks on their element
    # (newest first among equals) -- screens differ between people and cases
    candidates = [snap for snap in snaps if not mode or job_types.get(snap.job_id, "other") == mode]
    snapshot = max(candidates, key=lambda snap: stats.anchor_coverage(points, snap.anchors), default=None) if candidates else None
    hidden: list[dict] = []
    total = len(points)
    if snapshot is not None and snapshot.anchors:
        points, hidden = stats.place_clicks(points, snapshot.anchors, [snapshot.viewport_w, snapshot.viewport_h])
    else:
        points = [{**p, "placed": "screen"} for p in points]
    for p in points:
        for key in ("rx", "ry", "study_id"):
            p.pop(key, None)
    if layout:
        layout = {**layout, "occurred_at": _iso(layout["occurred_at"])}
    # Who clicked, most clicks first -- the heatmap's legend and colour key.
    clicks_by_user = Counter(p["user_id"] for p in points)
    users = [
        {"user_id": user_id, "username": names.get(user_id, {}).get("username", user_id), "clicks": n}
        for user_id, n in sorted(clicks_by_user.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    return {
        "route": route,
        "days": days,
        "points": points,
        "users": users,
        "modes": {m: modes.get(m, 0) for m in ("annotation", "review", "other")},
        "layout": layout,
        "snapshot": {**snapshots.meta(snapshot), "mode": job_types.get(snapshot.job_id, "other")} if snapshot else None,
        # clicks on elements this picture doesn't have (a pane switched off...)
        "hidden": hidden,
        "placement": {"total": total, "exact": sum(1 for p in points if p["placed"] == "exact"), "similar": sum(1 for p in points if p["placed"] == "similar"), "screen": sum(1 for p in points if p["placed"] == "screen"), "hidden": sum(h["clicks"] for h in hidden)},
    }
