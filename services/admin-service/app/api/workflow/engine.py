"""The Run engine: what "Run" computes for each card type, how a Run
ripples downstream (and settles a feedback loop), and the automatic
ripple a newly created case triggers. Split into one small handler per
card type (dispatched through _RUNNERS) instead of one long if/elif
chain, so adding a type means adding a function, not editing a 200-line
branch. Everything that *reads* the graph lives in graph.py; this module
is the only place cards' output_case_ids / materialized children are
written."""
import asyncio
import hashlib
import logging
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from shared_models.models import AnnotationStatus, Case, WorkflowCard, WorkflowCardType, WorkflowEdge, case_tags
from sqlalchemy.orm import Session

from app.llm_client import run_llm_turn

from .constants import _MATERIALIZED_DEFAULT_HEIGHT, _MATERIALIZED_DEFAULT_WIDTH, _NO_RUN_TYPES
from .graph import (
    _card_is_stale,
    _card_or_404,
    _downstream_cards,
    _incoming_case_ids,
    _materialized_children,
    _resolve_output,
    _single_incoming_edge,
)
from .status import _annotated_case_ids, _case_ids_with_status

logger = logging.getLogger(__name__)


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
    # Part sizes by largest remainder (Hamilton's method) rather than
    # rounding each cumulative boundary: `round()` is banker's rounding,
    # so e.g. 2 cases at 50/50 came out 2/0 and small cohorts in general
    # looked off. Sizes sum to `total` exactly, so no case is ever
    # dropped or duplicated.
    ratios = [cumulative_ratios[0]] + [b - a for a, b in zip(cumulative_ratios, cumulative_ratios[1:])]
    exact = [r * total for r in ratios]
    sizes = [int(x) for x in exact]
    for index in sorted(range(len(sizes)), key=lambda i: exact[i] - sizes[i], reverse=True)[: total - sum(sizes)]:
        sizes[index] += 1
    boundaries = []
    running = 0
    for size in sizes:
        running += size
        boundaries.append(running)
    buckets: list[list[str]] = []
    start = 0
    for boundary in boundaries:
        buckets.append(ordered[start:boundary])
        start = boundary
    return buckets


def _matches_filter(tags: list[str], config: dict) -> bool:
    """Only one criterion type exists today ("tag") -- this shape is
    discriminated by `criterion_type` so a second one is additive later,
    not a breaking change to already-saved cards."""
    if config.get("criterion_type") == "tag":
        return config.get("tag") in tags
    return False


def _upsert_materialized_dataset(
    db: Session,
    parent: WorkflowCard,
    existing: WorkflowCard | None,
    *,
    handle: str,
    title: str,
    case_ids: list[str],
    now: datetime,
    index: int = 0,
) -> None:
    """Creates (or refreshes) the Dataset card a Split/Annotation/Review
    Run materializes for one named output -- a plain "manual" Dataset
    pinned to `case_ids`, placed to the right of its parent (stacked by
    `index`). An `existing` child is updated in place rather than
    replaced, so edges drawn from it survive re-Runs. A part removed
    since the last Run leaves its old child in place, un-updated, rather
    than deleting it -- board scratch space isn't garbage-collected (same
    policy as delete_workflow_card having no "still has data" guard).
    Stamped with the parent's own `now` so anything downstream of the
    child is correctly flagged stale (see _is_stale)."""
    if existing is None:
        db.add(
            WorkflowCard(
                study_id=parent.study_id,
                type=WorkflowCardType.DATASET,
                title=title,
                position_x=parent.position_x + 260,
                position_y=parent.position_y + index * 140,
                width=_MATERIALIZED_DEFAULT_WIDTH,
                height=_MATERIALIZED_DEFAULT_HEIGHT,
                config={"mode": "manual", "case_ids": case_ids},
                materialized_source_card_id=parent.id,
                materialized_source_handle=handle,
                last_run_at=now,
            )
        )
        return
    existing.title = title
    existing.config = {**existing.config, "mode": "manual", "case_ids": case_ids}
    existing.last_run_at = now


