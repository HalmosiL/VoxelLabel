"""HTTP API for creating, listing and reviewing annotations."""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import Annotation, AnnotationReview, AnnotationStatus, AnnotationType
from sqlalchemy.orm import Session

from app.validation import PayloadValidationError, validate_payload

router = APIRouter(prefix="/annotations", tags=["annotations"])

_READ_ROLES = ["viewer", "annotator", "reviewer", "admin"]


def _has_study_role(db: Session, study_id: str, user: CurrentUser, allowed_roles: list[str]) -> bool:
    try:
        require_study_role(db, study_id, user, allowed_roles)
        return True
    except HTTPException:
        return False


_CREATABLE_STATUSES = {AnnotationStatus.DRAFT, AnnotationStatus.SUBMITTED}


@router.post("/studies/{study_id}")
def create_annotation(
    study_id: str,
    target_type: str,
    target_id: uuid.UUID,
    type_name: str,
    payload: dict,
    status: AnnotationStatus = AnnotationStatus.DRAFT,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Create a new annotation version, as draft (an in-progress save) or
    submitted (the annotator explicitly marking it done and ready for
    review -- ct-annotator's "Mark as annotated") -- never approved or
    rejected, which only the reviewer-only /review endpoint below can
    set. The payload is validated against the registered annotation
    type's JSON Schema before being stored."""
    # "reviewer" is allowed here too, not just "annotator": a review in
    # ct-annotator records the reviewer's per-object accept/reject marks
    # as a new annotation version *before* posting the approve/reject
    # decision on it (see its handleSubmitReview), so a reviewer-only
    # member could never actually finish a review -- their save was
    # refused with 403 one step before the decision. The decision itself
    # stays reviewer/admin-only (see review_annotation below).
    require_study_role(db, study_id, user, allowed_roles=["annotator", "reviewer", "admin"])

    if status not in _CREATABLE_STATUSES:
        raise HTTPException(status_code=422, detail=f"Cannot create an annotation with status '{status.value}'")

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
        status=status,
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
    by status/parent_version_id as needed). Ordered oldest-first by
    creation time so a caller that wants "the latest version" can just
    take the last element, rather than relying on whatever order the
    database happens to return an otherwise-unordered query in (not
    guaranteed to match insertion order, and in practice doesn't always)."""
    annotations = (
        db.query(Annotation).filter_by(target_type=target_type, target_id=target_id).order_by(Annotation.created_at).all()
    )
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
    if decision not in ("approve", "reject"):
        raise HTTPException(status_code=422, detail="decision must be 'approve' or 'reject'")
    if annotation.status in (AnnotationStatus.APPROVED, AnnotationStatus.REJECTED) and "admin" not in user.realm_roles:
        # A decision is a decision -- re-deciding an already approved/
        # rejected version is reserved for a global admin (an override),
        # so two reviewers can't silently flip each other's outcome.
        raise HTTPException(status_code=409, detail=f"This annotation was already {annotation.status.value}")
    annotation.status = AnnotationStatus.APPROVED if decision == "approve" else AnnotationStatus.REJECTED
    db.add(AnnotationReview(annotation_id=annotation.id, reviewer_id=user.subject, decision=decision, comment=comment))
    db.commit()
    return {"id": str(annotation.id), "status": annotation.status.value}


@router.delete("/{annotation_id}", status_code=204)
def delete_annotation(
    annotation_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Delete one annotation version outright -- used to undo a wrong or
    unwanted submission from the Study page's case list. A case with no
    remaining annotation reverts to "pending" (see admin-service's
    `_case_status`), which also clears a Review card's
    `pending_annotation_id` for it, so it stops showing as needing a
    decision. Only ever exposed for a case's single latest version, so
    in practice nothing else points at it as a `parent_version_id`; any
    `AnnotationReview` rows logged against it are removed first so the
    delete itself never fails on the foreign key."""
    annotation = db.get(Annotation, annotation_id)
    if annotation is None:
        raise HTTPException(status_code=404, detail="Annotation not found")

    require_study_role(db, str(annotation.study_id), user, allowed_roles=["annotator", "reviewer", "admin"])
    if annotation.annotator_id != user.subject and not _has_study_role(db, str(annotation.study_id), user, ["reviewer", "admin"]):
        # An annotator may only delete their *own* work; taking back
        # someone else's submission is a reviewer/admin action.
        raise HTTPException(status_code=403, detail="You can only delete your own annotations")

    if db.query(Annotation).filter_by(parent_version_id=annotation.id).first() is not None:
        raise HTTPException(status_code=409, detail="Cannot delete an annotation that has a newer version")

    db.query(AnnotationReview).filter_by(annotation_id=annotation.id).delete()
    db.delete(annotation)
    db.commit()
