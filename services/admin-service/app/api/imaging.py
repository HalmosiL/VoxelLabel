"""HTTP API for editing/deleting imaging data (Study/Series) after
ingestion. Pixel data itself is never edited -- only the descriptive
metadata (description/modality/body part) can be corrected. Deletion
cascades down to child rows and their object-storage files (pixel data
+ thumbnail), since nothing else references an Instance/Series once its
parent Study is gone.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user, require_project_role
from shared_models.database import get_db
from shared_models.models import Instance, Series, Study

from app.storage import delete_object

router = APIRouter(prefix="/admin", tags=["admin:imaging"])


def _study_or_404(db: Session, study_id: uuid.UUID) -> Study:
    study = db.get(Study, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")
    return study


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


@router.patch("/studies/{study_id}")
def update_study(
    study_id: uuid.UUID,
    description: str | None = None,
    modality: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    study = _study_or_404(db, study_id)
    require_project_role(db, str(study.case.project_id), user, allowed_roles=["data_manager", "admin"])

    if description is not None:
        study.description = description or None
    if modality is not None:
        study.modality = modality or None

    db.commit()
    return {"id": str(study.id), "description": study.description, "modality": study.modality}


@router.delete("/studies/{study_id}")
def delete_study(
    study_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    study = _study_or_404(db, study_id)
    require_project_role(db, str(study.case.project_id), user, allowed_roles=["data_manager", "admin"])

    for series in study.series:
        for instance in series.instances:
            _delete_instance(db, instance)
        db.delete(series)
    db.delete(study)
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
    require_project_role(db, str(series.study.case.project_id), user, allowed_roles=["data_manager", "admin"])

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
    require_project_role(db, str(series.study.case.project_id), user, allowed_roles=["data_manager", "admin"])

    for instance in series.instances:
        _delete_instance(db, instance)
    db.delete(series)
    db.commit()
    return {"deleted": True}
