"""HTTP API for a Study's workflow board -- a freeform, drag/connect canvas
of cards (Dataset/Split/Filter/Annotation/Review/Union/Note/Milestone) that
a user builds manually to organize project work. There is exactly one
board per Study; `WorkflowCard`/`WorkflowEdge` reference `study_id`
directly rather than through a separate "board" entity.

Unlike the rest of this service's write endpoints (flat scalar query
params), the endpoints here take structured JSON bodies via Pydantic
models -- a deliberate, justified deviation given how structured a card's
settings/connection actually are (the only other precedent for a
non-scalar body in this service is `annotation_types.create_annotation_type`'s
bare `json_schema: dict`).

Every card interaction (move, connect, delete) is its own granular
request the moment it happens on the board -- there is no "save the whole
board" endpoint. This is deliberate: a debounced whole-board replace would
race against `run_workflow_card` (a Run landing between an autosave's
snapshot-read and its delayed write would silently clobber the just-
computed output), so each mutation only ever touches its own row.
"""
import hashlib
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import (
    Annotation,
    AnnotationStatus,
    Case,
    ImagingStudy,
    Instance,
    Series,
    Study,
    WorkflowCard,
    WorkflowCardType,
    WorkflowEdge,
    case_tags,
)

router = APIRouter(prefix="/admin", tags=["admin:workflow"])

_READ_ROLES = ["viewer", "annotator", "reviewer", "data_manager", "admin"]
_WRITE_ROLES = ["data_manager", "admin"]
# Split has no output handle of its own: its result is expressed entirely
# as materialized Dataset cards (see run_workflow_card), not a graph edge.
# The two Surface types (Annotation/Review) are pure configuration --
# they never sit in the case-flow graph, so for the ordinary
# "input"/"output" data-flow handles they behave like Note/Milestone (no
# data output, no data input, never Run). Each still connects to its own
# matching job-card type, but only via the separate "surface_config"
# handle pair, validated on its own in create_workflow_edge below -- that
# check runs before these sets are ever consulted for a surface_config
# edge. SURFACE (the old, single generic type both were split from) is
# included too, purely so a stray pre-existing row of that type can't
# accidentally become a data-flow node -- no new card is ever created
# with it.
_SURFACE_TYPES = {WorkflowCardType.SURFACE, WorkflowCardType.ANNOTATION_SURFACE, WorkflowCardType.REVIEW_SURFACE}
_NO_OUTPUT_TYPES = {WorkflowCardType.SPLIT, WorkflowCardType.NOTE, WorkflowCardType.MILESTONE, *_SURFACE_TYPES}
# Dataset CAN take an incoming edge -- connecting something into it and
# running it snapshots that upstream result as this Dataset's manual case
# list (a user-placed, general version of Split/Annotation/Review's
# automatic "materialize" -- see the DATASET branch in run_workflow_card).
_NO_INPUT_TYPES = {WorkflowCardType.NOTE, WorkflowCardType.MILESTONE, *_SURFACE_TYPES}
_NO_RUN_TYPES = {WorkflowCardType.NOTE, WorkflowCardType.MILESTONE, *_SURFACE_TYPES}
_MATERIALIZED_DEFAULT_WIDTH = 200.0
_MATERIALIZED_DEFAULT_HEIGHT = 90.0

# The permissive default returned by get_surface_config when an
# Annotation/Review card has no Surface card connected -- keeps
# unrestricted jobs (the common case today) behaving exactly as before
# this feature existed. A Review job's *effective* config always forces
# tools=[] and show_3d=False regardless of this default or of an
# ANNOTATION_SURFACE's own fields (see get_surface_config) -- the review
# surface has no tools or 3D at all, unconditionally.
_UNRESTRICTED_SURFACE_CONFIG = {
    "tools": ["paint", "erase", "fill", "polygon", "auto", "histogram"],
    "panes": ["sagittal", "coronal", "axial"],
    "show_3d": True,
}


