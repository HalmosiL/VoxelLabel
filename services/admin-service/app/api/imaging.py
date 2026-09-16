"""HTTP API for editing/deleting imaging data (ImagingStudy/Series) after
ingestion. Pixel data itself is never edited -- only the descriptive
metadata (description/modality/body part) can be corrected. Deletion
cascades down to child rows and their object-storage files (pixel data
+ thumbnail) -- and, via _delete_annotations_targeting below, any
Annotation aimed at the row being removed, since Annotation.target_id
is a bare UUID column (not an enforced FK) that would otherwise be left
dangling, silently, by a normal delete.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import Annotation, AnnotationReview, ImagingStudy, Instance, Series
from sqlalchemy.orm import Session

from app.storage import delete_object

router = APIRouter(prefix="/admin", tags=["admin:imaging"])


def _delete_annotations_targeting(db: Session, target_ids: list[uuid.UUID]) -> None:
    """Deletes every Annotation whose target_id is one of the given
    ImagingStudy/Series/Instance ids (whichever level it was made
    against -- see the Annotation model's own docstring on target_type),
    along with their AnnotationReviews (the only other table with a real
    FK to annotations.id in active use).

    target_id isn't a foreign key -- Annotation only carries an enforced
    FK to the top-level Study (`study_id`) -- so nothing stops a Series
    or Instance from being deleted while an Annotation still points at
    it; the annotation would then just silently orphan. It's only when
    something LATER tries to delete the Study those orphans still
    (correctly) reference that Postgres actually raises, as an opaque
    500 with no obvious connection to what's on screen -- which is
    exactly the bug this closes. Every caller that deletes an
    ImagingStudy/Series/Instance should route through here first.

    A single bulk DELETE per table (not a per-row db.delete() loop) both
    for speed and to duck Annotation.parent_version_id's self-reference:
    Postgres checks a multi-row DELETE's own FK references against the
    statement's final state, so deleting a whole version chain in one
    statement never trips over which row "should" go first."""
    if not target_ids:
        return
    annotation_ids = [row.id for row in db.query(Annotation.id).filter(Annotation.target_id.in_(target_ids)).all()]
    if not annotation_ids:
        return
    db.query(AnnotationReview).filter(AnnotationReview.annotation_id.in_(annotation_ids)).delete(
        synchronize_session=False
    )
    db.query(Annotation).filter(Annotation.id.in_(annotation_ids)).delete(synchronize_session=False)


def _imaging_study_or_404(db: Session, imaging_study_id: uuid.UUID) -> ImagingStudy:
    imaging_study = db.get(ImagingStudy, imaging_study_id)
    if imaging_study is None:
        raise HTTPException(status_code=404, detail="Imaging study not found")
    return imaging_study


def _series_or_404(db: Session, series_id: uuid.UUID) -> Series:
    series = db.get(Series, series_id)
    if series is None:
        raise HTTPException(status_code=404, detail="Series not found")
    return series


def _delete_instance(db: Session, instance: Instance) -> None:
    delete_object(instance.object_storage_key)
    if instance.thumbnail_key:
        delete_object(instance.thumbnail_key)
    db.delete(instance)


@router.patch("/imaging-studies/{imaging_study_id}")
def update_imaging_study(
    imaging_study_id: uuid.UUID,
    description: str | None = None,
    modality: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    imaging_study = _imaging_study_or_404(db, imaging_study_id)
    require_study_role(db, str(imaging_study.case.study_id), user, allowed_roles=["data_manager", "admin"])

    if description is not None:
        imaging_study.description = description or None
    if modality is not None:
        imaging_study.modality = modality or None

    db.commit()
    return {"id": str(imaging_study.id), "description": imaging_study.description, "modality": imaging_study.modality}


@router.delete("/imaging-studies/{imaging_study_id}")
def delete_imaging_study(
    imaging_study_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    imaging_study = _imaging_study_or_404(db, imaging_study_id)
    require_study_role(db, str(imaging_study.case.study_id), user, allowed_roles=["data_manager", "admin"])

    target_ids = [imaging_study.id]
    for series in imaging_study.series:
        target_ids.append(series.id)
        target_ids.extend(instance.id for instance in series.instances)
    _delete_annotations_targeting(db, target_ids)

    for series in imaging_study.series:
        for instance in series.instances:
            _delete_instance(db, instance)
        db.delete(series)
    db.delete(imaging_study)
    db.commit()
    return {"deleted": True}


@router.patch("/series/{series_id}")
def update_series(
    series_id: uuid.UUID,
    series_description: str | None = None,
    body_part: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    series = _series_or_404(db, series_id)
    require_study_role(db, str(series.imaging_study.case.study_id), user, allowed_roles=["data_manager", "admin"])

    if series_description is not None:
        series.series_description = series_description or None
    if body_part is not None:
        series.body_part = body_part or None

    db.commit()
    return {"id": str(series.id), "series_description": series.series_description, "body_part": series.body_part}


@router.delete("/series/{series_id}")
def delete_series(
    series_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    series = _series_or_404(db, series_id)
    require_study_role(db, str(series.imaging_study.case.study_id), user, allowed_roles=["data_manager", "admin"])

    for instance in series.instances:
        _delete_instance(db, instance)
    db.delete(series)
    db.commit()
    return {"deleted": True}
