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
import asyncio
import hashlib
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.llm_client import run_llm_turn
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
# LLM (the Clinical Trial module's real chat card, driven by a local
# model over MCP) has a real "input" -- Dataset(s) wired in as its
# connected data sources -- but no real "output" of its own: like
# Split, what it produces is expressed as named materialized Dataset
# children (see llm_chat), not a graph edge, and it's never Run in the
# batch sense (a chat message drives it instead), so it's
# _NO_OUTPUT_TYPES and _NO_RUN_TYPES but *not* _NO_INPUT_TYPES.
# BUILDER (the Pipeline Builder chat card) is scoped to the whole Study
# rather than to connected data -- it has no input or output edges at
# all, structurally like Note/Milestone, but is chat-capable like LLM.
# CRITERION (a per-eligibility-criterion chat sub-agent) mirrors LLM's
# shape exactly: a real "input" (the population it judges), no real
# output of its own (it always materializes named "included"/"excluded"
# Dataset children instead, via evaluate_criterion -- see llm_chat).
# Unlike LLM/Builder, Criterion's one useful action ("evaluate every
# connected case against my stored criterion") is well-defined and
# repeatable -- not open-ended chat -- so it's the one chat-capable
# type that's also a RUNNABLE_TYPES/Run target: see _run_one_card's own
# CRITERION branch, which is a canned-message shortcut through the same
# run_llm_turn loop, not a separate deterministic implementation.
_NO_OUTPUT_TYPES = {
    WorkflowCardType.SPLIT,
    WorkflowCardType.NOTE,
    WorkflowCardType.MILESTONE,
    WorkflowCardType.LLM,
    WorkflowCardType.BUILDER,
    WorkflowCardType.CRITERION,
    *_SURFACE_TYPES,
}
# Dataset CAN take an incoming edge -- connecting something into it and
# running it snapshots that upstream result as this Dataset's manual case
# list (a user-placed, general version of Split/Annotation/Review's
# automatic "materialize" -- see the DATASET branch in run_workflow_card).
_NO_INPUT_TYPES = {WorkflowCardType.NOTE, WorkflowCardType.MILESTONE, WorkflowCardType.BUILDER, *_SURFACE_TYPES}
_NO_RUN_TYPES = {
    WorkflowCardType.NOTE,
    WorkflowCardType.MILESTONE,
    WorkflowCardType.LLM,
    WorkflowCardType.BUILDER,
    *_SURFACE_TYPES,
}
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
    # No pre-defined labels by default -- an annotator types their own
    # "New label" name in ct-annotator, exactly as before this field
    # existed. An Annotation Surface can pre-populate this list (e.g.
    # "Nodule") so every annotator on a study creates instances under
    # the same, consistently-named/colored label instead of each typing
    # their own. Review jobs never see labels (nothing to paint), so
    # this is never forced/overridden the way tools/show_3d are below.
    "labels": [],
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


class LlmChatIn(BaseModel):
    message: str


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


_ANNOTATED_STATUSES = [AnnotationStatus.SUBMITTED, AnnotationStatus.APPROVED]


def _latest_annotation_by_target(db: Session, target_type: str, target_ids: set, since=None) -> dict:
    """Maps each of `target_ids` (all the same `target_type`) to its most
    recently created Annotation's (id, status, created_at) -- "latest
    version" the same way annotation-service's list_annotations_for_target
    already defines it (oldest-first by created_at; the last one is
    current). Uses Postgres's DISTINCT ON to pick that one row per target
    directly in SQL, rather than fetching full history and reducing in
    Python.

    `since`, when given, ignores any Annotation older than that -- see
    `_latest_annotation_per_case`'s docstring for why a card needs this."""
    if not target_ids:
        return {}
    query = db.query(Annotation.target_id, Annotation.id, Annotation.status, Annotation.created_at).filter(
        Annotation.target_type == target_type, Annotation.target_id.in_(target_ids)
    )
    if since is not None:
        query = query.filter(Annotation.created_at >= since)
    rows = query.order_by(Annotation.target_id, Annotation.created_at.desc()).distinct(Annotation.target_id).all()
    return {row[0]: (row[1], row[2], row[3]) for row in rows}


