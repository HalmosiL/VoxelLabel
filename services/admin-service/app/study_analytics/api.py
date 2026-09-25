"""GET /admin/studies/{study_id}/analytics -- everything the study's
Analytics page shows, in one call: headline figures, per-card metrics
for the workflow graph, the case table, what was drawn per label, what
each person did, and weekly throughput.

Readable by the study's admins and data managers (and platform admins):
it names people and their output, which is management information, not
something every annotator on the study needs.

Hands-on time comes from usage tracking (the viewer's page views carry
job_id/case_id); everyone's work counts here -- unlike the Usage page,
this is about the study's work, not about how the UI is used."""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import (
    Annotation,
    AnnotationReview,
    Case,
    CaseStageEvent,
    ImagingStudy,
    Instance,
    Series,
    Study,
    UsageEvent,
    WorkflowCard,
    WorkflowEdge,
)
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.keycloak_admin import list_realm_users
from app.pipeline_health.api import load_legs
from app.usage import stats as usage_stats

from . import stats

router = APIRouter(prefix="/admin", tags=["admin:study-analytics"])

_READ_ROLES = ["admin", "data_manager"]
# The events hands-on time is computed from; everything else in a
# session (mouse traces, scrolls) is irrelevant here and bulky.
_EFFORT_EVENTS = ("page_view", "page_leave", "idle", "click", "key", "action")


def _names() -> dict[str, str]:
    try:
        return {u["id"]: u.get("username") or u["id"] for u in list_realm_users()}
    except Exception:  # noqa: BLE001 -- names are a nicety, the figures are the point
        return {}


def _iso(value):
    return value.isoformat() if isinstance(value, datetime) else value


def _load_annotations(db: Session, study_id: uuid.UUID) -> tuple[list[dict], list[dict], dict[str, str]]:
    """Every annotation version of the study with the case it belongs to
    (through its series/instance target), every review decision on them,
    and case titles."""
    cases = {str(c.id): c.title for c in db.query(Case.id, Case.title).filter(Case.study_id == study_id).all()}
    if not cases:
        return [], [], {}
    case_uuids = [uuid.UUID(c) for c in cases]
    series_case = {
        sid: str(cid)
        for cid, sid in db.query(ImagingStudy.case_id, Series.id).join(Series, Series.imaging_study_id == ImagingStudy.id).filter(ImagingStudy.case_id.in_(case_uuids)).all()
    }
    instance_case = {
        iid: str(cid)
        for cid, iid in db.query(ImagingStudy.case_id, Instance.id)
        .join(Series, Series.imaging_study_id == ImagingStudy.id)
        .join(Instance, Instance.series_id == Series.id)
        .filter(ImagingStudy.case_id.in_(case_uuids))
        .all()
    }
    rows = []
    if series_case or instance_case:
        for a in (
            db.query(Annotation)
            .filter(
                or_(
                    and_(Annotation.target_type == "series", Annotation.target_id.in_(series_case.keys())),
                    and_(Annotation.target_type == "instance", Annotation.target_id.in_(instance_case.keys())),
                )
            )
            .all()
        ):
            case_id = series_case.get(a.target_id) if a.target_type == "series" else instance_case.get(a.target_id)
            if case_id:
                rows.append({"id": a.id, "case_id": case_id, "annotator_id": a.annotator_id, "status": a.status.value, "created_at": a.created_at, "payload": a.payload})
    reviews = []
    if rows:
        reviews = [
            {"annotation_id": r.annotation_id, "reviewer_id": r.reviewer_id, "decision": r.decision, "comment": r.comment, "created_at": r.created_at}
            for r in db.query(AnnotationReview).filter(AnnotationReview.annotation_id.in_([a["id"] for a in rows])).all()
        ]
    return rows, reviews, cases


