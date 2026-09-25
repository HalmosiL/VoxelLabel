"""HTTP API for registering annotation types.

This is what makes the annotation schema polymorphic in practice: a new
annotation type (e.g. "bbox", "segmentation_mask") is added by registering
it here with a JSON Schema, not by changing annotation-service code. See
ARCHITECTURE.md, "Annotation schema: polymorphic by design".
"""
from fastapi import APIRouter, Depends, HTTPException
from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import AnnotationType
from sqlalchemy.orm import Session

from app.api import audit

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
    audit.record(db, user, "annotation_type.create", "annotation_type", name, {"name": name})
    db.commit()
    return {"id": str(annotation_type.id), "name": annotation_type.name}


@router.put("/{name}/schema")
def update_annotation_type_schema(
    name: str,
    json_schema: dict,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Replaces a registered type's JSON Schema in place and bumps its
    schema_version -- how a type grows a field (ct-annotator's
    segmentation_volume gained per-object `attributes` and per-label
    `fields` this way) without re-registering under a new name.
    Existing annotations are untouched: the schema only gates new
    writes, so widen, don't narrow, or older payloads would fail to
    re-save."""
    _require_global_admin(user)
    annotation_type = db.query(AnnotationType).filter_by(name=name).first()
    if annotation_type is None:
        raise HTTPException(status_code=404, detail=f"Annotation type '{name}' not found")
    if annotation_type.json_schema == json_schema:
        return {"id": str(annotation_type.id), "name": annotation_type.name, "schema_version": annotation_type.schema_version, "changed": False}
    annotation_type.json_schema = json_schema
    annotation_type.schema_version = (annotation_type.schema_version or 1) + 1
    audit.record(db, user, "annotation_type.update_schema", "annotation_type", name, {"name": name})
    db.commit()
    return {"id": str(annotation_type.id), "name": annotation_type.name, "schema_version": annotation_type.schema_version, "changed": True}


@router.get("")
def list_annotation_types(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    types = db.query(AnnotationType).all()
    return [{"id": str(t.id), "name": t.name, "json_schema": t.json_schema} for t in types]
