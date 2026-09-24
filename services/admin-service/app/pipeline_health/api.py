"""HTTP API for pipeline health: cycle time, currently-open bottlenecks,
per-assignee load, and the per-person learning curve. Admin-only, same
guard as app/api/audit.py and app/usage/api.py.

Builds "legs" (see stats.py's own docstring) from three sources that
already exist -- CaseStageEvent (when a case entered a card's queue),
Annotation (every version, not just the latest -- status.py's
_latest_annotation_per_case only keeps the newest per case, which loses
exactly the history this needs), AnnotationReview (decisions) -- joined
through Case -> ImagingStudy -> Series/Instance the same way
status.py's _latest_annotation_per_case does, since an Annotation's
target is a series/instance, not a case."""
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import (
    Annotation,
    AnnotationReview,
    AnnotationStatus,
    Case,
    CaseStageEvent,
    ImagingStudy,
    Instance,
    Series,
    UsageEvent,
    WorkflowCard,
    WorkflowCardType,
)
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.api.workflow.status import _effective_status
from app.keycloak_admin import list_realm_users

from . import stats

router = APIRouter(prefix="/admin/pipeline-health", tags=["admin:pipeline-health"])

# A review decision mutates the SAME Annotation row's status in place
# (SUBMITTED -> APPROVED/REJECTED, see annotation-service's
# review_annotation) rather than creating a new row -- its created_at
# still marks the real submission moment even after that mutation, but
# a bare `status == SUBMITTED` check would stop finding it the instant
# it's decided. Same set status.py's _ANNOTATED_STATUSES uses for "this
# row was, at some point, actually submitted".
_EVER_SUBMITTED = (AnnotationStatus.SUBMITTED, AnnotationStatus.APPROVED, AnnotationStatus.REJECTED)


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


def _ms(delta: timedelta) -> int:
    return int(delta.total_seconds() * 1000)


def _usernames() -> dict[str, dict]:
    try:
        return {u["id"]: {"username": u.get("username") or u["id"], "email": u.get("email")} for u in list_realm_users()}
    except Exception:  # noqa: BLE001 -- names are a nicety, the figures are the point
        return {}


def load_legs(db: Session, card_id: str | None = None, study_id: uuid.UUID | None = None) -> list[dict]:
    """Public entry to the legs (see _load_legs) -- also what the
    per-study analytics page builds on."""
    return _load_legs(db, card_id, study_id)