def _latest_annotation_per_case(db: Session, case_ids: list[str], since=None) -> dict:
    """Maps each of `case_ids` to its single most-recent Annotation's
    (id, status, created_at) -- across *all* of that case's targets, not
    just whichever target type happens to match first. Shared by
    `_case_ids_with_status` (below) and the per-case review action (the
    Study page's Approve/Reject buttons need the actual annotation id to
    decide on, not just a yes/no membership check).

    No Annotation is ever created with `target_type == "study"` anywhere
    in this codebase -- ct-annotator's real save path (the segmentation
    volume workflow every other part of this session is built around)
    posts with `target_type == "series"`, and its older bbox/freehand
    path posts with `target_type == "instance"`; a `"study"`-only check
    here could never match either. A case can carry annotation history
    on both paths (e.g. old per-instance bbox rows from before its real
    work moved to the modern per-series segmentation-volume flow) --
    comparing each target's own latest independently and unioning the
    matches would let a stale rejection on a path the case has long
    since moved past permanently outvote a newer decision made on the
    other path. Instead this picks the single most recent Annotation
    across both target types per case.

    `since` (pass a card's own `created_at`) excludes any Annotation
    older than that -- otherwise a brand-new Annotation/Review card
    placed downstream of an existing one that already annotated/reviewed
    these same cases would read that older card's work as its own and
    show every case "done" before anyone has touched *this* job at all.
    A case's annotation history is otherwise tracked purely per case,
    with no notion of which workflow card a given Annotation belongs to
    -- this is what stands in for that, cheaply, without a schema
    change: nothing before this card existed counts toward it."""
    if not case_ids:
        return {}

    series_rows = (
        db.query(ImagingStudy.case_id, Series.id)
        .join(Series, Series.imaging_study_id == ImagingStudy.id)
        .filter(ImagingStudy.case_id.in_(case_ids))
        .all()
    )
    instance_rows = (
        db.query(ImagingStudy.case_id, Instance.id)
        .join(Series, Series.imaging_study_id == ImagingStudy.id)
        .join(Instance, Instance.series_id == Series.id)
        .filter(ImagingStudy.case_id.in_(case_ids))
        .all()
    )

    series_latest = _latest_annotation_by_target(db, "series", {row[1] for row in series_rows}, since=since)
    instance_latest = _latest_annotation_by_target(db, "instance", {row[1] for row in instance_rows}, since=since)

    # The single most recent Annotation for each case, across both of its
    # target types (compared by created_at, the 3rd element of each entry).
    latest_per_case: dict = {}
    for case_id, series_id in series_rows:
        entry = series_latest.get(series_id)
        if entry and (case_id not in latest_per_case or entry[2] > latest_per_case[case_id][2]):
            latest_per_case[case_id] = entry
    for case_id, instance_id in instance_rows:
        entry = instance_latest.get(instance_id)
        if entry and (case_id not in latest_per_case or entry[2] > latest_per_case[case_id][2]):
            latest_per_case[case_id] = entry

    return latest_per_case


def _case_ids_with_status(db: Session, case_ids: list[str], statuses: list[AnnotationStatus], since=None) -> list[str]:
    """The subset of `case_ids` whose single most-recent Annotation record
    (see `_latest_annotation_per_case`) is in one of `statuses`. Shared by
    `_annotated_case_ids` (combined submitted-or-approved / approved-or-
    rejected checks) and Review's per-decision materialization (approved-
    only, rejected-only), below."""
    latest_per_case = _latest_annotation_per_case(db, case_ids, since=since)
    return sorted(str(cid) for cid, (_id, status, _created_at) in latest_per_case.items() if status in statuses)


def _annotated_case_ids(db: Session, case_ids: list[str], review: bool, since=None) -> list[str]:
    """The subset of `case_ids` that actually have a real, *deliberately
    submitted* Annotation record (or, for Review, one already
    approved/rejected) -- a bare draft (created on every ct-annotator
    Save, as an in-progress version) doesn't count on its own; the
    annotator explicitly marking a case done (ct-annotator's "Mark as
    annotated", which saves with status=submitted) is what flips this,
    matching what a Reviewer would actually want to see queued.

    REJECTED is deliberately excluded from the Annotation side (though
    still counted on the Review side, here): a rejection means the case
    needs rework, so it should fall back out of the Annotation job's own
    "annotated" count rather than keep showing as done -- the annotator
    then sees it drop out of their completed total (and back out of a
    job that had reached "done"), no separate rework queue needed. If
    they resubmit, the new Annotation row's own SUBMITTED status counts
    it again, regardless of the older REJECTED row still sitting there."""
    statuses = [AnnotationStatus.APPROVED, AnnotationStatus.REJECTED] if review else _ANNOTATED_STATUSES
    return _case_ids_with_status(db, case_ids, statuses, since=since)


