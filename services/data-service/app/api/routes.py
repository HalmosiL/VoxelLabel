"""HTTP API for browsing studies/series/instances and retrieving pixel data."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user, require_project_role
from shared_models.database import get_db
from shared_models.models import Instance, Study

from app.storage import presigned_pixel_data_url

router = APIRouter(prefix="/data", tags=["data"])

_READ_ROLES = ["viewer", "annotator", "reviewer", "data_manager", "admin"]


@router.get("/projects/{project_id}/studies")
def list_studies(
    project_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    require_project_role(db, project_id, user, allowed_roles=_READ_ROLES)

    studies = db.query(Study).filter_by(project_id=project_id).all()
    return [
        {
            "id": str(s.id),
            "study_instance_uid": s.study_instance_uid,
            "study_date": s.study_date.isoformat() if s.study_date else None,
            "modality": s.modality,
            "description": s.description,
        }
        for s in studies
    ]


@router.get("/studies/{study_id}/series")
def list_series(
    study_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    study = db.get(Study, study_id)
    require_project_role(db, str(study.project_id), user, allowed_roles=_READ_ROLES)

    return [
        {"id": str(s.id), "series_instance_uid": s.series_instance_uid, "series_description": s.series_description}
        for s in study.series
    ]


@router.get("/instances/{instance_id}/pixel-data-url")
def get_pixel_data_url(
    instance_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Return a short-lived presigned URL to fetch the raw DICOM file
    directly from object storage."""
    instance = db.get(Instance, instance_id)
    study = instance.series.study
    require_project_role(db, str(study.project_id), user, allowed_roles=_READ_ROLES)

    return {"url": presigned_pixel_data_url(instance.object_storage_key)}