def _load_legs(db: Session, card_id: str | None, study_id: uuid.UUID | None = None) -> list[dict]:
    """One entry per (card, case) with a recorded queue-start. See
    module docstring and stats.py for what a "leg" means; the Review
    branch below re-anchors on the actual SUBMITTED Annotation's own
    created_at rather than the CaseStageEvent, which is only ever
    approximate for Review (stamped by the ripple that runs right after
    submission, not the submission itself)."""
    card_query = db.query(WorkflowCard).filter(WorkflowCard.type.in_([WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW]))
    if study_id is not None:
        card_query = card_query.filter(WorkflowCard.study_id == study_id)
    if card_id:
        try:
            card_query = card_query.filter(WorkflowCard.id == uuid.UUID(card_id))
        except ValueError:
            raise HTTPException(status_code=422, detail="card_id must be a UUID") from None
    cards = {c.id: c for c in card_query.all()}
    if not cards:
        return []

    events = db.query(CaseStageEvent).filter(CaseStageEvent.card_id.in_(cards.keys())).all()
    if not events:
        return []

    case_ids = {str(e.case_id) for e in events}
    cases = {str(c.id): c for c in db.query(Case).filter(Case.id.in_(case_ids)).all()}

    series_rows = (
        db.query(ImagingStudy.case_id, Series.id).join(Series, Series.imaging_study_id == ImagingStudy.id).filter(ImagingStudy.case_id.in_(case_ids)).all()
    )
    instance_rows = (
        db.query(ImagingStudy.case_id, Instance.id)
        .join(Series, Series.imaging_study_id == ImagingStudy.id)
        .join(Instance, Instance.series_id == Series.id)
        .filter(ImagingStudy.case_id.in_(case_ids))
        .all()
    )
    case_by_series = {str(sid): str(cid) for cid, sid in series_rows}
    case_by_instance = {str(iid): str(cid) for cid, iid in instance_rows}

    annotations: list = []
    if case_by_series or case_by_instance:
        annotations = (
            db.query(
                Annotation.id, Annotation.target_type, Annotation.target_id, Annotation.status, Annotation.created_at,
                Annotation.annotator_id, Annotation.review_of_id,
            )
            .filter(
                or_(
                    and_(Annotation.target_type == "series", Annotation.target_id.in_(case_by_series.keys())),
                    and_(Annotation.target_type == "instance", Annotation.target_id.in_(case_by_instance.keys())),
                )
            )
            .order_by(Annotation.created_at)
            .all()
        )

    annotations_by_case: dict[str, list] = defaultdict(list)
    for annotation_id, target_type, target_id, status, created_at, annotator_id, review_of_id in annotations:
        cid = case_by_series.get(str(target_id)) if target_type == "series" else case_by_instance.get(str(target_id))
        if cid:
            # a reviewer's in-progress draft is still handed-in work (see workflow/status.py)
            annotations_by_case[cid].append((annotation_id, _effective_status(status, review_of_id), created_at, annotator_id))

    annotation_ids = [row[0] for rows in annotations_by_case.values() for row in rows]
    reviews_by_annotation: dict = defaultdict(list)
    if annotation_ids:
        for annotation_id, created_at, reviewer_id in (
            db.query(AnnotationReview.annotation_id, AnnotationReview.created_at, AnnotationReview.reviewer_id)
            .filter(AnnotationReview.annotation_id.in_(annotation_ids))
            .order_by(AnnotationReview.created_at)
            .all()
        ):
            reviews_by_annotation[annotation_id].append((created_at, reviewer_id))

    # When someone first opened the case in the viewer for this job. The
    # viewer stamps job_id/case_id on its page_view (usage tracking);
    # opening the case is the real start of work -- a first Annotation
    # row often only appears at "Mark as annotated" itself, which would
    # count the whole drawing time as waiting and the work as zero.
    opens: dict[tuple[str, str], list[datetime]] = defaultdict(list)
    for occurred_at, detail in (
        db.query(UsageEvent.occurred_at, UsageEvent.detail)
        .filter(
            UsageEvent.app == "viewer",
            UsageEvent.event_type == "page_view",
            UsageEvent.detail["job_id"].astext.in_([str(cid) for cid in cards]),
        )
        .order_by(UsageEvent.occurred_at)
        .all()
    ):
        if detail and detail.get("case_id"):
            opens[(str(detail["job_id"]), str(detail["case_id"]))].append(occurred_at)

    def first_open(card_key: str, case_key: str, after_at: datetime) -> datetime | None:
        return next((t for t in opens.get((card_key, case_key), []) if t >= after_at), None)

    def earliest(*values: datetime | None) -> datetime | None:
        present = [v for v in values if v is not None]
        return min(present) if present else None

    legs = []
    for event in events:
        card = cards.get(event.card_id)
        if card is None:
            continue
        case_id = str(event.case_id)
        case = cases.get(case_id)
        rows = annotations_by_case.get(case_id, [])  # already ordered by created_at

        if card.type == WorkflowCardType.ANNOTATION:
            queue_start = event.occurred_at
            after = [r for r in rows if r[2] >= queue_start]
            submitted = next((r for r in after if r[1] in _EVER_SUBMITTED), None)
            terminal_at, actor_id = (submitted[2], submitted[3]) if submitted else (None, None)
            first_touch = earliest(after[0][2] if after else None, first_open(str(card.id), case_id, queue_start))
            # Review outcome of what this leg produced: how many
            # submissions were sent back before one was approved.
            submissions = [r for r in after if r[1] in _EVER_SUBMITTED]
            first_decision = reviews_by_annotation.get(submissions[0][0], []) if submissions else []
            quality = {
                "decided_at": first_decision[0][0] if first_decision else None,
                "first_pass": submissions[0][1] == AnnotationStatus.APPROVED if first_decision else None,
                "rejections": sum(1 for r in submissions if r[1] == AnnotationStatus.REJECTED),
                "approved": any(r[1] == AnnotationStatus.APPROVED for r in submissions),
            }
        else:  # REVIEW
            submitted = next((r for r in rows if r[1] in _EVER_SUBMITTED), None)
            if submitted is None:
                continue  # entered the review queue, but the submission that put it there isn't visible (shouldn't happen)
            queue_start = submitted[2]
            after = [r for r in rows if r[2] > queue_start]
            decisions = reviews_by_annotation.get(submitted[0], [])
            terminal_at, actor_id = decisions[0] if decisions else (None, None)
            first_touch = earliest(after[0][2] if after else None, first_open(str(card.id), case_id, queue_start))
            quality = None

        if first_touch is not None and terminal_at is not None and first_touch > terminal_at:
            first_touch = terminal_at  # opened again only after finishing; the work began no later than the finish
        legs.append(
            {
                "quality": quality,
                "card_id": str(card.id),
                "card_title": card.title,
                "card_type": card.type.value,
                "case_id": case_id,
                "case_title": case.title if case else None,
                "assignee_id": (card.config or {}).get("assigned_user_id"),
                "queue_start": queue_start,
                "first_touch": first_touch,
                "terminal_at": terminal_at,
                "actor_id": actor_id,
                "queue_ms": _ms(first_touch - queue_start) if first_touch else None,
                # A first touch that *is* the finish (no earlier draft, no
                # viewer open on record -- e.g. submitted through the API)
                # says nothing about how long the work took: unknown, not 0.
                "work_ms": _ms(terminal_at - first_touch) if (first_touch and terminal_at and first_touch < terminal_at) else None,
            }
        )
    return legs