def _annotation_progress(db: Session, case_ids: list[str], review: bool, since=None) -> dict:
    if not case_ids:
        return {"annotated": 0, "total": 0}
    if review:
        # A case with nothing ever submitted has nothing for a reviewer
        # to decide on -- it shouldn't count toward this job's total any
        # more than it belongs in its case list (see
        # _cases_with_annotated_status, which excludes it the same way).
        latest_per_case = _latest_annotation_per_case(db, case_ids, since=since)
        annotated = sum(
            1 for entry in latest_per_case.values() if entry[1] in (AnnotationStatus.APPROVED, AnnotationStatus.REJECTED)
        )
        return {"annotated": annotated, "total": len(latest_per_case)}
    return {"annotated": len(_annotated_case_ids(db, case_ids, review, since=since)), "total": len(case_ids)}


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
            db, output_case_ids, review=card.type == WorkflowCardType.REVIEW, since=card.created_at
        )

    if card.type in (WorkflowCardType.SPLIT, WorkflowCardType.REVIEW, WorkflowCardType.LLM, WorkflowCardType.CRITERION):
        # Split materializes one Dataset per part (part_0, part_1, ...);
        # Review materializes one per decision (approved, rejected) -- the
        # "rejected" one is what a feedback edge back into an Annotation
        # card is drawn from; LLM materializes one per "create a dataset"
        # request in its chat session (created_1, created_2, ...);
        # Criterion always materializes exactly "included"/"excluded",
        # via evaluate_criterion -- same handle-keyed shape as Review's
        # approved/rejected. Same plural shape for all four.
        children = _materialized_children(db, card.id)
        result["materialized_card_ids"] = {c.materialized_source_handle: str(c.id) for c in children}
        if card.type in (WorkflowCardType.REVIEW, WorkflowCardType.CRITERION):
            # Backs the small named-output markers on the node itself
            # (approved/rejected or included/excluded case counts), each
            # child's own stored case list is already a plain "manual"
            # snapshot.
            result["materialized_counts"] = {
                c.materialized_source_handle: len(c.config.get("case_ids", [])) for c in children
            }
    elif card.type == WorkflowCardType.ANNOTATION:
        children = _materialized_children(db, card.id)
        result["materialized_card_id"] = str(children[0].id) if children else None

    if card.type in (WorkflowCardType.LLM, WorkflowCardType.CRITERION):
        # The node's own "N cases connected" summary -- computed fresh
        # every time rather than cached, since this card is never Run
        # (see _NO_RUN_TYPES); its "input" edges may change at any time.
        # Builder has no connected data at all (scoped to the whole
        # study instead), so it gets no such count.
        result["llm_connected_case_count"] = len(_llm_connected_case_ids(db, card))

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


