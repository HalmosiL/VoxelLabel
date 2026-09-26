"""Board-graph lookups and traversal: fetching cards, resolving a card's
output case list through its upstream edges, staleness, and the derived
"materialized children" relationship. Pure queries -- nothing here
mutates a card."""
import uuid

from fastapi import HTTPException
from shared_auth import CurrentUser, require_study_role
from shared_models.models import Case, WorkflowCard, WorkflowCardType, WorkflowEdge
from sqlalchemy.orm import Session


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


def is_all_cases_dataset(card: WorkflowCard) -> bool:
    """A Dataset is "all cases" unless its mode says manual -- a card made
    with no mode (API, tool) counts every case, so it has to pass new ones
    on like an explicit "all_cases" does (C-18)."""
    return card.type == WorkflowCardType.DATASET and (card.config or {}).get("mode") != "manual"


def _dataset_output_ids(db: Session, card: WorkflowCard) -> list[str]:
    if not is_all_cases_dataset(card):
        # Only this study's cases, whatever a stored config says (the write
        # routes refuse foreign ids; this also covers rows written before).
        wanted = []
        for raw in card.config.get("case_ids", []):
            try:
                wanted.append(uuid.UUID(str(raw)))
            except ValueError:
                continue
        if not wanted:
            return []
        own = {row.id for row in db.query(Case.id).filter(Case.id.in_(wanted), Case.study_id == card.study_id).all()}
        return [str(cid) for cid in wanted if cid in own]
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


def _dedupe_sorted(ids) -> list[str]:
    return sorted(dict.fromkeys(ids))


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


def card_is_stale(db: Session, card: WorkflowCard, incoming: list[tuple[WorkflowEdge, WorkflowCard]]) -> bool:
    """Whether Run would change this card: the board's "needs re-run".

    A job card (Annotation/Review) holds a case list read from its inputs,
    so it is stale exactly when the cases it would read now differ from the
    ones it holds. By run times alone, a Review fed straight from its
    Annotation, with "(rejected)" fed back into it, was stale right after
    every Run: its Run re-runs the Annotation after it (UX-ux-admin-10/21).
    Other cards keep the run-time rule: an input that ran after them.
    A Surface card's "surface_config" connection is configuration, never
    input. `incoming` is the card's (edge, source card) pairs."""
    data_in = [(edge, source) for edge, source in incoming if edge.target_handle != "surface_config"]
    if card.type in (WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW):
        inputs = [source for edge, source in data_in if edge.target_handle == "input"]
        if not inputs:
            return False
        wanted: set[str] = set()
        try:
            for source in inputs:
                wanted.update(_resolve_output(db, source, set()))
        except HTTPException:
            return False  # an input that never ran: Run can't help yet
        return card.output_case_ids is None or wanted != set(card.output_case_ids)
    return any(_is_stale(card.last_run_at, source.last_run_at) for _, source in data_in)


def _card_is_stale(db: Session, card: WorkflowCard) -> bool:
    """card_is_stale for one card in isolation -- lets `run_workflow_card`
    notice when its own downstream cascade has looped back and changed
    something this card reads from (see `_cascade_run`'s docstring: its
    cycle protection deliberately doesn't re-run a card twice within one
    cascade, so the card that was actually asked to run can come out of
    that cascade already stale again)."""
    incoming = []
    for edge in db.query(WorkflowEdge).filter_by(target_card_id=card.id).all():
        source = db.get(WorkflowCard, edge.source_card_id)
        if source is not None:
            incoming.append((edge, source))
    return card_is_stale(db, card, incoming)


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


def _incoming_case_ids(db: Session, card: WorkflowCard, target_handle: str | None) -> list[str]:
    """Union of every case reachable through `card`'s incoming edges,
    deduped and sorted -- the shared shape behind Union/Annotation's Run
    and the LLM/Criterion "N cases connected" summary. `target_handle`
    narrows to one handle ("input") so a Surface card's separate
    "surface_config" edge never counts; None takes every incoming edge."""
    query = db.query(WorkflowEdge).filter_by(target_card_id=card.id)
    if target_handle is not None:
        query = query.filter_by(target_handle=target_handle)
    all_ids: list[str] = []
    for edge in query.all():
        source = _card_or_404(db, edge.source_card_id)
        all_ids.extend(_resolve_output(db, source, set()))
    return _dedupe_sorted(all_ids)


def _llm_connected_case_ids(db: Session, card: WorkflowCard) -> list[str]:
    """Every case reachable from an LLM or Criterion card's real "input"
    edges -- "which databases are connected via MCP" for the Clinical
    Trial Assistant, or "which cases this criterion judges" for a
    Criterion sub-agent. Resolved on demand (neither type is ever Run --
    see _NO_RUN_TYPES -- so there's no cached `output_case_ids`)."""
    return _incoming_case_ids(db, card, target_handle="input")


def _llm_connected_summary(db: Session, card: WorkflowCard) -> tuple[int, list[str]]:
    """The board's "N cases connected" line for an LLM/Criterion card:
    (cases reachable through the inputs that can be resolved, titles of
    the inputs that can't yet -- a source card never Run). Unlike
    _llm_connected_case_ids this never raises: one unrun source used to
    make the whole board fail to load (C-01)."""
    ids: list[str] = []
    unrun: list[str] = []
    for edge in db.query(WorkflowEdge).filter_by(target_card_id=card.id, target_handle="input").all():
        source = _card_or_404(db, edge.source_card_id)
        try:
            ids.extend(_resolve_output(db, source, set()))
        except HTTPException:
            unrun.append(source.title)
    return len(_dedupe_sorted(ids)), sorted(unrun)
