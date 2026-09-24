"""HTTP endpoints for a Study's workflow board. Thin: request parsing,
role checks, and delegation to graph.py / status.py / engine.py /
serialize.py -- see the package docstring for the board's design.

Unlike the rest of this service's write endpoints (flat scalar query
params), the endpoints here take structured JSON bodies via Pydantic
models -- a deliberate, justified deviation given how structured a
card's settings/connection actually are.

Every card interaction (move, connect, delete) is its own granular
request the moment it happens on the board -- there is no "save the
whole board" endpoint. This is deliberate: a debounced whole-board
replace would race against run_workflow_card (a Run landing between an
autosave's snapshot-read and its delayed write would silently clobber
the just-computed output), so each mutation only ever touches its own
row.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import Case, Study, StudyMembership, StudyRole, WorkflowCard, WorkflowCardType, WorkflowEdge
from sqlalchemy.orm import Session

from app.api import audit
from app.api.studies import _require_global_admin
from app.llm_client import run_llm_turn
from app.versioning import autosave

from .constants import _NO_INPUT_TYPES, _NO_OUTPUT_TYPES, _READ_ROLES, _UNRESTRICTED_SURFACE_CONFIG, _WRITE_ROLES
from .engine import run_card_with_ripple
from .graph import _card_or_404, _dataset_output_ids, _has_study_role, _materialized_children
from .schemas import LlmChatIn, WorkflowCardIn, WorkflowCardPatch, WorkflowEdgeIn
from .serialize import _serialize_card, _serialize_edge
from .status import _annotation_progress, _cases_with_annotated_status, compute_job_status

router = APIRouter(prefix="/admin", tags=["admin:workflow"])


@router.get("/studies/{study_id}/workflow")
def get_workflow_board(
    study_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    require_study_role(db, str(study_id), user, allowed_roles=_READ_ROLES)

    # Ordered explicitly: without an ORDER BY Postgres returns rows in
    # whatever heap order the last UPDATEs left them in, so two reads of
    # an unchanged board could list its cards differently.
    cards = db.query(WorkflowCard).filter_by(study_id=study_id).order_by(WorkflowCard.created_at, WorkflowCard.id).all()
    edges = db.query(WorkflowEdge).filter_by(study_id=study_id).order_by(WorkflowEdge.id).all()

    cards_by_id = {c.id: c for c in cards}
    edges_by_target: dict[uuid.UUID, list[WorkflowEdge]] = {}
    for edge in edges:
        edges_by_target.setdefault(edge.target_card_id, []).append(edge)

    return {
        "cards": [_serialize_card(db, c, cards_by_id, edges_by_target) for c in cards],
        "edges": [_serialize_edge(e) for e in edges],
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

    _validate_assignee(db, WorkflowCard(study_id=study_id, type=body.type), body.config)
    _validate_case_ids(db, study_id, body.config)
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
    audit.record(db, user, "card.create", "workflow_card", card.id, {"study_id": str(study_id), "type": body.type.value, "title": body.title})
    db.commit()
    db.refresh(card)
    autosave(db, card.study_id, user.subject)
    return _serialize_card(db, card, {card.id: card}, {})


def _validate_case_ids(db: Session, study_id, config: dict) -> None:
    """A card's pinned case list (a manual Dataset, or anything else
    carrying `case_ids`) may only name cases of the board's own study --
    otherwise a data manager of one study could pull another study's
    cases, their annotation state and reviewer comments into their board
    (C-08). Garbage ids are refused too, instead of failing a later Run."""
    if "case_ids" not in config:
        return
    raw = config["case_ids"]
    if not isinstance(raw, list) or not all(isinstance(x, str) for x in raw):
        raise HTTPException(status_code=422, detail="case_ids must be a list of case ids")
    try:
        ids = {uuid.UUID(x) for x in raw}
    except ValueError:
        raise HTTPException(status_code=422, detail="case_ids must be a list of case ids") from None
    if not ids:
        return
    found = {row.id for row in db.query(Case.id).filter(Case.id.in_(ids), Case.study_id == study_id).all()}
    if len(found) != len(ids):
        raise HTTPException(status_code=422, detail=f"{len(ids) - len(found)} of the case ids are not cases of this study")


_ASSIGNABLE_ROLE = {
    WorkflowCardType.ANNOTATION: "annotator",
    WorkflowCardType.REVIEW: "reviewer",
}


def _validate_assignee(db: Session, card: WorkflowCard, config: dict) -> None:
    """An Annotation job can only be assigned to a study member who
    actually holds the `annotator` role there, and a Review job only to
    one holding `reviewer` -- not just any member. A member can hold
    several roles at once (see StudyMembership's own docstring), so
    someone who is both is assignable to either. Rejected here rather
    than silently allowed (admin-ui's picker only offers role-matching
    members, but the API is open): without this, a wrongly-assigned
    member would see the job in My Jobs and be able to open it, but get
    a confusing 403 the moment they tried to actually submit their
    annotation/review -- see annotation-service's create/review routes,
    which check the same study-scoped role, not this card's assignment."""
    assignee = config.get("assigned_user_id")
    required_role = _ASSIGNABLE_ROLE.get(card.type)
    if not assignee or required_role is None:
        return
    membership = db.query(StudyMembership).filter_by(study_id=card.study_id, user_id=assignee, role=StudyRole(required_role)).first()
    if membership is None:
        raise HTTPException(
            status_code=422,
            detail=f"The assignee must hold the '{required_role}' role in this study",
        )


@router.patch("/workflow-cards/{card_id}")
def update_workflow_card(
    card_id: uuid.UUID,
    body: WorkflowCardPatch,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    card = _card_or_404(db, card_id)
    # Board edits are write-role only. (An earlier version let an
    # assignee with just an annotator/reviewer role PATCH their own
    # card's `config.status` -- gone now that status is computed from
    # the cases' real annotation state on every read, see
    # compute_job_status; there's nothing left for them to set.)
    require_study_role(db, str(card.study_id), user, allowed_roles=_WRITE_ROLES)

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
        _validate_assignee(db, card, body.config)
        _validate_case_ids(db, card.study_id, body.config)
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

    changed = [k for k, v in body.model_dump().items() if v is not None and k not in ("position_x", "position_y", "width", "height")]
    if changed:  # a pure drag/resize is board noise, not an audited change
        audit.record(db, user, "card.update", "workflow_card", card.id, {"study_id": str(card.study_id), "fields": changed, "config_keys": sorted(body.config.keys()) if body.config else None})
    db.commit()
    db.refresh(card)
    autosave(db, card.study_id, user.subject)
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
    audit.record(db, user, "card.delete", "workflow_card", card.id, {"study_id": str(card.study_id), "type": card.type.value, "title": card.title})
    db.delete(card)
    db.commit()
    autosave(db, card.study_id, user.subject)


def _upstream_annotation_labels(db: Session, review_card: WorkflowCard) -> list[dict]:
    """The pre-defined labels (with their per-object forms) of the
    Annotation job a Review card reads its cases from: follow the
    review's "input" edge to its source -- the Annotation card itself,
    or the Dataset that card materialized ("<job> (annotated)") -- and
    read that Annotation card's own Surface. Empty when the chain isn't
    there (a review fed by a hand-picked dataset, no surface, ...)."""
    edge = db.query(WorkflowEdge).filter_by(target_card_id=review_card.id, target_handle="input").first()
    source = db.get(WorkflowCard, edge.source_card_id) if edge else None
    if source is not None and source.type == WorkflowCardType.DATASET and source.materialized_source_card_id:
        source = db.get(WorkflowCard, source.materialized_source_card_id)
    if source is None or source.type != WorkflowCardType.ANNOTATION:
        return []
    surface_edge = db.query(WorkflowEdge).filter_by(target_card_id=source.id, target_handle="surface_config").first()
    surface = db.get(WorkflowCard, surface_edge.source_card_id) if surface_edge else None
    return list(surface.config.get("labels", [])) if surface is not None else []


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

    Each label may carry `fields` -- the per-object form (check / choice
    / scale, e.g. Nodule -> Type: solid/sub-solid, Calcified,
    Confidence 1-5) an annotator fills for every instance next to its
    comment, and the reviewer sees on the review card. A Review job's
    labels are the upstream Annotation job's (see
    _upstream_annotation_labels), since a Review Surface has none.

    `card_type` (the underlying job's own type, "annotation" or
    "review") rides along in every response so ct-annotator can tell a
    Review job apart from an Annotation one and switch to its
    simplified, view-and-decide-only surface -- there's no other cheap
    way for it to learn this without a second round trip. `status`
    (todo/in_progress/done) rides along too, so ct-annotator can show it
    without a separate fetch -- computed fresh by compute_job_status
    from the cases' own annotation state, not something to set."""
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
        # A Review Surface holds no labels, but the reviewer still needs
        # the labels' per-object forms (Nodule -> Type, Calcified, ...)
        # to read and complete what the annotator filled: take them from
        # the Annotation job this review reads its cases from.
        if not config["labels"]:
            config["labels"] = _upstream_annotation_labels(db, card)

    return {**config, "card_type": card.type.value, "status": compute_job_status(db, card)}


@router.get("/jobs")
def list_all_jobs(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """Every Annotation/Review card on the whole platform, across every
    Study, with who it's assigned to -- the admin-only counterpart to
    My Jobs (which is scoped to the calling user). Global-admin only:
    unlike list_my_jobs, being the assignee isn't the access grant here,
    and no per-study role would legitimately cover every study at once
    the way this listing does.

    Progress reuses `_annotation_progress` (the same {annotated, total}
    counts the board's own card serialization shows) rather than the
    heavier `_cases_with_annotated_status` (per-case titles + reviewer
    comments) -- this listing is a scan-the-whole-platform overview, not
    a place to act on any one case, so the lighter query is what its job
    actually needs."""
    _require_global_admin(user)
    cards = (
        db.query(WorkflowCard)
        .filter(WorkflowCard.type.in_([WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW]))
        .order_by(WorkflowCard.created_at, WorkflowCard.id)
        .all()
    )
    studies_by_id = {s.id: s for s in db.query(Study).filter(Study.id.in_({c.study_id for c in cards})).all()}

    result = []
    for card in cards:
        study = studies_by_id.get(card.study_id)
        is_review = card.type == WorkflowCardType.REVIEW
        case_ids = card.output_case_ids or []
        progress = _annotation_progress(
            db, case_ids, review=is_review, since=None if is_review else card.created_at
        )
        result.append(
            {
                "study_id": str(card.study_id),
                "study_name": study.name if study else None,
                "card_id": str(card.id),
                "card_title": card.title,
                "card_type": card.type.value,
                "assigned_user_id": card.config.get("assigned_user_id"),
                "status": compute_job_status(db, card),
                "progress": progress,
            }
        )
    return result


@router.get("/my-jobs")
def list_my_jobs(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """Every Annotation/Review card assigned to the calling user, across
    every Study -- being the assignee is itself the access grant here,
    the same carve-out update_workflow_card's self-service status PATCH
    already relies on, so no separate per-study membership check."""
    my_cards = (
        db.query(WorkflowCard)
        .filter(WorkflowCard.type.in_([WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW]))
        # `config` is JSONB, so the assignee match runs in SQL instead of
        # loading every Annotation/Review card on the platform to filter
        # in Python -- the difference between O(my cards) and O(all cards).
        .filter(WorkflowCard.config["assigned_user_id"].astext == user.subject)
        # Stable, oldest-first order -- without it the My Jobs list could
        # reshuffle between two loads (no ORDER BY = heap order).
        .order_by(WorkflowCard.created_at, WorkflowCard.id)
        .all()
    )

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
                "status": compute_job_status(db, card),
                "cases": _cases_with_annotated_status(db, card),
            }
        )
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
        autosave(db, study_id, user.subject)
        return _serialize_edge(edge)

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
    autosave(db, study_id, user.subject)
    return _serialize_edge(edge)


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
    autosave(db, edge.study_id, user.subject)


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

    run_card_with_ripple(db, card)
    db.refresh(card)
    audit.record(db, user, "card.run", "workflow_card", card.id, {"study_id": str(card.study_id), "type": card.type.value, "title": card.title})
    db.commit()
    autosave(db, card.study_id, user.subject)
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
    autosave(db, card.study_id, user.subject)
    return {"board_changed": board_changed, **_serialize_card(db, card, {card.id: card}, {})}