@router.get("/studies/{study_id}/consort-export")
def get_consort_export(
    study_id: uuid.UUID,
    root_card_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Walks a CONSORT-style eligibility chain starting at `root_card_id`
    (the whole study population, as a plain Dataset card) and following
    each Criterion's "included" branch into the next Criterion -- the
    real per-stage case counts a publication-ready CONSORT flow diagram
    needs (see admin-ui's ConsortExportPage), derived live from the
    board rather than hand-maintained anywhere.

    Stops at the first point that isn't itself another Criterion (a
    Dataset with nothing chained onward -- the final eligible cohort),
    or at a Criterion that hasn't been evaluated yet (its "included"
    child doesn't exist, so there's nothing further to walk into --
    that criterion's own row still reports `evaluated: false` rather
    than being silently dropped, so the export honestly shows the
    pipeline is still in progress instead of pretending it ends there).
    """
    require_study_role(db, str(study_id), user, allowed_roles=_READ_ROLES)
    root = _card_or_404(db, root_card_id)
    if str(root.study_id) != str(study_id):
        raise HTTPException(status_code=422, detail="Card does not belong to this study")
    if root.type != WorkflowCardType.DATASET:
        raise HTTPException(status_code=422, detail="root_card_id must be a Dataset card (the starting population)")

    root_count = len(_dataset_output_ids(db, root))
    stages = []
    visited: set[uuid.UUID] = {root.id}
    current = root

    while True:
        # The next Criterion is whatever's wired onto `current`'s real
        # "output" -- true for the root Dataset itself, and for every
        # subsequent step too, since an "included" child is always a
        # plain (materialized) Dataset card, same as the root.
        edge = (
            db.query(WorkflowEdge)
            .filter_by(source_card_id=current.id, source_handle="output", target_handle="input")
            .first()
        )
        if edge is None or edge.target_card_id in visited:
            break
        next_card = db.get(WorkflowCard, edge.target_card_id)
        if next_card is None or next_card.type != WorkflowCardType.CRITERION:
            break
        visited.add(next_card.id)

        children = {c.materialized_source_handle: c for c in _materialized_children(db, next_card.id)}
        included = children.get("included")
        excluded = children.get("excluded")
        stages.append(
            {
                "criterion_card_id": str(next_card.id),
                "title": next_card.title,
                "criterion_text": next_card.config.get("criterion", ""),
                "input_count": len(_dataset_output_ids(db, current)),
                "included_count": len(included.config.get("case_ids", [])) if included else None,
                "excluded_count": len(excluded.config.get("case_ids", [])) if excluded else None,
                "evaluated": included is not None,
            }
        )
        if included is None:
            break
        current = included

    # The most current known cohort size -- the last *evaluated* stage's
    # included_count, not necessarily the literal last stage (which may
    # be an as-yet-unevaluated Criterion at the end of the chain, in
    # which case the cohort is still whatever the stage before it left).
    final_count = root_count
    for stage in stages:
        if stage["evaluated"]:
            final_count = stage["included_count"]
    return {
        "root": {"card_id": str(root.id), "title": root.title, "case_count": root_count},
        "stages": stages,
        "final_count": final_count,
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
        # A merge, not a replace: a caller that only knows about the one
        # field it's changing (e.g. ct-annotator's status-dropdown proxy,
        # which sends only {"status": ...} with no visibility into the
        # card's other config) would otherwise silently wipe everything
        # else already in config -- assigned_user_id notably included.
        # admin-ui's own callers already always send the full spread
        # ({...card.config, field: value}), so a merge here behaves
        # identically for them; it only changes behavior for a caller
        # that was sending a partial config, where replace was never the
        # intended outcome.
        card.config = {**card.config, **body.config}

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
    kind of Surface card produced it. `labels` is never forced off for a
    Review job the way tools/show_3d are -- it's simply whatever the
    Surface card holds (empty for a REVIEW_SURFACE, since one is never
    given a reason to set it), harmless either way since Review has no
    painting tools to create instances with regardless.

    `labels` ([{name, color}, ...]) lets an Annotation Surface
    pre-populate ct-annotator's own label list (see ViewerPage's
    segmentation-volume-loading effect) so every annotator on a study
    creates instances under the same, consistently-named/colored label
    (e.g. "Nodule") instead of each typing their own -- only applied
    when a series has no saved labels yet, never overwriting an
    annotator's own already-in-progress work.

    `card_type` (the underlying job's own type, "annotation" or
    "review") rides along in every response so ct-annotator can tell a
    Review job apart from an Annotation one and switch to its
    simplified, view-and-decide-only surface -- there's no other cheap
    way for it to learn this without a second round trip. `status`
    (todo/in_progress/done) rides along too, so ct-annotator can show
    and let the assignee change it without a separate fetch."""
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
            "labels": surface.config.get("labels", []),
        }

    if is_review:
        config = {**config, "tools": [], "show_3d": False}

    return {**config, "card_type": card.type.value, "status": card.config.get("status", "todo")}


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
        study = studies_by_id.get(card.study_id)
        result.append(
            {
                "study_id": str(card.study_id),
                "study_name": study.name if study else None,
                "card_id": str(card.id),
                "card_title": card.title,
                "card_type": card.type.value,
                "status": card.config.get("status", "todo"),
                "cases": _cases_with_annotated_status(db, card),
            }
        )
    return result


def _case_status(entry, review: bool) -> str:
    """Classifies a case's single latest Annotation (see
    `_latest_annotation_per_case`, `None` if it has none at all) into one
    of three states worth showing distinctly, rather than collapsing
    "rejected -- needs rework" into the same "not annotated" bucket a
    case that was simply never touched would show:
    - "done": submitted-or-approved for an Annotation card; approved for
      a Review card.
    - "rejected": needs rework -- kept separate so it doesn't read as
      "nothing has happened here yet".
    - "pending": nothing submitted yet (Annotation), or awaiting a
      decision (Review, including a bare SUBMITTED with no decision)."""
    if entry is None:
        return "pending"
    status = entry[1]
    if status == AnnotationStatus.REJECTED:
        return "rejected"
    if review:
        return "done" if status == AnnotationStatus.APPROVED else "pending"
    return "done" if status in (AnnotationStatus.SUBMITTED, AnnotationStatus.APPROVED) else "pending"


