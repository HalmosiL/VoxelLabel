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
from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import PipelineTemplate
from sqlalchemy.orm import Session

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


@router.get("")
def list_pipeline_templates(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    templates = db.query(PipelineTemplate).order_by(PipelineTemplate.created_at).all()
    return [_serialize(t) for t in templates]


@router.post("", status_code=201)
def create_pipeline_template(
    body: PipelineTemplateIn,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    if not body.cards:
        raise HTTPException(status_code=422, detail="A template needs at least one card")

    template = PipelineTemplate(
        title=body.title,
        description=body.description,
        cards=_structure_only([c.model_dump() for c in body.cards]),
        edges=[e.model_dump() for e in body.edges],
        created_by=user.subject,
    )
    db.add(template)
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
    db.commit()
