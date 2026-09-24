"""HTTP API for creating, listing and reviewing annotations."""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import Annotation, AnnotationReview, AnnotationStatus, AnnotationType, Instance, Series
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

# What an annotation can be attached to. The study a target belongs to is
# always read from the target itself (series -> imaging study -> case ->
# study), never taken from the caller: a role in one study must not let
# anyone write onto, or read, another study's images.
TARGET_TYPES = ("series", "instance")

# Payload fields that point at an object in the shared bucket, and the
# only place such an object may live: the viewer's own mask uploads. A
# key anywhere else (another study's DICOM, a document) would be served
# back to whoever can read this annotation.
STORAGE_KEY_FIELDS = ("mask_volume_key", "mask_storage_key", "object_storage_key", "storage_key", "mask_key")
MASK_KEY_PREFIX = "annotation-masks/"


def _study_of_target(db: Session, target_type: str, target_id: uuid.UUID) -> str:
    """The study that owns a target, or 404 when there is no such target."""
    if target_type not in TARGET_TYPES:
        raise HTTPException(status_code=422, detail=f"target_type must be one of: {', '.join(TARGET_TYPES)}")
    series = db.get(Series, target_id) if target_type == "series" else None
    if target_type == "instance":
        instance = db.get(Instance, target_id)
        series = instance.series if instance is not None else None
    if series is None:
        raise HTTPException(status_code=404, detail=f"No such {target_type}")
    return str(series.imaging_study.case.study_id)


def _lock_target(db: Session, target_type: str, target_id: uuid.UUID) -> None:
    """Serialises concurrent version-checked saves of one target."""
    series_id = target_id
    if target_type == "instance":
        series_id = db.get(Instance, target_id).series_id
    db.query(Series).filter(Series.id == series_id).with_for_update().one()


def _latest_version(db: Session, target_type: str, target_id: uuid.UUID, study_id: str, type_id) -> Annotation | None:
    return (
        db.query(Annotation)
        .filter_by(target_type=target_type, target_id=target_id, study_id=study_id, type_id=type_id)
        .order_by(Annotation.created_at.desc(), Annotation.id.desc())
        .first()
    )


def _handed_in(db: Session, annotation: Annotation) -> Annotation | None:
    """The handed-in (SUBMITTED) version `annotation` stands for: itself,
    or for a reviewer's draft the version it reviews -- None if it stands
    for no handed-in work (an annotator's plain draft, or a decision)."""
    if annotation.status == AnnotationStatus.SUBMITTED:
        return annotation
    if annotation.status == AnnotationStatus.DRAFT and annotation.review_of_id is not None:
        reviewed = db.get(Annotation, annotation.review_of_id)
        if reviewed is not None and reviewed.status == AnnotationStatus.SUBMITTED:
            return reviewed
    return None


def _not_reviewable(annotation: Annotation) -> HTTPException:
    """409 for a version that isn't handed-in work: why, in words."""
    if annotation.status in (AnnotationStatus.APPROVED, AnnotationStatus.REJECTED):
        return HTTPException(status_code=409, detail=f"This annotation was already {annotation.status.value}")
    return HTTPException(
        status_code=409,
        detail="This case hasn't been handed in for review yet -- the annotator still has to mark it as annotated.",
    )


def _check_storage_keys(payload: dict) -> None:
    for field in STORAGE_KEY_FIELDS:
        value = payload.get(field)
        if value is None:
            continue
        if not isinstance(value, str) or not value.startswith(MASK_KEY_PREFIX) or ".." in value or "\\" in value:
            raise HTTPException(status_code=422, detail=f"{field} must be one of this viewer's own mask uploads")