def _cases_with_annotated_status(db: Session, card: WorkflowCard) -> list[dict]:
    """The Annotation/Review card's case scope, each case's title
    alongside its status (see `_case_status`) -- shared by list_my_jobs
    and get_workflow_card_cases (the Study page's per-row expand). Every
    case also carries `latest_annotation_id`: the id of its single most
    recent Annotation record regardless of status, or null if it has
    none -- backs the Study page's "Delete annotation" action. For a
    Review card, each case additionally carries `pending_annotation_id`:
    the same id but only while that record is still SUBMITTED (awaiting
    a decision) -- null otherwise. Backs the Approve/Reject buttons,
    which need the actual annotation id to decide on, not just its
    status."""
    case_ids = card.output_case_ids or []
    if not case_ids:
        return []
    cases = db.query(Case).filter(Case.id.in_(case_ids)).all()
    review = card.type == WorkflowCardType.REVIEW
    latest_per_case = _latest_annotation_per_case(db, case_ids, since=card.created_at)

    result = []
    for c in cases:
        entry = latest_per_case.get(c.id)
        # A Review card's own list is scoped to cases actually awaiting
        # (or already given) a decision -- one that's never had anything
        # submitted is stale scope left over from before its last
        # annotation was deleted, or from a Review wired straight to a
        # Dataset instead of through Annotation's materialized
        # "(annotated)" child. Either way there's nothing here for a
        # reviewer to act on, so it drops out immediately (a live filter,
        # not something waiting on a Run) rather than sitting there
        # mislabeled "Not annotated" as if it just hadn't been reached
        # yet. It still shows correctly wherever its Annotation job's own
        # list is drawn from -- this only narrows the Review side.
        if review and entry is None:
            continue
        case = {
            "id": str(c.id),
            "title": c.title,
            "status": _case_status(entry, review),
            "latest_annotation_id": str(entry[0]) if entry else None,
        }
        if review:
            case["pending_annotation_id"] = str(entry[0]) if entry and entry[1] == AnnotationStatus.SUBMITTED else None
        result.append(case)
    return result


