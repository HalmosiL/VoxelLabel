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
_NO_OUTPUT_TYPES = {WorkflowCardType.SPLIT, WorkflowCardType.NOTE, WorkflowCardType.MILESTONE}
# Dataset CAN take an incoming edge -- connecting something into it and
# running it snapshots that upstream result as this Dataset's manual case
# list (a user-placed, general version of Split/Annotation/Review's
# automatic "materialize" -- see the DATASET branch in run_workflow_card).
_NO_INPUT_TYPES = {WorkflowCardType.NOTE, WorkflowCardType.MILESTONE}
_NO_RUN_TYPES = {WorkflowCardType.NOTE, WorkflowCardType.MILESTONE}
_MATERIALIZED_DEFAULT_WIDTH = 200.0
_MATERIALIZED_DEFAULT_HEIGHT = 90.0


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


def _annotation_progress(db: Session, case_ids: list[str], review: bool) -> dict:
    if not case_ids:
        return {"annotated": 0, "total": 0}
    query = (
        db.query(func.count(func.distinct(ImagingStudy.case_id)))
        .join(Annotation, Annotation.target_id == ImagingStudy.id)
        .filter(Annotation.target_type == "study", ImagingStudy.case_id.in_(case_ids))
    )
    if review:
        query = query.filter(Annotation.status.in_([AnnotationStatus.APPROVED, AnnotationStatus.REJECTED]))
    return {"annotated": query.scalar() or 0, "total": len(case_ids)}


def _annotated_case_ids(db: Session, case_ids: list[str], review: bool) -> list[str]:
    """The subset of `case_ids` that actually have a real Annotation record
    (or, for Review, one already approved/rejected) -- the same real-data
    cross-check `_annotation_progress` counts, but returning which cases
    those are rather than just how many. Used to materialize an "annotated
    dataset" containing only genuinely annotated cases, not every case the
    Annotation/Review card happens to be assigned."""
    if not case_ids:
        return []
    query = (
        db.query(func.distinct(ImagingStudy.case_id))
        .join(Annotation, Annotation.target_id == ImagingStudy.id)
        .filter(Annotation.target_type == "study", ImagingStudy.case_id.in_(case_ids))
    )
    if review:
        query = query.filter(Annotation.status.in_([AnnotationStatus.APPROVED, AnnotationStatus.REJECTED]))
    return sorted(str(row[0]) for row in query.all())


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
    edges = db.query(WorkflowEdge).filter_by(target_card_id=card.id).all()
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
    require_study_role(db, str(card.study_id), user, allowed_roles=_WRITE_ROLES)

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
