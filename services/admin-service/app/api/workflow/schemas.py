"""Request bodies for the workflow endpoints (see routes.py)."""
import uuid

from pydantic import BaseModel, Field

from shared_models.models import WorkflowCardType


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