@router.get("/workflow-cards/{card_id}/cases")
def get_workflow_card_cases(
    card_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """Same per-case status breakdown list_my_jobs already returns per
    card, just reachable for any Annotation/Review card the caller can
    see (not only their own assigned ones) -- backs the expandable row
    on the Study page's Annotations/Reviews tables."""
    card = _card_or_404(db, card_id)
    require_study_role(db, str(card.study_id), user, allowed_roles=_READ_ROLES)
    return _cases_with_annotated_status(db, card)


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


def _llm_connected_case_ids(db: Session, card: WorkflowCard) -> list[str]:
    """Every case reachable from an LLM or Criterion card's real "input"
    edges, unioned and deduped -- "which databases are connected via
    MCP" for the Clinical Trial Assistant, or "which cases this
    criterion judges" for a Criterion sub-agent. Same union shape as
    the ANNOTATION/UNION branches of _run_one_card, just resolved on
    demand (neither card type is ever Run -- see _NO_RUN_TYPES -- so
    there's no cached `output_case_ids` to read instead)."""
    incoming = db.query(WorkflowEdge).filter_by(target_card_id=card.id, target_handle="input").all()
    all_ids: list[str] = []
    for edge in incoming:
        source = _card_or_404(db, edge.source_card_id)
        all_ids.extend(_resolve_output(db, source, set()))
    return _dedupe_sorted(all_ids)


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


def _split_case_ids(case_ids: list[str], seed: str, cumulative_ratios: list[float]) -> list[list[str]]:
    """Assigns every case to exactly one part, always hitting each part's
    exact target ratio -- unlike giving each case an independent
    per-case hash draw (a weighted coin flip per case), which only
    approaches the target ratio statistically and can be visibly off for
    a small case count (e.g. 10 cases at a 70/30 split could easily land
    6/4 or 8/2). Sorts all cases by a stable per-case hash (deterministic
    for a given seed, unrelated to any other case) and cuts that order
    at the ratio boundaries. Still close to stable when the input set
    changes: adding one case only shifts the ranks after it by one
    position, so at most the case(s) sitting right at a cut boundary can
    move to the adjacent part -- not a full reshuffle -- while every
    Run still lands on the exact requested ratio."""
    ordered = sorted(case_ids, key=lambda cid: hashlib.sha256(f"{seed}:{cid}".encode()).hexdigest())
    total = len(ordered)
    boundaries = [round(ratio * total) for ratio in cumulative_ratios]
    boundaries[-1] = total  # pin the last boundary so rounding never drops a case
    buckets: list[list[str]] = []
    start = 0
    for boundary in boundaries:
        buckets.append(ordered[start:boundary])
        start = boundary
    return buckets


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

    _run_one_card(db, card)

    # Ripple the refresh downstream: whatever's wired off this card (or
    # off its materialized "(annotated)"/Split-part Dataset child --
    # that's typically where a user actually draws the next edge from,
    # not the Annotation/Review/Split card itself) gets re-Run too, so
    # e.g. marking a case Annotated is immediately visible at a
    # downstream Review card without someone separately clicking Run on
    # it. Best-effort per branch: a downstream card that can't run for
    # its own reasons (a genuinely broken edge, say) doesn't take down
    # the response for the card the caller actually asked to run.
    for downstream in _downstream_cards(db, card):
        try:
            _cascade_run(db, downstream, {card.id})
        except HTTPException:
            pass

    # A feedback-loop board (Review's rejected branch back into
    # Annotation) means the cascade above can change something `card`
    # itself reads from -- e.g. Running Review after a fresh reject
    # ripples into Annotation, which then excludes that case from its
    # materialized "(annotated)" child, which is exactly what Review's
    # own scope was just computed from. Left alone, `card` would come
    # back from this endpoint already one step stale again, with
    # nothing prompting a second Run. Settle it here instead: a real
    # board only has a card or two in any one feedback loop, so this
    # converges within a couple of extra passes; the cap is just to
    # guarantee termination, not because more passes are expected.
    for _ in range(3):
        if not _card_is_stale(db, card):
            break
        _run_one_card(db, card)
        for downstream in _downstream_cards(db, card):
            try:
                _cascade_run(db, downstream, {card.id})
            except HTTPException:
                pass

    db.refresh(card)
    return _serialize_card(db, card, {card.id: card}, {})


@router.post("/workflow-cards/{card_id}/llm-chat")
async def llm_chat(
    card_id: uuid.UUID,
    body: LlmChatIn,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """A real chat session for any of the Clinical Trial module's three
    AI card types (LLM, Builder, Criterion) -- a small local model
    (served by Ollama) driven through a real MCP server's tools (see
    run_llm_turn / services/mcp-server), each card type exposing its
    own system prompt and its own filtered subset of tools. The model
    itself decides whether a message warrants calling a board-mutating
    tool (create_dataset, create_dataset_card, add_criterion,
    evaluate_criterion -- each materializing or wiring up real cards,
    exactly the way Split materializes a part or Review materializes a
    decision branch) versus just answering in text."""
    card = _card_or_404(db, card_id)
    require_study_role(db, str(card.study_id), user, allowed_roles=_WRITE_ROLES)
    if card.type not in (WorkflowCardType.LLM, WorkflowCardType.BUILDER, WorkflowCardType.CRITERION):
        raise HTTPException(status_code=422, detail="Not a chat-capable card")

    history = list(card.config.get("messages", []))
    new_messages, board_changed = await run_llm_turn(card, history, body.message)

    card.config = {**card.config, "messages": history + new_messages}
    db.commit()
    db.refresh(card)
    return {"board_changed": board_changed, **_serialize_card(db, card, {card.id: card}, {})}


def _run_one_card(db: Session, card: WorkflowCard) -> None:
    """The actual per-type Run logic, shared by the direct
    run_workflow_card endpoint and _cascade_run's downstream ripple.
    Commits and stamps last_run_at itself; does not serialize a
    response (callers that need one call _serialize_card afterward).

    Every materialized Dataset child this Run creates or refreshes is
    stamped with the same `now` too (see `_is_stale`'s docstring on why a
    child that's never been "run" itself can never make anything
    downstream of it look stale) -- otherwise a card whose only input is
    a materialized child (the overwhelmingly common case: almost nothing
    in a real board connects straight to a Split/Annotation/Review card)
    can never be flagged stale no matter how much its actual case
    membership has changed, e.g. after a reviewer's decision quietly
    moves a case out of the materialized "(annotated)" dataset a Review
    card reads from -- the case's own status updates immediately
    (annotation-service owns that independently), but nothing here knew
    to mark the Review card as needing a re-run until now."""
    now = datetime.now(timezone.utc)

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

        buckets = _split_case_ids(input_ids, seed, cumulative)

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
                        last_run_at=now,
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
                child.last_run_at = now

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

    elif card.type == WorkflowCardType.ANNOTATION:
        # Union of every incoming source's cases (not "exactly one" like
        # Filter/Dataset/Review) -- this is what lets a Review card's
        # "(rejected)" materialized branch feed back into an Annotation
        # card as a second input alongside its original source, forming
        # a real feedback loop: Annotation -> Review -> back into
        # Annotation. Safe against cycles because Run only ever reads
        # each upstream card's already-computed, stored output_case_ids
        # (or a manual Dataset's static case_ids) -- never a live
        # recursive walk -- so there's no infinite loop, just a snapshot
        # from whenever each side was last Run.
        incoming = db.query(WorkflowEdge).filter_by(target_card_id=card.id, target_handle="input").all()
        if not incoming:
            raise HTTPException(status_code=422, detail="Annotation requires at least one incoming connection")
        all_ids = []
        for edge in incoming:
            source = _card_or_404(db, edge.source_card_id)
            all_ids.extend(_resolve_output(db, source, set()))
        card.output_case_ids = _dedupe_sorted(all_ids)

        if card.config.get("materialize_dataset"):
            # Only the subset with a real, submitted-or-approved
            # Annotation record -- not every case the card happens to be
            # assigned, which would include ones no one has actually
            # annotated yet.
            case_ids = _annotated_case_ids(db, card.output_case_ids, review=False, since=card.created_at)
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
                        last_run_at=now,
                    )
                )
            else:
                children[0].title = title
                children[0].config = {**children[0].config, "mode": "manual", "case_ids": case_ids}
                children[0].last_run_at = now

    elif card.type == WorkflowCardType.REVIEW:
        # Pure pass-through of the resolved input -- the "work" this Run
        # does is refreshing which cases are in scope after an upstream
        # change. The actual assignment (assignee/status) lives in
        # `config`, edited via PATCH, not Run.
        edge = _single_incoming_edge(db, card)
        source = _card_or_404(db, edge.source_card_id)
        card.output_case_ids = _resolve_output(db, source, set())

        # Unlike Annotation's "(annotated)" child (opt-in via
        # materialize_dataset), Review always materializes both branches
        # on every Run: "(approved)" for cases that passed review,
        # "(rejected)" for cases that need rework. A feedback edge from
        # "(rejected)" back into an Annotation card's input is exactly
        # how that rework gets requeued to the annotator, so both need
        # to exist immediately -- there's no meaningful "Review without
        # its own decision outputs" the way there is for Annotation.
        existing_children = {c.materialized_source_handle: c for c in _materialized_children(db, card.id)}
        branches = {
            "approved": _case_ids_with_status(db, card.output_case_ids, [AnnotationStatus.APPROVED], since=card.created_at),
            "rejected": _case_ids_with_status(db, card.output_case_ids, [AnnotationStatus.REJECTED], since=card.created_at),
        }
        for index, (handle, case_ids) in enumerate(branches.items()):
            title = f"{card.title} ({handle})"
            child = existing_children.get(handle)
            if child is None:
                db.add(
                    WorkflowCard(
                        study_id=card.study_id,
                        type=WorkflowCardType.DATASET,
                        title=title,
                        position_x=card.position_x + 260,
                        position_y=card.position_y + index * 140,
                        width=_MATERIALIZED_DEFAULT_WIDTH,
                        height=_MATERIALIZED_DEFAULT_HEIGHT,
                        config={"mode": "manual", "case_ids": case_ids},
                        materialized_source_card_id=card.id,
                        materialized_source_handle=handle,
                        last_run_at=now,
                    )
                )
            else:
                child.title = title
                child.config = {**child.config, "mode": "manual", "case_ids": case_ids}
                child.last_run_at = now

    elif card.type == WorkflowCardType.CRITERION:
        # "Run" here is a convenience shortcut for the same thing typing
        # a message into this card's own chat session would do -- a
        # fixed canned instruction through the exact same model + MCP
        # tool loop (see llm_client.run_llm_turn), appended to the
        # card's own transcript so it shows up if the session is opened
        # afterward. Unlike every branch above, this one genuinely calls
        # out to a local model over MCP (not a deterministic recompute),
        # so failures (Ollama/mcp-server down) come back as a normal
        # assistant message in the transcript rather than an exception --
        # run_llm_turn already handles that itself. asyncio.run() is
        # safe here because this whole endpoint is a sync `def`, so
        # FastAPI executes it in a worker thread with no event loop of
        # its own to conflict with.
        history = list(card.config.get("messages", []))
        new_messages, _ = asyncio.run(
            run_llm_turn(
                card, history, "Look at every case connected to your input, and evaluate this criterion now."
            )
        )
        card.config = {**card.config, "messages": history + new_messages}

    card.last_run_at = now
    db.commit()