@router.post("/studies/{study_id}")
def create_annotation(
    study_id: str,
    target_type: str,
    target_id: uuid.UUID,
    type_name: str,
    payload: dict,
    status: AnnotationStatus = AnnotationStatus.DRAFT,
    base_version_id: str | None = None,
    review_of: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """`review_of`: set by a reviewer's in-progress save -- the handed-in
    (SUBMITTED) version under review. Such a draft keeps the case handed
    in (admin-service's case status reads it as submitted) and is what
    the review then decides. Reviewers and admins only; refused with 409
    unless that version is handed in and nobody else saved on top of it
    (F-01, F-07, F-09).

    `base_version_id`: the version this save was edited from ("none"
    when the target had no annotation of this type yet). When given, the
    save is refused with 409 if someone saved a newer version meanwhile --
    instead of silently burying their work (J-11). Omitted: no check.

    Create a new annotation version, as draft (an in-progress save) or
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
    try:
        study_id = str(uuid.UUID(study_id))
    except ValueError:
        raise HTTPException(status_code=422, detail="study_id must be a UUID") from None
    require_study_role(db, study_id, user, allowed_roles=["annotator", "reviewer", "admin"])
    if _study_of_target(db, target_type, target_id) != study_id:
        raise HTTPException(status_code=403, detail="That image doesn't belong to this study")

    if status not in _CREATABLE_STATUSES:
        raise HTTPException(status_code=422, detail=f"Cannot create an annotation with status '{status.value}'")

    annotation_type = db.query(AnnotationType).filter_by(name=type_name).first()
    if annotation_type is None:
        raise HTTPException(status_code=404, detail=f"Unknown annotation type: {type_name}")

    try:
        validate_payload(payload, annotation_type.json_schema)
    except PayloadValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _check_storage_keys(payload)

    reviewed = None
    if review_of is not None:
        require_study_role(db, study_id, user, allowed_roles=["reviewer", "admin"])
        if status != AnnotationStatus.DRAFT:
            raise HTTPException(status_code=422, detail="A review's in-progress save is a draft")
        try:
            reviewed = db.get(Annotation, uuid.UUID(review_of))
        except ValueError:
            raise HTTPException(status_code=422, detail="review_of must be an annotation id") from None
        if reviewed is None or (reviewed.target_type, reviewed.target_id, str(reviewed.study_id), reviewed.type_id) != (
            target_type, target_id, study_id, annotation_type.id
        ):
            raise HTTPException(status_code=404, detail="The version under review isn't an annotation of this image")
        if reviewed.status != AnnotationStatus.SUBMITTED and "admin" not in user.realm_roles:
            raise _not_reviewable(reviewed)
        _lock_target(db, target_type, target_id)
        latest = _latest_version(db, target_type, target_id, study_id, annotation_type.id)
        if latest is not None and latest.id != reviewed.id and latest.review_of_id != reviewed.id:
            raise HTTPException(
                status_code=409,
                detail="Someone saved a newer version of this while you were working -- reload to see it before saving again.",
            )

    parent_id = None
    if base_version_id is not None:
        _lock_target(db, target_type, target_id)
        latest = _latest_version(db, target_type, target_id, study_id, annotation_type.id)
        expected = None if base_version_id in ("", "none") else base_version_id
        if (str(latest.id) if latest else None) != expected:
            raise HTTPException(
                status_code=409,
                detail="Someone saved a newer version of this while you were working -- reload to see it before saving again.",
            )
        parent_id = latest.id if latest else None

    annotation = Annotation(
        target_type=target_type,
        target_id=target_id,
        study_id=study_id,
        annotator_id=user.subject,
        type_id=annotation_type.id,
        payload=payload,
        status=status,
        parent_version_id=parent_id,
        review_of_id=reviewed.id if reviewed is not None else None,
        # The wall-clock moment of this save, not the transaction start
        # (server default now()): saves in quick succession must stay in
        # the order they happened, so "the latest" is unambiguous.
        created_at=datetime.now(timezone.utc),
    )
    db.add(annotation)
    db.commit()
    return {
        "id": str(annotation.id),
        "status": annotation.status.value,
        "review_of_id": str(annotation.review_of_id) if annotation.review_of_id else None,
    }


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
    # Access follows the target's own study -- not whichever annotation
    # happens to be first -- and only that study's annotations come back.
    study_id = _study_of_target(db, target_type, target_id)
    require_study_role(db, study_id, user, allowed_roles=_READ_ROLES)
    annotations = (
        db.query(Annotation)
        .filter_by(target_type=target_type, target_id=target_id, study_id=study_id)
        .order_by(Annotation.created_at, Annotation.id)
        .all()
    )

    return [
        {
            "id": str(a.id),
            "type_id": str(a.type_id),
            "payload": a.payload,
            "status": a.status.value,
            "review_of_id": str(a.review_of_id) if a.review_of_id else None,
            "created_at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in annotations
    ]


class ReviewBody(BaseModel):
    comment: str | None = None


# Every object's comment, reason and form answers joined -- generous, but a
# hard stop for anything absurd.
MAX_REVIEW_COMMENT_CHARS = 200_000


@router.post("/{annotation_id}/review")
def review_annotation(
    annotation_id: uuid.UUID,
    decision: str,
    comment: str | None = None,
    body: ReviewBody | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Approve or reject handed-in work: a SUBMITTED version, or a
    reviewer's draft of one (see create_annotation's `review_of`), and
    only the image's latest version. An annotator's plain draft (never
    handed in) or an already decided version is refused with 409 (F-09,
    F-07); a global admin may override.

    The comment goes in the JSON body ({"comment": ...}); the `comment`
    query parameter still works for short ones, but a long review made
    the URL too long and failed with a 500 (F-08)."""
    if body is not None and body.comment is not None:
        comment = body.comment
    if comment is not None and len(comment) > MAX_REVIEW_COMMENT_CHARS:
        raise HTTPException(status_code=422, detail=f"The review comment is too long (at most {MAX_REVIEW_COMMENT_CHARS:,} characters)")
    # Row lock: concurrent decisions (a double click, two reviewers at
    # once) are taken one after the other, so the second sees the first's
    # decision and gets 409 instead of recording a duplicate review (J-12).
    annotation = db.query(Annotation).filter(Annotation.id == annotation_id).with_for_update().first()
    if annotation is None:
        raise HTTPException(status_code=404, detail="Annotation not found")

    require_study_role(db, str(annotation.study_id), user, allowed_roles=["reviewer", "admin"])
    if decision not in ("approve", "reject"):
        raise HTTPException(status_code=422, detail="decision must be 'approve' or 'reject'")
    if "admin" not in user.realm_roles:
        # A decision is a decision -- re-deciding an already approved/
        # rejected version is reserved for a global admin (an override),
        # so two reviewers can't silently flip each other's outcome; and
        # a reviewer can't bypass that by deciding a fresh version made on
        # top of a decided one, or a draft nobody handed in.
        if _handed_in(db, annotation) is None:
            raise _not_reviewable(annotation)
        latest = _latest_version(db, annotation.target_type, annotation.target_id, str(annotation.study_id), annotation.type_id)
        if latest is not None and latest.id != annotation.id:
            raise HTTPException(status_code=409, detail="A newer version of this image exists -- reload before deciding.")
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
