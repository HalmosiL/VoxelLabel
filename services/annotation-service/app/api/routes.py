"""HTTP API for creating, listing and reviewing annotations."""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import Annotation, AnnotationReview, AnnotationStatus, AnnotationType

from app.validation import PayloadValidationError, validate_payload

router = APIRouter(prefix="/annotations", tags=["annotations"])

_READ_ROLES = ["viewer", "annotator", "reviewer", "admin"]


@router.post("/studies/{study_id}")
def create_annotation(
    study_id: str,
    target_type: str,
    target_id: uuid.UUID,
    type_name: str,
    payload: dict,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Create a new draft annotation. The payload is validated against the
    registered annotation type's JSON Schema before being stored."""
    require_study_role(db, study_id, user, allowed_roles=["annotator", "admin"])

    annotation_type = db.query(AnnotationType).filter_by(name=type_name).first()
    if annotation_type is None:
        raise HTTPException(status_code=404, detail=f"Unknown annotation type: {type_name}")

    try:
        validate_payload(payload, annotation_type.json_schema)
    except PayloadValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    annotation = Annotation(
        target_type=target_type,
        target_id=target_id,
        study_id=study_id,
        annotator_id=user.subject,
        type_id=annotation_type.id,
        payload=payload,
        status=AnnotationStatus.DRAFT,
    )
    db.add(annotation)
    db.commit()
    return {"id": str(annotation.id), "status": annotation.status.value}


@router.get("/studies/{study_id}")
def list_annotations_for_study(
    study_id: str,
    status: AnnotationStatus | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """List annotations in a study, optionally filtered by status --
    e.g. `?status=submitted` for a reviewer's queue."""
    require_study_role(db, study_id, user, allowed_roles=_READ_ROLES)

    query = db.query(Annotation).filter_by(study_id=study_id)
    if status is not None:
        query = query.filter_by(status=status)

    return [
        {
            "id": str(a.id),
            "target_type": a.target_type,
            "target_id": str(a.target_id),
            "type_id": str(a.type_id),
            "payload": a.payload,
            "status": a.status.value,
            "annotator_id": a.annotator_id,
        }
        for a in query.all()
    ]


@router.get("/{target_type}/{target_id}")
def list_annotations_for_target(
    target_type: str,
    target_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """List annotations for a given target (all versions; callers filter
    by status/parent_version_id as needed)."""
    annotations = db.query(Annotation).filter_by(target_type=target_type, target_id=target_id).all()
    if annotations:
        require_study_role(db, str(annotations[0].study_id), user, allowed_roles=_READ_ROLES)

    return [
        {"id": str(a.id), "type_id": str(a.type_id), "payload": a.payload, "status": a.status.value}
        for a in annotations
    ]


@router.post("/{annotation_id}/review")
def review_annotation(
    annotation_id: uuid.UUID,
    decision: str,
    comment: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Approve or reject a submitted annotation."""
    annotation = db.get(Annotation, annotation_id)
    if annotation is None:
        raise HTTPException(status_code=404, detail="Annotation not found")

    require_study_role(db, str(annotation.study_id), user, allowed_roles=["reviewer", "admin"])

    annotation.status = AnnotationStatus.APPROVED if decision == "approve" else AnnotationStatus.REJECTED
    db.add(AnnotationReview(annotation_id=annotation.id, reviewer_id=user.subject, decision=decision, comment=comment))
    db.commit()
    return {"id": str(annotation.id), "status": annotation.status.value}