def _card_is_stale(db: Session, card: WorkflowCard) -> bool:
    """The same staleness check `_serialize_card` computes for the whole
    board, for one card in isolation -- lets `run_workflow_card` notice
    when its own downstream cascade has looped back and changed
    something this card reads from (see `_cascade_run`'s docstring: its
    cycle protection deliberately doesn't re-run a card twice within one
    cascade, so the card that was actually asked to run can come out of
    that cascade already stale again)."""
    edges = db.query(WorkflowEdge).filter_by(target_card_id=card.id).all()
    for edge in edges:
        source = db.get(WorkflowCard, edge.source_card_id)
        if source and _is_stale(card.last_run_at, source.last_run_at):
            return True
    return False


def _downstream_cards(db: Session, card: WorkflowCard) -> list[WorkflowCard]:
    """Every card with a real "output" -> "input" data-flow edge from
    `card` *or* from whichever Dataset card(s) `card` just materialized
    (its "(annotated)" Annotation child, "(approved)"/"(rejected)"
    Review children, or Split-part children) -- a user typically draws
    the next edge from a materialized Dataset, not from the Annotation/
    Review/Split card itself, so both sources need checking."""
    source_ids = {card.id} | {c.id for c in _materialized_children(db, card.id)}
    edges = db.query(WorkflowEdge).filter(WorkflowEdge.source_card_id.in_(source_ids), WorkflowEdge.source_handle == "output").all()
    target_ids = {e.target_card_id for e in edges}
    return [c for c in (db.get(WorkflowCard, tid) for tid in target_ids) if c is not None]