class WorkflowCardIn(BaseModel):
    # Normally left unset (the DB assigns a fresh id) -- accepted so the
    # admin-ui's client-side undo/redo can recreate a deleted card with
    # its original id, keeping any edges that reference it valid without
    # a full board resync.
    id: uuid.UUID | None = None
    type: WorkflowCardType
    title: str
    position_x: float
    position_y: float
    width: float | None = None
    height: float | None = None
    config: dict = Field(default_factory=dict)


class WorkflowCardPatch(BaseModel):
    title: str | None = None
    position_x: float | None = None
    position_y: float | None = None
    width: float | None = None
    height: float | None = None
    config: dict | None = None  # replaces the whole config blob when provided


class WorkflowEdgeIn(BaseModel):
    id: uuid.UUID | None = None  # same reasoning as WorkflowCardIn.id
    source_card_id: uuid.UUID
    source_handle: str = "output"
    target_card_id: uuid.UUID
    target_handle: str = "input"


def _card_or_404(db: Session, card_id: uuid.UUID) -> WorkflowCard:
    card = db.get(WorkflowCard, card_id)
    if card is None:
        raise HTTPException(status_code=404, detail="Workflow card not found")
    return card


def _has_study_role(db: Session, study_id: str, user: CurrentUser, allowed_roles: list[str]) -> bool:
    try:
        require_study_role(db, study_id, user, allowed_roles)
        return True
    except HTTPException:
        return False


def _dataset_output_ids(db: Session, card: WorkflowCard) -> list[str]:
    if card.config.get("mode") == "manual":
        return list(card.config.get("case_ids", []))
    return [str(c.id) for c in db.query(Case).filter_by(study_id=card.study_id).all()]


def _is_stale(card_last_run_at, source_last_run_at) -> bool:
    """True if `source_last_run_at` is newer than `card_last_run_at` --
    i.e. the upstream card has (re-)run more recently than this one, so
    this card's own output_case_ids may no longer reflect its input.
    A source that has never run (None) can never make a card stale."""
    if source_last_run_at is None:
        return False
    return card_last_run_at is None or source_last_run_at > card_last_run_at


def _output_count(card: WorkflowCard, output_case_ids):
    if output_case_ids is None:
        return None
    if card.type == WorkflowCardType.SPLIT:
        return {handle: len(ids) for handle, ids in output_case_ids.items()}
    return len(output_case_ids)


def _materialized_children(db: Session, card_id: uuid.UUID) -> list[WorkflowCard]:
    """Dataset cards a Split/Annotation/Review card has auto-created (or is
    keeping in sync) via `materialized_source_card_id`."""
    return db.query(WorkflowCard).filter_by(materialized_source_card_id=card_id).all()


_SUBMITTED_OR_LATER = [AnnotationStatus.SUBMITTED, AnnotationStatus.APPROVED, AnnotationStatus.REJECTED]


def _annotated_case_ids(db: Session, case_ids: list[str], review: bool) -> list[str]:
    """The subset of `case_ids` that actually have a real, *deliberately
    submitted* Annotation record (or, for Review, one already
    approved/rejected) -- a bare draft (created on every ct-annotator
    Save, as an in-progress version) doesn't count on its own; the
    annotator explicitly marking a case done (ct-annotator's "Mark as
    annotated", which saves with status=submitted) is what flips this,
    matching what a Reviewer would actually want to see queued.

    No Annotation is ever created with `target_type == "study"` anywhere
    in this codebase -- ct-annotator's real save path (the segmentation
    volume workflow every other part of this session is built around)
    posts with `target_type == "series"`, and its older bbox/freehand
    path posts with `target_type == "instance"`; a `"study"`-only check
    here could never match either. Checks both real paths via their own
    join chain up to Case, and unions the results."""
    if not case_ids:
        return []

    series_query = (
        db.query(func.distinct(ImagingStudy.case_id))
        .join(Series, Series.imaging_study_id == ImagingStudy.id)
        .join(Annotation, Annotation.target_id == Series.id)
        .filter(Annotation.target_type == "series", ImagingStudy.case_id.in_(case_ids))
    )
    instance_query = (
        db.query(func.distinct(ImagingStudy.case_id))
        .join(Series, Series.imaging_study_id == ImagingStudy.id)
        .join(Instance, Instance.series_id == Series.id)
        .join(Annotation, Annotation.target_id == Instance.id)
        .filter(Annotation.target_type == "instance", ImagingStudy.case_id.in_(case_ids))
    )
    status_filter = (
        [AnnotationStatus.APPROVED, AnnotationStatus.REJECTED] if review else _SUBMITTED_OR_LATER
    )
    series_query = series_query.filter(Annotation.status.in_(status_filter))
    instance_query = instance_query.filter(Annotation.status.in_(status_filter))

    case_ids_found = {row[0] for row in series_query.all()} | {row[0] for row in instance_query.all()}
    return sorted(str(cid) for cid in case_ids_found)