def _tenure_start(db: Session) -> dict[tuple[str, str], datetime]:
    """Each person's own first tracked action, per role -- real history
    from day one (unlike Usage-event tenure, which only starts the day
    that tracking shipped). What the learning curve buckets against."""
    tenure: dict[tuple[str, str], datetime] = {}
    for user_id, start in db.query(Annotation.annotator_id, func.min(Annotation.created_at)).group_by(Annotation.annotator_id).all():
        tenure[(user_id, "annotation")] = start
    for user_id, start in db.query(AnnotationReview.reviewer_id, func.min(AnnotationReview.created_at)).group_by(AnnotationReview.reviewer_id).all():
        tenure[(user_id, "review")] = start
    return tenure


def _window(days: int, since: datetime | None, until: datetime | None) -> tuple[datetime, datetime]:
    """Same rule as usage/api.py's own _window: an explicit since/until
    (the Usage page's "vs last period" delta, comparing against the
    exact preceding window) always wins over `days`; `until` defaults
    to now. Naive datetimes (a plain datetime-local value with no
    offset) are treated as UTC."""
    if since is None and until is None:
        now = datetime.now(timezone.utc)
        return now - timedelta(days=days), now
    if since is not None and since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    if until is not None and until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    since, until = since or datetime.now(timezone.utc) - timedelta(days=days), until or datetime.now(timezone.utc)
    if since >= until:
        raise HTTPException(status_code=422, detail="'from' must be before 'to'")
    return since, until


def build_summary(db: Session, window_since: datetime, window_until: datetime, card_id: str | None = None, person_id: str | None = None, study_id: str | None = None) -> dict:
    """The /summary payload for an explicit window -- also what the
    Usage page's overview/findings/report endpoints (app/usage) call, so
    the pipeline half of a finding is the same number the page shows.
    With `person_id`, only the cases that person was assigned or did;
    the "usual wait" a bottleneck is judged against stays every case's,
    so one person's cases aren't flagged by a yardstick of their own."""
    try:
        study_uuid = uuid.UUID(study_id) if study_id else None
    except ValueError:
        raise HTTPException(status_code=422, detail="study_id must be a UUID") from None
    all_legs = _load_legs(db, card_id, study_uuid)
    legs = [leg for leg in all_legs if person_id in (leg["assignee_id"], leg["actor_id"])] if person_id else all_legs
    windowed = [leg for leg in legs if leg["terminal_at"] is not None and window_since <= leg["terminal_at"] <= window_until]
    names = _usernames()

    # Bottlenecks/load are always "right now", unbounded by the window --
    # an old stuck case is exactly what should surface, not get filtered
    # out for predating the selected range.
    now = datetime.now(timezone.utc)
    bottleneck_rows = stats.bottlenecks(all_legs, now)
    if person_id:
        bottleneck_rows = [row for row in bottleneck_rows if row["assignee_id"] == person_id]
    bottleneck_rows = bottleneck_rows[:50]
    for row in bottleneck_rows:
        row["assignee"] = names.get(row["assignee_id"], {}).get("username", row["assignee_id"])

    load_rows = [row for row in stats.assignee_load(all_legs) if not person_id or row["assignee_id"] == person_id]
    for row in load_rows:
        row["assignee"] = names.get(row["assignee_id"], {}).get("username", row["assignee_id"])
        row["oldest_since"] = row["oldest_since"].isoformat()

    return {
        "since": window_since.isoformat(),
        "until": window_until.isoformat(),
        "legs": stats.leg_summary(windowed),
        "quality": stats.review_quality(legs, window_since, window_until),
        "bottlenecks": bottleneck_rows,
        "assignee_load": load_rows,
    }


@router.get("/summary")
def read_summary(
    days: int = Query(30, ge=1, le=365),
    since: datetime | None = Query(None, alias="from"),
    until: datetime | None = Query(None, alias="to"),
    card_id: str | None = None,
    user_id: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)
    window_since, window_until = _window(days, since, until)
    return {"days": days, **build_summary(db, window_since, window_until, card_id, user_id)}


def build_learning_curve(db: Session) -> list[dict]:
    """Every person's week-of-tenure medians, usernames resolved -- the
    /learning-curve payload, also consumed by app/usage's findings and
    report so the two never disagree."""
    rows = stats.learning_curve(_load_legs(db, None), _tenure_start(db))
    names = _usernames()
    for row in rows:
        row["username"] = names.get(row["actor_id"], {}).get("username", row["actor_id"])
    return rows


@router.get("/learning-curve")
def read_learning_curve(db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    _require_global_admin(user)
    return build_learning_curve(db)