def _cascade_run(db: Session, card: WorkflowCard, visited: set[uuid.UUID]) -> None:
    """Runs `card` and then ripples to whatever's downstream of it, same
    as run_workflow_card's own top-level ripple -- recursive so a chain
    like Annotation -> (annotated) -> Review -> (annotated) -> Union all
    refreshes together. `visited` is cycle protection (same idea as
    _resolve_output's) -- genuinely needed now, not just defensive: a
    Review's "(rejected)" branch feeding back into an Annotation card's
    input is a real, intended cycle (see the ANNOTATION branch of
    _run_one_card), so cascading a Run from Annotation can reach Review
    can reach back to that same Annotation card. `visited` stops the
    cascade there rather than looping -- that card just doesn't get a
    second Run within the same cascade; a rejection surfaces on its next
    explicit Run.

    CRITERION is deliberately excluded here even though it's now a
    RUNNABLE_TYPES card (see _run_one_card): unlike every other Run
    branch, its "Run" is a real model call (several seconds, real
    Ollama/GPU load), not a cheap deterministic recompute -- silently
    firing one on every downstream ripple (e.g. every single case a
    batch import adds, via _cascade_new_case) would be slow and
    surprising. A Criterion only ever evaluates when its own Run is
    clicked (or its own chat is used) directly, never as a side effect
    of some other card's Run."""
    if card.id in visited or card.type in _NO_RUN_TYPES or card.type == WorkflowCardType.CRITERION:
        return
    visited = visited | {card.id}
    _run_one_card(db, card)
    for downstream in _downstream_cards(db, card):
        try:
            _cascade_run(db, downstream, visited)
        except HTTPException:
            pass


def _cascade_new_case(db: Session, study_id: uuid.UUID) -> None:
    """Ripples a just-created case through the board on its own, instead
    of leaving it sitting in a Study until someone happens to click Run
    somewhere -- called right after a new Case is committed (see
    app/api/cases.py's create_case).

    Only "all_cases" Dataset cards need triggering here: that's the one
    card shape whose scope is computed live on every read (see
    _dataset_output_ids), so it already includes the new case with no
    Run of its own needed -- a "manual" Dataset is a deliberately
    curated, pinned list and is never auto-updated, same as today. Once
    an "all_cases" Dataset's new membership is established, everything
    wired downstream of it gets the same cascade a manual Run already
    does, via the exact same _downstream_cards/_cascade_run pair.
    Best-effort per branch, same reasoning as run_workflow_card's own
    top-level cascade: a downstream card that can't Run for its own
    reasons shouldn't block the case from having been created."""
    dataset_cards = (
        db.query(WorkflowCard)
        .filter(WorkflowCard.study_id == study_id, WorkflowCard.type == WorkflowCardType.DATASET)
        .all()
    )
    for dataset_card in dataset_cards:
        if dataset_card.config.get("mode") != "all_cases":
            continue
        for downstream in _downstream_cards(db, dataset_card):
            try:
                _cascade_run(db, downstream, {dataset_card.id})
            except HTTPException:
                pass