def _annotation_progress(db: Session, case_ids: list[str], review: bool) -> dict:
    if not case_ids:
        return {"annotated": 0, "total": 0}
    return {"annotated": len(_annotated_case_ids(db, case_ids, review)), "total": len(case_ids)}


def _serialize_card(db: Session, card: WorkflowCard, cards_by_id: dict, edges_by_target: dict) -> dict:
    output_case_ids = card.output_case_ids
    if card.type == WorkflowCardType.DATASET:
        output_case_ids = _dataset_output_ids(db, card)

    stale = any(
        _is_stale(card.last_run_at, cards_by_id[edge.source_card_id].last_run_at)
        for edge in edges_by_target.get(card.id, [])
        if edge.source_card_id in cards_by_id
    )

    result = {
        "id": str(card.id),
        "type": card.type.value,
        "title": card.title,
        "position_x": card.position_x,
        "position_y": card.position_y,
        "width": card.width,
        "height": card.height,
        "config": card.config,
        "output_case_ids": output_case_ids,
        "output_count": _output_count(card, output_case_ids),
        "last_run_at": card.last_run_at.isoformat() if card.last_run_at else None,
        "stale": stale,
    }
    if card.type in (WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW) and output_case_ids:
        result["annotation_progress"] = _annotation_progress(
            db, output_case_ids, review=card.type == WorkflowCardType.REVIEW
        )

    if card.type == WorkflowCardType.SPLIT:
        result["materialized_card_ids"] = {
            c.materialized_source_handle: str(c.id) for c in _materialized_children(db, card.id)
        }
    elif card.type in (WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW):
        children = _materialized_children(db, card.id)
        result["materialized_card_id"] = str(children[0].id) if children else None

    if card.type == WorkflowCardType.DATASET and card.materialized_source_card_id:
        source = cards_by_id.get(card.materialized_source_card_id) or db.get(
            WorkflowCard, card.materialized_source_card_id
        )
        result["materialized_from"] = {"card_id": str(source.id), "title": source.title} if source else None

    return result


