"""HTTP API for attaching generic (non-DICOM) clinical data to a case,
plus per-item tags and consent records. See ARCHITECTURE.md, "Case-centric
data model". Reading/listing this data lives in data-service, not here --
this router only covers the write/creation side.
"""
import uuid
from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user, require_project_role
from shared_models.database import get_db
from shared_models.models import Case, ClinicalDataItem, Consent, ConsentStatus, Tag

from app.storage import upload_clinical_data_file

router = APIRouter(prefix="/admin", tags=["admin:clinical-data"])


def _case_or_404(db: Session, case_id: str) -> Case:
    case = db.get(Case, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


def _clinical_data_item_or_404(db: Session, item_id: uuid.UUID) -> ClinicalDataItem:
    item = db.get(ClinicalDataItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Clinical data item not found")
    return item


@router.post("/cases/{case_id}/clinical-data-items")
async def create_clinical_data_item(
    case_id: str,
    type: str,
    title: str,
    item_date: str | None = None,
    file: UploadFile | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Attach a clinical data item to a case, with an optional file upload."""
    case = _case_or_404(db, case_id)
    require_project_role(db, str(case.project_id), user, allowed_roles=["data_manager", "admin"])

    storage_key = None
    if file is not None and file.filename:
        storage_key = f"clinical-data/{case_id}/{uuid.uuid4()}-{file.filename}"
        upload_clinical_data_file(storage_key, await file.read())

    item = ClinicalDataItem(
        case_id=case.id,
        date=date_type.fromisoformat(item_date) if item_date else None,
        type=type,
        title=title,
        object_storage_key=storage_key,
    )
    db.add(item)
    db.commit()
    return {"id": str(item.id), "title": item.title}


@router.post("/clinical-data-items/{item_id}/tags")
def add_tag(
    item_id: uuid.UUID,
    label: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    item = _clinical_data_item_or_404(db, item_id)
    case = _case_or_404(db, str(item.case_id))
    require_project_role(db, str(case.project_id), user, allowed_roles=["data_manager", "admin", "annotator"])

    tag = Tag(clinical_data_item_id=item.id, label=label)
    db.add(tag)
    db.commit()
    return {"id": str(tag.id), "label": tag.label}


@router.post("/clinical-data-items/{item_id}/consents")
def add_consent(
    item_id: uuid.UUID,
    consent_type: str,
    status: ConsentStatus,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    item = _clinical_data_item_or_404(db, item_id)
    case = _case_or_404(db, str(item.case_id))
    require_project_role(db, str(case.project_id), user, allowed_roles=["data_manager", "admin"])

    consent = Consent(clinical_data_item_id=item.id, consent_type=consent_type, status=status)
    db.add(consent)
    db.commit()
    return {"id": str(consent.id), "consent_type": consent.consent_type, "status": consent.status.value}
