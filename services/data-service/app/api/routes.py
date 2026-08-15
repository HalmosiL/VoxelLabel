"""HTTP API for browsing cases, studies/series/instances, and clinical data items."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user, require_project_role
from shared_models.database import get_db
from shared_models.models import Case, ClinicalDataItem, Instance, Series, Study

from app.storage import presigned_clinical_data_url, presigned_pixel_data_url

router = APIRouter(prefix="/data", tags=["data"])

_READ_ROLES = ["viewer", "annotator", "reviewer", "data_manager", "admin"]


def _case_or_404(db: Session, case_id: str) -> Case:
    case = db.get(Case, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


@router.get("/projects/{project_id}/cases")
def list_cases(
    project_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    require_project_role(db, project_id, user, allowed_roles=_READ_ROLES)

    cases = db.query(Case).filter_by(project_id=project_id).all()
    return [
        {
            "id": str(c.id),
            "patient_pseudonym_id": c.patient.pseudonym_id,
            "accession_number": c.accession_number,
        }
        for c in cases
    ]


@router.get("/cases/{case_id}")
def get_case(
    case_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    case = _case_or_404(db, case_id)
    require_project_role(db, str(case.project_id), user, allowed_roles=_READ_ROLES)

    return {
        "id": str(case.id),
        "project_id": str(case.project_id),
        "patient_pseudonym_id": case.patient.pseudonym_id,
        "accession_number": case.accession_number,
    }


@router.get("/cases/{case_id}/studies")
def list_studies(
    case_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    case = _case_or_404(db, case_id)
    require_project_role(db, str(case.project_id), user, allowed_roles=_READ_ROLES)

    studies = db.query(Study).filter_by(case_id=case_id).all()
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
    require_project_role(db, str(study.case.project_id), user, allowed_roles=_READ_ROLES)

    return [
        {"id": str(s.id), "series_instance_uid": s.series_instance_uid, "series_description": s.series_description}
        for s in study.series
    ]


@router.get("/series/{series_id}/instances")
def list_instances(
    series_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    series = db.get(Series, series_id)
    require_project_role(db, str(series.study.case.project_id), user, allowed_roles=_READ_ROLES)

    return [
        {"id": str(i.id), "sop_instance_uid": i.sop_instance_uid, "instance_number": i.instance_number}
        for i in series.instances
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
    require_project_role(db, str(study.case.project_id), user, allowed_roles=_READ_ROLES)

    return {"url": presigned_pixel_data_url(instance.object_storage_key)}


@router.get("/cases/{case_id}/clinical-data-items")
def list_clinical_data_items(
    case_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    case = _case_or_404(db, case_id)
    require_project_role(db, str(case.project_id), user, allowed_roles=_READ_ROLES)

    items = db.query(ClinicalDataItem).filter_by(case_id=case_id).all()
    return [
        {
            "id": str(i.id),
            "date": i.date.isoformat() if i.date else None,
            "type": i.type,
            "title": i.title,
            "has_file": i.object_storage_key is not None,
            "tags": [t.label for t in i.tags],
            "consents": [{"consent_type": c.consent_type, "status": c.status.value} for c in i.consents],
        }
        for i in items
    ]


@router.get("/clinical-data-items/{item_id}/file-url")
def get_clinical_data_file_url(
    item_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    item = db.get(ClinicalDataItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Clinical data item not found")
    require_project_role(db, str(item.case.project_id), user, allowed_roles=_READ_ROLES)

    if item.object_storage_key is None:
        raise HTTPException(status_code=404, detail="This item has no attached file")
    return {"url": presigned_clinical_data_url(item.object_storage_key)}