@router.get("/studies/{study_id}/workflow")
def get_workflow_board(
    study_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    require_study_role(db, str(study_id), user, allowed_roles=_READ_ROLES)

    cards = db.query(WorkflowCard).filter_by(study_id=study_id).all()
    edges = db.query(WorkflowEdge).filter_by(study_id=study_id).all()

    cards_by_id = {c.id: c for c in cards}
    edges_by_target: dict[uuid.UUID, list[WorkflowEdge]] = {}
    for edge in edges:
        edges_by_target.setdefault(edge.target_card_id, []).append(edge)

    return {
        "cards": [_serialize_card(db, c, cards_by_id, edges_by_target) for c in cards],
        "edges": [
            {
                "id": str(e.id),
                "source_card_id": str(e.source_card_id),
                "source_handle": e.source_handle,
                "target_card_id": str(e.target_card_id),
                "target_handle": e.target_handle,
            }
            for e in edges
        ],
    }


@router.post("/studies/{study_id}/workflow/cards", status_code=201)
def create_workflow_card(
    study_id: uuid.UUID,
    body: WorkflowCardIn,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    require_study_role(db, str(study_id), user, allowed_roles=_WRITE_ROLES)

    card = WorkflowCard(
        id=body.id or uuid.uuid4(),
        study_id=study_id,
        type=body.type,
        title=body.title,
        position_x=body.position_x,
        position_y=body.position_y,
        width=body.width,
        height=body.height,
        config=body.config,
    )
    db.add(card)
    db.commit()
    db.refresh(card)
    return _serialize_card(db, card, {card.id: card}, {})


@router.patch("/workflow-cards/{card_id}")
def update_workflow_card(
    card_id: uuid.UUID,
    body: WorkflowCardPatch,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    card = _card_or_404(db, card_id)
    require_study_role(db, str(card.study_id), user, allowed_roles=["data_manager", "admin", "annotator", "reviewer"])

    if not _has_study_role(db, str(card.study_id), user, _WRITE_ROLES):
        # Narrowed permission: someone with only an annotator/reviewer role
        # may flip the status of their own assigned annotation/review
        # card, and nothing else -- lets Levente mark his own card "done"
        # without granting general board-editing rights.
        only_status_change = (
            body.title is None
            and body.position_x is None
            and body.position_y is None
            and body.width is None
            and body.height is None
            and body.config is not None
            and set(body.config.keys()) <= {"status"}
        )
        if (
            card.type not in (WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW)
            or not only_status_change
            or card.config.get("assigned_user_id") != user.subject
        ):
            raise HTTPException(status_code=403, detail="Insufficient study role")
        card.config = {**card.config, "status": body.config["status"]}
        db.commit()
        db.refresh(card)
        return _serialize_card(db, card, {card.id: card}, {})

    if body.title is not None:
        card.title = body.title
    if body.position_x is not None:
        card.position_x = body.position_x
    if body.position_y is not None:
        card.position_y = body.position_y
    if body.width is not None:
        card.width = body.width
    if body.height is not None:
        card.height = body.height
    if body.config is not None:
        card.config = body.config

    db.commit()
    db.refresh(card)
    return _serialize_card(db, card, {card.id: card}, {})


@router.delete("/workflow-cards/{card_id}", status_code=204)
def delete_workflow_card(
    card_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Cascades to any edge touching this card at the DB level -- no
    manual cleanup needed. No "still has real data" guard (unlike Study
    delete): this is board scratch space, not clinical data."""
    card = _card_or_404(db, card_id)
    require_study_role(db, str(card.study_id), user, allowed_roles=_WRITE_ROLES)
    db.delete(card)
    db.commit()


@router.get("/workflow-cards/{card_id}/surface-config")
def get_surface_config(
    card_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """What ct-annotator should show while working this Annotation/Review
    card's job: the config of the Surface card connected to it via a
    "surface_config" edge, or the permissive default (everything
    enabled) if none is connected -- an unrestricted job behaves exactly
    like the viewer did before this feature existed.

    A Review job's *effective* tools/show_3d are always forced off here,
    regardless of what's configured -- the review surface never has
    tools or 3D, unconditionally (see ct-annotator's ViewerPage
    reviewMode), so a REVIEW_SURFACE card only ever configures `panes`.
    This keeps the response shape identical for both job types, so
    ct-annotator's own SurfaceConfig handling doesn't need to know which
    kind of Surface card produced it.

    `card_type` (the underlying job's own type, "annotation" or
    "review") rides along in every response so ct-annotator can tell a
    Review job apart from an Annotation one and switch to its
    simplified, view-and-decide-only surface -- there's no other cheap
    way for it to learn this without a second round trip."""
    card = _card_or_404(db, card_id)
    require_study_role(db, str(card.study_id), user, allowed_roles=_READ_ROLES)
    is_review = card.type == WorkflowCardType.REVIEW

    edge = db.query(WorkflowEdge).filter_by(target_card_id=card.id, target_handle="surface_config").first()
    surface = db.get(WorkflowCard, edge.source_card_id) if edge else None
    if surface is None:
        config = dict(_UNRESTRICTED_SURFACE_CONFIG)
    else:
        config = {
            "tools": surface.config.get("tools", _UNRESTRICTED_SURFACE_CONFIG["tools"]),
            "panes": surface.config.get("panes", _UNRESTRICTED_SURFACE_CONFIG["panes"]),
            "show_3d": surface.config.get("show_3d", True),
        }

    if is_review:
        config = {**config, "tools": [], "show_3d": False}

    return {**config, "card_type": card.type.value}


@router.get("/my-jobs")
def list_my_jobs(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """Every Annotation/Review card assigned to the calling user, across
    every Study -- being the assignee is itself the access grant here,
    the same carve-out update_workflow_card's self-service status PATCH
    already relies on, so no separate per-study membership check."""
    cards = (
        db.query(WorkflowCard)
        .filter(WorkflowCard.type.in_([WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW]))
        .all()
    )
    my_cards = [c for c in cards if c.config.get("assigned_user_id") == user.subject]

    studies_by_id = {s.id: s for s in db.query(Study).filter(Study.id.in_({c.study_id for c in my_cards})).all()}

    result = []
    for card in my_cards:
        case_ids = card.output_case_ids or []
        cases = db.query(Case).filter(Case.id.in_(case_ids)).all() if case_ids else []
        study = studies_by_id.get(card.study_id)
        annotated_ids = set(_annotated_case_ids(db, case_ids, review=card.type == WorkflowCardType.REVIEW))
        result.append(
            {
                "study_id": str(card.study_id),
                "study_name": study.name if study else None,
                "card_id": str(card.id),
                "card_title": card.title,
                "card_type": card.type.value,
                "status": card.config.get("status", "todo"),
                "cases": [{"id": str(c.id), "title": c.title, "annotated": str(c.id) in annotated_ids} for c in cases],
            }
        )
    return result


@router.post("/studies/{study_id}/workflow/edges", status_code=201)
def create_workflow_edge(
    study_id: uuid.UUID,
    body: WorkflowEdgeIn,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    require_study_role(db, str(study_id), user, allowed_roles=_WRITE_ROLES)

    if body.source_card_id == body.target_card_id:
        raise HTTPException(status_code=422, detail="A card cannot connect to itself")

    source = _card_or_404(db, body.source_card_id)
    target = _card_or_404(db, body.target_card_id)
    if str(source.study_id) != str(study_id) or str(target.study_id) != str(study_id):
        raise HTTPException(status_code=422, detail="Both cards must belong to this study")

    if body.target_handle == "surface_config":
        # A Surface card's connection to the job card it restricts -- a
        # completely separate handle pair from the ordinary data
        # "input"/"output" flow, so it's validated here instead of
        # falling into the generic checks below (which would otherwise
        # reject a Surface type as a source via _NO_OUTPUT_TYPES). Each
        # Surface type only pairs with its own matching job type --
        # ANNOTATION_SURFACE with ANNOTATION, REVIEW_SURFACE with
        # REVIEW -- not interchangeably; the legacy bare SURFACE type is
        # never valid here, since no card is created with it anymore.
        _SURFACE_TARGET_TYPE = {
            WorkflowCardType.ANNOTATION_SURFACE: WorkflowCardType.ANNOTATION,
            WorkflowCardType.REVIEW_SURFACE: WorkflowCardType.REVIEW,
        }
        expected_target_type = _SURFACE_TARGET_TYPE.get(source.type)
        if expected_target_type is None:
            raise HTTPException(
                status_code=422,
                detail="Only an Annotation Surface or Review Surface card can connect to a surface_config handle",
            )
        if target.type != expected_target_type:
            raise HTTPException(
                status_code=422,
                detail=f"A {source.type.value} card can only connect to a {expected_target_type.value} card",
            )
        if body.source_handle != "surface_config":
            raise HTTPException(
                status_code=422, detail=f"Invalid source handle '{body.source_handle}' for a Surface card"
            )
        existing = (
            db.query(WorkflowEdge)
            .filter_by(target_card_id=target.id, target_handle="surface_config")
            .first()
        )
        if existing is not None:
            raise HTTPException(status_code=422, detail="This card already has a Surface connection")

        edge = WorkflowEdge(
            id=body.id or uuid.uuid4(),
            study_id=study_id,
            source_card_id=body.source_card_id,
            source_handle=body.source_handle,
            target_card_id=body.target_card_id,
            target_handle=body.target_handle,
        )
        db.add(edge)
        db.commit()
        db.refresh(edge)
        return {
            "id": str(edge.id),
            "source_card_id": str(edge.source_card_id),
            "source_handle": edge.source_handle,
            "target_card_id": str(edge.target_card_id),
            "target_handle": edge.target_handle,
        }

    if source.type in _NO_OUTPUT_TYPES:
        raise HTTPException(status_code=422, detail=f"A {source.type.value} card has no output")
    if target.type in _NO_INPUT_TYPES:
        raise HTTPException(status_code=422, detail=f"A {target.type.value} card has no input")

    if body.source_handle != "output":
        raise HTTPException(
            status_code=422, detail=f"Invalid source handle '{body.source_handle}' for a {source.type.value} card"
        )

    edge = WorkflowEdge(
        id=body.id or uuid.uuid4(),
        study_id=study_id,
        source_card_id=body.source_card_id,
        source_handle=body.source_handle,
        target_card_id=body.target_card_id,
        target_handle=body.target_handle,
    )
    db.add(edge)
    db.commit()
    db.refresh(edge)
    return {
        "id": str(edge.id),
        "source_card_id": str(edge.source_card_id),
        "source_handle": edge.source_handle,
        "target_card_id": str(edge.target_card_id),
        "target_handle": edge.target_handle,
    }


@router.delete("/workflow-edges/{edge_id}", status_code=204)
def delete_workflow_edge(
    edge_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> None:
    edge = db.get(WorkflowEdge, edge_id)
    if edge is None:
        raise HTTPException(status_code=404, detail="Edge not found")
    require_study_role(db, str(edge.study_id), user, allowed_roles=_WRITE_ROLES)
    db.delete(edge)
    db.commit()


def _resolve_output(db: Session, card: WorkflowCard, visiting: set) -> list[str]:
    """Every remaining edge-source type (Dataset/Filter/Union/Annotation/
    Review) exposes exactly one "output" handle, so there is no handle
    parameter to disambiguate -- Split, the one type that used to need
    one (train/val), can no longer be an edge source at all (see
    _NO_OUTPUT_TYPES); its result is only ever reached via a materialized
    Dataset child, which resolves through the plain DATASET branch below."""
    if card.id in visiting:
        raise HTTPException(status_code=409, detail="Cycle detected in workflow graph")
    visiting = visiting | {card.id}

    if card.type == WorkflowCardType.DATASET:
        return _dataset_output_ids(db, card)

    if card.output_case_ids is None:
        raise HTTPException(status_code=409, detail=f"Upstream card '{card.title}' has not been run yet")
    return list(card.output_case_ids)


def _single_incoming_edge(db: Session, card: WorkflowCard) -> WorkflowEdge:
    """The card's one *data-flow* incoming edge -- filtered to the
    "input" handle explicitly so a Surface card's "surface_config" edge
    (a separate handle on the same target card) never counts toward
    this "exactly one" check."""
    edges = db.query(WorkflowEdge).filter_by(target_card_id=card.id, target_handle="input").all()
    if len(edges) != 1:
        raise HTTPException(
            status_code=422, detail=f"A {card.type.value} card requires exactly one incoming connection"
        )
    return edges[0]


def _split_parts(config: dict) -> list[dict]:
    parts = config.get("parts")
    if not isinstance(parts, list) or len(parts) < 2:
        raise HTTPException(status_code=422, detail="Split needs at least 2 parts")
    return parts


def _cumulative_ratios(parts: list[dict]) -> list[float]:
    """Turns each part's (possibly unnormalized) ratio into an upper bound
    on a cumulative [0, 1) scale, e.g. ratios 0.5/0.3/0.2 -> [0.5, 0.8, 1.0].
    The last boundary is pinned to exactly 1.0 so float drift can never
    leave a case unbucketed."""
    total = sum(float(p.get("ratio", 0)) for p in parts) or 1.0
    cumulative = []
    running = 0.0
    for part in parts:
        running += float(part.get("ratio", 0)) / total
        cumulative.append(running)
    cumulative[-1] = 1.0
    return cumulative


def _split_bucket_index(case_id: str, seed: str, cumulative_ratios: list[float]) -> int:
    """Deterministic per-case-id hash assignment, not shuffle-and-cut: a
    given case always lands in the same part for a given seed regardless
    of what else is in the input set, so re-running Split after new cases
    are added upstream never reshuffles already-split cases. Generalizes
    the old binary train/val threshold to N parts via cumulative ratio
    boundaries."""
    digest = hashlib.sha256(f"{seed}:{case_id}".encode()).hexdigest()
    fraction = int(digest, 16) / (2**256 - 1)
    for index, boundary in enumerate(cumulative_ratios):
        if fraction < boundary:
            return index
    return len(cumulative_ratios) - 1


def _dedupe_sorted(ids) -> list[str]:
    return sorted(dict.fromkeys(ids))


def _matches_filter(tags: list[str], config: dict) -> bool:
    """Only one criterion type exists today ("tag") -- this shape is
    discriminated by `criterion_type` so a second one is additive later,
    not a breaking change to already-saved cards."""
    if config.get("criterion_type") == "tag":
        return config.get("tag") in tags
    return False


@router.post("/workflow-cards/{card_id}/run")
def run_workflow_card(
    card_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    card = _card_or_404(db, card_id)
    require_study_role(db, str(card.study_id), user, allowed_roles=["data_manager", "admin", "annotator", "reviewer"])

    if not _has_study_role(db, str(card.study_id), user, _WRITE_ROLES):
        # Narrowed permission, same reasoning/shape as update_workflow_card's
        # self-service status carve-out: the assignee of their own
        # Annotation/Review card may re-Run it (refreshing output_case_ids
        # and, if materialize_dataset is set, the "(annotated)" Dataset
        # child) without general board-editing/Run rights. This is what
        # lets ct-annotator's "Mark as Annotated" immediately push the case
        # into that materialized dataset instead of waiting for someone
        # with data_manager/admin to click Run on the board.
        if card.type not in (WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW) or card.config.get(
            "assigned_user_id"
        ) != user.subject:
            raise HTTPException(status_code=403, detail="Insufficient study role")

    if card.type in _NO_RUN_TYPES:
        raise HTTPException(status_code=422, detail=f"Nothing to run for a {card.type.value} card")

    if card.type == WorkflowCardType.DATASET:
        # A user-placed, general version of Split/Annotation/Review's
        # automatic "materialize": connect anything into a Dataset card
        # and Run snapshots that upstream result as this card's own
        # manual case list.
        edge = _single_incoming_edge(db, card)
        source = _card_or_404(db, edge.source_card_id)
        case_ids = sorted(_resolve_output(db, source, set()))
        card.config = {**card.config, "mode": "manual", "case_ids": case_ids}

    elif card.type == WorkflowCardType.SPLIT:
        edge = _single_incoming_edge(db, card)
        source = _card_or_404(db, edge.source_card_id)
        input_ids = _resolve_output(db, source, set())

        parts = _split_parts(card.config)
        seed = card.config.get("seed") or uuid.uuid4().hex
        cumulative = _cumulative_ratios(parts)

        buckets: list[list[str]] = [[] for _ in parts]
        for case_id in input_ids:
            buckets[_split_bucket_index(case_id, seed, cumulative)].append(case_id)

        existing_children = {c.materialized_source_handle: c for c in _materialized_children(db, card.id)}
        output: dict[str, list[str]] = {}
        for index, part in enumerate(parts):
            handle = f"part_{index}"
            case_ids = sorted(buckets[index])
            output[handle] = case_ids
            name = str(part.get("name") or f"Part {index + 1}")
            child = existing_children.get(handle)
            if child is None:
                db.add(
                    WorkflowCard(
                        study_id=card.study_id,
                        type=WorkflowCardType.DATASET,
                        title=name,
                        position_x=card.position_x + 260,
                        position_y=card.position_y + index * 140,
                        width=_MATERIALIZED_DEFAULT_WIDTH,
                        height=_MATERIALIZED_DEFAULT_HEIGHT,
                        config={"mode": "manual", "case_ids": case_ids},
                        materialized_source_card_id=card.id,
                        materialized_source_handle=handle,
                    )
                )
            else:
                # A part removed since the last Run leaves its old
                # materialized Dataset card in place, un-updated, rather
                # than deleting it -- board scratch space isn't
                # aggressively garbage-collected (same policy as
                # delete_workflow_card having no "still has data" guard).
                child.title = name
                child.config = {**child.config, "mode": "manual", "case_ids": case_ids}

        card.config = {**card.config, "seed": seed}
        card.output_case_ids = output

    elif card.type == WorkflowCardType.FILTER:
        edge = _single_incoming_edge(db, card)
        source = _card_or_404(db, edge.source_card_id)
        input_ids = _resolve_output(db, source, set())

        cases = db.query(Case).filter(Case.id.in_(input_ids)).all()
        card.output_case_ids = sorted(str(c.id) for c in cases if _matches_filter(case_tags(c), card.config))

    elif card.type == WorkflowCardType.UNION:
        incoming = db.query(WorkflowEdge).filter_by(target_card_id=card.id).all()
        if not incoming:
            raise HTTPException(status_code=422, detail="Union requires at least one incoming connection")
        all_ids = []
        for edge in incoming:
            source = _card_or_404(db, edge.source_card_id)
            all_ids.extend(_resolve_output(db, source, set()))
        card.output_case_ids = _dedupe_sorted(all_ids)

    elif card.type in (WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW):
        # Pure pass-through of the resolved input -- the "work" this Run
        # does is refreshing which cases are in scope after an upstream
        # change. The actual assignment (assignee/status) lives in
        # `config`, edited via PATCH, not Run.
        edge = _single_incoming_edge(db, card)
        source = _card_or_404(db, edge.source_card_id)
        card.output_case_ids = _resolve_output(db, source, set())

        if card.config.get("materialize_dataset"):
            # Only the subset with a real Annotation record (or, for
            # Review, one already approved/rejected) -- not every case the
            # card happens to be assigned, which would include ones no one
            # has actually annotated yet.
            case_ids = _annotated_case_ids(db, card.output_case_ids, review=card.type == WorkflowCardType.REVIEW)
            children = _materialized_children(db, card.id)
            title = f"{card.title} (annotated)"
            if not children:
                db.add(
                    WorkflowCard(
                        study_id=card.study_id,
                        type=WorkflowCardType.DATASET,
                        title=title,
                        position_x=card.position_x + 260,
                        position_y=card.position_y,
                        width=_MATERIALIZED_DEFAULT_WIDTH,
                        height=_MATERIALIZED_DEFAULT_HEIGHT,
                        config={"mode": "manual", "case_ids": case_ids},
                        materialized_source_card_id=card.id,
                        materialized_source_handle="output",
                    )
                )
            else:
                children[0].title = title
                children[0].config = {**children[0].config, "mode": "manual", "case_ids": case_ids}

    card.last_run_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(card)
    return _serialize_card(db, card, {card.id: card}, {})