def _union_of_incoming(db: Session, card: WorkflowCard, *, target_handle: str | None, error: str) -> list[str]:
    """Union/Annotation's Run input: every upstream case, deduped; a card
    with nothing wired in is a 422 with `error`, not an empty result."""
    if not db.query(WorkflowEdge).filter_by(target_card_id=card.id).count():
        raise HTTPException(status_code=422, detail=error)
    return _incoming_case_ids(db, card, target_handle)


def _run_dataset(db: Session, card: WorkflowCard, now: datetime) -> None:
    # A user-placed, general version of Split/Annotation/Review's
    # automatic "materialize": connect anything into a Dataset card and
    # Run snapshots that upstream result as this card's own manual case
    # list.
    edge = _single_incoming_edge(db, card)
    source = _card_or_404(db, edge.source_card_id)
    case_ids = sorted(_resolve_output(db, source, set()))
    card.config = {**card.config, "mode": "manual", "case_ids": case_ids}


def _run_split(db: Session, card: WorkflowCard, now: datetime) -> None:
    edge = _single_incoming_edge(db, card)
    source = _card_or_404(db, edge.source_card_id)
    input_ids = _resolve_output(db, source, set())

    parts = _split_parts(card.config)
    seed = card.config.get("seed") or uuid.uuid4().hex
    buckets = _split_case_ids(input_ids, seed, _cumulative_ratios(parts))

    existing_children = {c.materialized_source_handle: c for c in _materialized_children(db, card.id)}
    output: dict[str, list[str]] = {}
    for index, part in enumerate(parts):
        handle = f"part_{index}"
        case_ids = sorted(buckets[index])
        output[handle] = case_ids
        _upsert_materialized_dataset(
            db,
            card,
            existing_children.get(handle),
            handle=handle,
            title=str(part.get("name") or f"Part {index + 1}"),
            case_ids=case_ids,
            now=now,
            index=index,
        )

    card.config = {**card.config, "seed": seed}
    card.output_case_ids = output


def _run_filter(db: Session, card: WorkflowCard, now: datetime) -> None:
    edge = _single_incoming_edge(db, card)
    source = _card_or_404(db, edge.source_card_id)
    input_ids = _resolve_output(db, source, set())

    cases = db.query(Case).filter(Case.id.in_(input_ids)).all()
    card.output_case_ids = sorted(str(c.id) for c in cases if _matches_filter(case_tags(c), card.config))


def _run_union(db: Session, card: WorkflowCard, now: datetime) -> None:
    card.output_case_ids = _union_of_incoming(
        db, card, target_handle=None, error="Union requires at least one incoming connection"
    )


def _run_annotation(db: Session, card: WorkflowCard, now: datetime) -> None:
    # Union of every incoming source's cases (not "exactly one" like
    # Filter/Dataset/Review) -- this is what lets a Review card's
    # "(rejected)" materialized branch feed back into an Annotation card
    # as a second input alongside its original source, forming a real
    # feedback loop: Annotation -> Review -> back into Annotation. Safe
    # against cycles because Run only ever reads each upstream card's
    # already-computed, stored output_case_ids (or a manual Dataset's
    # static case_ids) -- never a live recursive walk.
    card.output_case_ids = _union_of_incoming(
        db, card, target_handle="input", error="Annotation requires at least one incoming connection"
    )

    if card.config.get("materialize_dataset"):
        # Only the subset with a real, submitted-or-approved Annotation
        # record -- not every case the card happens to be assigned, which
        # would include ones no one has actually annotated yet. `since`
        # keeps a brand-new card from taking credit for older work on the
        # same cases (see _latest_annotation_per_case).
        case_ids = _annotated_case_ids(db, card.output_case_ids, review=False, since=card.created_at)
        children = _materialized_children(db, card.id)
        _upsert_materialized_dataset(
            db,
            card,
            children[0] if children else None,
            handle="output",
            title=f"{card.title} (annotated)",
            case_ids=case_ids,
            now=now,
        )


