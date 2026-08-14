"""HTTP API for registering annotation types.

This is what makes the annotation schema polymorphic in practice: a new
annotation type (e.g. "bbox", "segmentation_mask") is added by registering
it here with a JSON Schema, not by changing annotation-service code. See
ARCHITECTURE.md, "Annotation schema: polymorphic by design".
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import AnnotationType

router = APIRouter(prefix="/admin/annotation-types", tags=["admin:annotation-types"])


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


@router.post("")
def create_annotation_type(
    name: str,
    json_schema: dict,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)

    existing = db.query(AnnotationType).filter_by(name=name).first()
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"Annotation type '{name}' already exists")

    annotation_type = AnnotationType(name=name, json_schema=json_schema)
    db.add(annotation_type)
    db.commit()
    return {"id": str(annotation_type.id), "name": annotation_type.name}


@router.get("")
def list_annotation_types(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    types = db.query(AnnotationType).all()
    return [{"id": str(t.id), "name": t.name, "json_schema": t.json_schema} for t in types]
