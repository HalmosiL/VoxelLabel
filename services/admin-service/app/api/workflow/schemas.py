"""Request bodies for the workflow endpoints (see routes.py)."""
import math
import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator
from shared_models.models import WorkflowCardType


def _finite_json(value, path="config"):
    """Raises ValueError for a NaN/Infinity anywhere in a config: Postgres
    JSON can't hold one, so it used to make every later autosave of the
    study fail, silently (C-07)."""
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{path} contains a number that isn't finite")
    if isinstance(value, dict):
        for key, item in value.items():
            _finite_json(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _finite_json(item, f"{path}[{index}]")
    return value


class WorkflowCardIn(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
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

    _config_finite = field_validator("config")(classmethod(lambda cls, v: _finite_json(v)))


class WorkflowCardPatch(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    title: str | None = None
    position_x: float | None = None
    position_y: float | None = None
    width: float | None = None
    height: float | None = None
    config: dict | None = None  # replaces the whole config blob when provided

    _config_finite = field_validator("config")(classmethod(lambda cls, v: _finite_json(v) if v is not None else v))


class WorkflowEdgeIn(BaseModel):
    id: uuid.UUID | None = None  # same reasoning as WorkflowCardIn.id
    source_card_id: uuid.UUID
    source_handle: str = "output"
    target_card_id: uuid.UUID
    target_handle: str = "input"


class LlmChatIn(BaseModel):
    message: str