def _run_review(db: Session, card: WorkflowCard, now: datetime) -> None:
    # Pure pass-through of the resolved input -- the "work" this Run does
    # is refreshing which cases are in scope after an upstream change.
    # The actual assignment (assignee/status) lives in `config`, edited
    # via PATCH, not Run.
    edge = _single_incoming_edge(db, card)
    source = _card_or_404(db, edge.source_card_id)
    card.output_case_ids = _resolve_output(db, source, set())

    # Unlike Annotation's "(annotated)" child (opt-in via
    # materialize_dataset), Review always materializes both branches on
    # every Run: "(approved)" for cases that passed review, "(rejected)"
    # for cases that need rework -- a feedback edge from "(rejected)"
    # back into an Annotation card's input is exactly how that rework
    # gets requeued. No `since` cutoff here: a decision made on a case
    # is a decision made, regardless of when this Review card was wired
    # in (see _cases_with_annotated_status).
    existing_children = {c.materialized_source_handle: c for c in _materialized_children(db, card.id)}
    branches = {
        "approved": _case_ids_with_status(db, card.output_case_ids, [AnnotationStatus.APPROVED]),
        "rejected": _case_ids_with_status(db, card.output_case_ids, [AnnotationStatus.REJECTED]),
    }
    for index, (handle, case_ids) in enumerate(branches.items()):
        _upsert_materialized_dataset(
            db,
            card,
            existing_children.get(handle),
            handle=handle,
            title=f"{card.title} ({handle})",
            case_ids=case_ids,
            now=now,
            index=index,
        )


def _run_criterion(db: Session, card: WorkflowCard, now: datetime) -> None:
    # "Run" here is a convenience shortcut for the same thing typing a
    # message into this card's own chat session would do -- a fixed
    # canned instruction through the exact same model + MCP tool loop
    # (see llm_client.run_llm_turn), appended to the card's own
    # transcript. Unlike every other handler this genuinely calls out to
    # a local model, so failures (Ollama/mcp-server down) come back as a
    # normal assistant message rather than an exception -- run_llm_turn
    # handles that itself. asyncio.run() is safe because the Run endpoint
    # is a sync `def`, executed by FastAPI in a worker thread with no
    # event loop of its own.
    history = list(card.config.get("messages", []))
    new_messages, _ = asyncio.run(
        run_llm_turn(card, history, "Look at every case connected to your input, and evaluate this criterion now.")
    )
    card.config = {**card.config, "messages": history + new_messages}


_RUNNERS = {
    WorkflowCardType.DATASET: _run_dataset,
    WorkflowCardType.SPLIT: _run_split,
    WorkflowCardType.FILTER: _run_filter,
    WorkflowCardType.UNION: _run_union,
    WorkflowCardType.ANNOTATION: _run_annotation,
    WorkflowCardType.REVIEW: _run_review,
    WorkflowCardType.CRITERION: _run_criterion,
}


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

    runner = _RUNNERS.get(card.type)
    if runner is not None:
        runner(db, card, now)

    card.last_run_at = now
    db.commit()


def run_card_with_ripple(db: Session, card: WorkflowCard) -> None:
    """Runs `card`, then ripples the refresh downstream: whatever's wired
    off this card (or off its materialized "(annotated)"/Split-part
    Dataset child -- that's typically where a user actually draws the
    next edge from) gets re-Run too, so e.g. marking a case Annotated is
    immediately visible at a downstream Review card without someone
    separately clicking Run on it. Best-effort per branch: a downstream
    card that can't run for its own reasons (a genuinely broken edge,
    say) doesn't take down the Run the caller actually asked for.

    A feedback-loop board (Review's rejected branch back into Annotation)
    means that cascade can change something `card` itself reads from --
    e.g. Running Review after a fresh reject ripples into Annotation,
    which then excludes that case from its materialized "(annotated)"
    child, which is exactly what Review's own scope was just computed
    from. Left alone, `card` would come back already one step stale
    again, with nothing prompting a second Run. So it's settled here: a
    real board only has a card or two in any one feedback loop, so this
    converges within a couple of extra passes; the cap just guarantees
    termination."""
    _run_one_card(db, card)
    _ripple(db, card)
    for _ in range(3):
        if not _card_is_stale(db, card):
            break
        _run_one_card(db, card)
        _ripple(db, card)


def _ripple(db: Session, card: WorkflowCard) -> None:
    for downstream in _downstream_cards(db, card):
        try:
            _cascade_run(db, downstream, {card.id})
        except HTTPException as exc:
            logger.warning("Downstream card %s could not be re-run after %s: %s", downstream.id, card.id, exc.detail)


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
        except HTTPException as exc:
            logger.warning("Downstream card %s could not be re-run: %s", downstream.id, exc.detail)


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
