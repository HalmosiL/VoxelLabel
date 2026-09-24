"""Keeps an LLM/Builder/Criterion card's tool calls inside its own study.

The MCP server's tools take whatever ids they are given (it trusts its
caller), and the arguments come straight from the model -- which a
user's prompt, or a sentence planted in a clinical document it reads,
can steer. So admin-service, the trust boundary, checks every call
before it reaches the MCP server (C-19):

- only the tools the card type offers may be called;
- any `study_id` argument is the chat card's own study, whatever the
  model wrote;
- every card, case and document id must belong to that study.

A refused call is answered with a tool error the model can read, so it
can recover instead of the chat failing.
"""
import uuid

from shared_models.models import Case, ClinicalDataItem, WorkflowCard
from sqlalchemy.orm import Session

CARD_ID_ARGS = ("card_id", "source_card_id", "target_card_id")
CASE_ID_ARGS = ("case_id",)
CASE_LIST_ARGS = ("case_ids", "included_case_ids")
DOCUMENT_ID_ARGS = ("document_id",)


class ToolCallRefused(Exception):
    """The call reaches outside the card's study or its tool set."""


def _uuid(value, what: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise ToolCallRefused(f"{what} is not a valid id") from None


def scope_tool_call(db: Session, study_id, allowed_tools: set[str], name: str, args: dict | None) -> dict:
    """The arguments to actually call `name` with, or ToolCallRefused."""
    if name not in allowed_tools:
        raise ToolCallRefused(f"The tool {name} is not available on this card")
    scoped = dict(args or {})
    if "study_id" in scoped:
        scoped["study_id"] = str(study_id)

    for key in CARD_ID_ARGS:
        if key in scoped and scoped[key] is not None:
            card = db.get(WorkflowCard, _uuid(scoped[key], key))
            if card is None or card.study_id != study_id:
                raise ToolCallRefused(f"{key} is not a card on this study's board")

    case_ids: list[uuid.UUID] = []
    for key in CASE_ID_ARGS:
        if key in scoped and scoped[key] is not None:
            case_ids.append(_uuid(scoped[key], key))
    for key in CASE_LIST_ARGS:
        if key in scoped and scoped[key] is not None:
            if not isinstance(scoped[key], list):
                raise ToolCallRefused(f"{key} must be a list of case ids")
            case_ids.extend(_uuid(v, key) for v in scoped[key])
    if case_ids:
        own = {row.id for row in db.query(Case.id).filter(Case.id.in_(case_ids), Case.study_id == study_id).all()}
        if own != set(case_ids):
            raise ToolCallRefused("Some of those cases are not in this study")

    for key in DOCUMENT_ID_ARGS:
        if key in scoped and scoped[key] is not None:
            item = db.get(ClinicalDataItem, _uuid(scoped[key], key))
            if item is None or item.case.study_id != study_id:
                raise ToolCallRefused("That document is not in this study")
    return scoped


class RefusedResult:
    """Stands in for an MCP CallToolResult when a call was refused, so the
    tool loop reports it to the model like any other tool error."""

    def __init__(self, message: str):
        self.is_error = True
        self.structured_content = None
        self.content = [type("Text", (), {"text": message})()]