def _load_effort(db: Session, job_ids: list[str]) -> list[dict]:
    """usage.stats.case_effort over every viewer session that opened a
    case from one of these jobs."""
    if not job_ids:
        return []
    sessions = [
        s
        for (s,) in db.query(UsageEvent.session_id)
        .filter(UsageEvent.app == "viewer", UsageEvent.event_type == "page_view", UsageEvent.detail["job_id"].astext.in_(job_ids))
        .distinct()
        .all()
    ]
    if not sessions:
        return []
    events = [
        {"user_id": e.user_id, "session_id": e.session_id, "app": e.app, "event_type": e.event_type, "route": e.route, "name": e.name, "detail": e.detail, "duration_ms": e.duration_ms, "occurred_at": e.occurred_at}
        for e in db.query(UsageEvent).filter(UsageEvent.session_id.in_(sessions), UsageEvent.event_type.in_(_EFFORT_EVENTS)).order_by(UsageEvent.occurred_at).all()
    ]
    wanted = set(job_ids)
    return [e for e in usage_stats.case_effort(usage_stats.prepare(events)) if e["job_id"] in wanted]


def _slices(db: Session, study_id: uuid.UUID) -> dict[str, int]:
    """Images (DICOM instances) in each case's largest series."""
    out: dict[str, int] = {}
    for case_id, _series, n in (
        db.query(ImagingStudy.case_id, Series.id, func.count(Instance.id))
        .join(Series, Series.imaging_study_id == ImagingStudy.id)
        .outerjoin(Instance, Instance.series_id == Series.id)
        .join(Case, Case.id == ImagingStudy.case_id)
        .filter(Case.study_id == study_id)
        .group_by(ImagingStudy.case_id, Series.id)
        .all()
    ):
        out[str(case_id)] = max(out.get(str(case_id), 0), int(n))
    return out


def build(db: Session, study_id: uuid.UUID) -> dict:
    card_rows = db.query(WorkflowCard).filter(WorkflowCard.study_id == study_id).all()
    cards = [
        {
            "id": str(c.id),
            "type": c.type.value,
            "title": c.title,
            "assignee_id": (c.config or {}).get("assigned_user_id"),
            "materialized_source_card_id": str(c.materialized_source_card_id) if c.materialized_source_card_id else None,
            "materialized_source_handle": c.materialized_source_handle,
        }
        for c in card_rows
    ]
    edges = [
        {"source_card_id": str(e.source_card_id), "source_handle": e.source_handle, "target_card_id": str(e.target_card_id)}
        for e in db.query(WorkflowEdge).filter(WorkflowEdge.study_id == study_id).all()
    ]
    board = stats.Board(cards, edges)
    job_ids = [c["id"] for c in cards if c["type"] in stats.JOB_TYPES]
    annotations, reviews, titles = _load_annotations(db, study_id)
    stage = (
        [
            {"card_id": str(s.card_id), "case_id": str(s.case_id), "occurred_at": s.occurred_at}
            for s in db.query(CaseStageEvent).filter(CaseStageEvent.card_id.in_([uuid.UUID(j) for j in job_ids]), CaseStageEvent.study_id == uuid.UUID(str(study_id))).all()
        ]
        if job_ids
        else []
    )
    legs = load_legs(db, None, study_id)
    effort = _load_effort(db, job_ids)
    names = _names()

    histories = stats.case_histories(annotations, reviews, stage, board)
    cases = stats.cases_table(histories, stage, board, effort, titles, _slices(db, study_id), names)
    cards_out = stats.card_metrics(board, stage, legs, effort, histories, cases)
    for card in cards:
        if card["id"] in cards_out:
            assignee = card["assignee_id"]
            cards_out[card["id"]]["assignee"] = names.get(assignee, assignee) if assignee else None
    for row in cases:
        row["entered_at"], row["done_at"] = _iso(row["entered_at"]), _iso(row["done_at"])
        for step in row["path"]:
            step["at"] = _iso(step["at"])
        for comment in row["review_comments"]:
            comment["at"] = _iso(comment["at"])
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "headline": stats.headline(cases, effort, board),
        "cards": cards_out,
        "cases": cases,
        "labels": stats.label_table(histories),
        "people": stats.people_table(histories, legs, effort, board, names),
        "weekly": stats.weekly_throughput(histories),
    }


@router.get("/studies/{study_id}/analytics")
def read_study_analytics(study_id: uuid.UUID, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    require_study_role(db, str(study_id), user, allowed_roles=_READ_ROLES)
    if db.get(Study, study_id) is None:
        raise HTTPException(status_code=404, detail="Study not found")
    return build(db, study_id)
