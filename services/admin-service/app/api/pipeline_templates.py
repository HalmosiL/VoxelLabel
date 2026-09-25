"""HTTP API for the workflow board's Store: reusable, ready-made
pipelines (a small set of cards + the edges between them) that can be
inserted onto any Study's board at once. Global, not scoped to a
Study -- see shared_models.PipelineTemplate's own docstring for why.

Any authenticated user can list and create a template (saving a useful
pipeline you built is meant to be as easy as building it -- no special
role gate, the same as e.g. adding a tag to a clinical data item);
deleting one is restricted to its own author or a global admin, so one
user can't remove another's contribution to the shared library.

Because every user can read the Store, a template holds a pipeline's
structure only. Card config keys that belong to one study -- pinned case
ids, the assignee, an AI card's chat transcript, the derived job status
-- are dropped on save, and dropped again when a template is served, so
templates saved before this rule never hand them out either (C-12).
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from shared_auth import CurrentUser, get_current_user, require_any_study_role
from shared_models.database import get_db
from shared_models.models import PipelineTemplate, WorkflowCardType
from sqlalchemy.orm import Session

from app.api import audit

router = APIRouter(prefix="/admin/pipeline-templates", tags=["admin:pipeline-templates"])


class PipelineTemplateCardIn(BaseModel):
    key: str
    type: str
    title: str
    x: float
    y: float
    width: float
    height: float
    config: dict = Field(default_factory=dict)


class PipelineTemplateEdgeIn(BaseModel):
    source_key: str
    source_handle: str
    target_key: str
    target_handle: str


class PipelineTemplateIn(BaseModel):
    title: str
    description: str = ""
    cards: list[PipelineTemplateCardIn]
    edges: list[PipelineTemplateEdgeIn]


# Card config keys that only mean something on the study they came from.
STUDY_SPECIFIC_CONFIG_KEYS = frozenset({"case_ids", "assigned_user_id", "messages", "status"})


def _structure_only(cards: list[dict]) -> list[dict]:
    """The template's cards with every study-specific config key removed."""
    return [
        {**card, "config": {k: v for k, v in (card.get("config") or {}).items() if k not in STUDY_SPECIFIC_CONFIG_KEYS}}
        for card in cards
    ]


def _serialize(template: PipelineTemplate) -> dict:
    return {
        "id": str(template.id),
        "title": template.title,
        "description": template.description,
        "cards": _structure_only(template.cards),
        "edges": template.edges,
        "created_by": template.created_by,
        "created_at": template.created_at.isoformat(),
    }


_SOURCE_HANDLES = {"output", "surface_config"}
_TARGET_HANDLES = {"input", "surface_config"}


def _check_insertable(body: PipelineTemplateIn) -> None:
    """422 for a template that could never be inserted: an unknown or
    retired card type, two cards with one key, an edge to a card the
    template doesn't have, or an unknown handle. Such a template used to
    be published to everyone's Store and left half a pipeline on the
    board of whoever inserted it (C-14). The board still checks each
    connection when it is inserted."""
    valid_types = {t.value for t in WorkflowCardType} - {WorkflowCardType.SURFACE.value}
    keys = [c.key for c in body.cards]
    if len(set(keys)) != len(keys):
        raise HTTPException(status_code=422, detail="Two cards of the template have the same key")
    for card in body.cards:
        if card.type not in valid_types:
            raise HTTPException(status_code=422, detail=f"'{card.type}' is not a card type")
    for edge in body.edges:
        if edge.source_key not in keys or edge.target_key not in keys:
            raise HTTPException(status_code=422, detail="An edge of the template points at a card it doesn't have")
        if edge.source_handle not in _SOURCE_HANDLES or edge.target_handle not in _TARGET_HANDLES:
            raise HTTPException(status_code=422, detail="An edge of the template uses a connection point cards don't have")


# The Store is for those who build boards somewhere; before, any logged-in
# account could read and add templates (A-09).
_BOARD_EDITORS = ["data_manager", "admin"]


@router.get("")
def list_pipeline_templates(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    require_any_study_role(db, user, _BOARD_EDITORS)
    templates = db.query(PipelineTemplate).order_by(PipelineTemplate.created_at).all()
    return [_serialize(t) for t in templates]


@router.post("", status_code=201)
def create_pipeline_template(
    body: PipelineTemplateIn,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    require_any_study_role(db, user, _BOARD_EDITORS)
    if not body.cards:
        raise HTTPException(status_code=422, detail="A template needs at least one card")
    _check_insertable(body)

    template = PipelineTemplate(
        title=body.title,
        description=body.description,
        cards=_structure_only([c.model_dump() for c in body.cards]),
        edges=[e.model_dump() for e in body.edges],
        created_by=user.subject,
    )
    db.add(template)
    audit.record(db, user, "template.create", "pipeline_template", template.id, {"title": template.title})
    db.commit()
    return _serialize(template)


@router.delete("/{template_id}", status_code=204)
def delete_pipeline_template(
    template_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> None:
    template = db.get(PipelineTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Pipeline template not found")
    if template.created_by != user.subject and "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Only the template's own author or an admin can delete it")
    db.delete(template)
    audit.record(db, user, "template.delete", "pipeline_template", template.id, {"title": template.title})
    db.commit()
