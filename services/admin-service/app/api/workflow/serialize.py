"""Card/edge -> API response shape."""
from shared_models.models import WorkflowCard, WorkflowCardType, WorkflowEdge
from sqlalchemy.orm import Session

from .graph import _dataset_output_ids, _is_stale, _llm_connected_summary, _materialized_children, _output_count
from .status import _annotation_progress, compute_job_status


def _serialize_card(db: Session, card: WorkflowCard, cards_by_id: dict, edges_by_target: dict) -> dict:
    output_case_ids = card.output_case_ids
    if card.type == WorkflowCardType.DATASET:
        output_case_ids = _dataset_output_ids(db, card)

    stale = any(
        _is_stale(card.last_run_at, cards_by_id[edge.source_card_id].last_run_at)
        for edge in edges_by_target.get(card.id, [])
        if edge.source_card_id in cards_by_id
    )

    # `config["status"]` for an Annotation/Review card is a derived
    # value (see compute_job_status), not something stored durably --
    # overridden here so the board (this response), My Jobs, and
    # ct-annotator's surface-config never disagree with each other.
    config = card.config
    if card.type in (WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW):
        config = {**card.config, "status": compute_job_status(db, card)}

    result = {
        "id": str(card.id),
        "type": card.type.value,
        "title": card.title,
        "position_x": card.position_x,
        "position_y": card.position_y,
        "width": card.width,
        "height": card.height,
        "config": config,
        "output_case_ids": output_case_ids,
        "output_count": _output_count(card, output_case_ids),
        "last_run_at": card.last_run_at.isoformat() if card.last_run_at else None,
        "stale": stale,
    }
    if card.type in (WorkflowCardType.ANNOTATION, WorkflowCardType.REVIEW) and output_case_ids:
        is_review = card.type == WorkflowCardType.REVIEW
        result["annotation_progress"] = _annotation_progress(
            db, output_case_ids, review=is_review, since=None if is_review else card.created_at
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
        # study instead), so it gets no such count. Inputs whose source
        # hasn't been Run yet are named instead of counted.
        result["llm_connected_case_count"], result["llm_unrun_sources"] = _llm_connected_summary(db, card)

    if card.type == WorkflowCardType.DATASET and card.materialized_source_card_id:
        source = cards_by_id.get(card.materialized_source_card_id) or db.get(
            WorkflowCard, card.materialized_source_card_id
        )
        result["materialized_from"] = {"card_id": str(source.id), "title": source.title} if source else None

    return result


def _serialize_edge(edge: WorkflowEdge) -> dict:
    return {
        "id": str(edge.id),
        "source_card_id": str(edge.source_card_id),
        "source_handle": edge.source_handle,
        "target_card_id": str(edge.target_card_id),
        "target_handle": edge.target_handle,
    }
