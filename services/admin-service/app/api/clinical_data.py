"""HTTP API for attaching generic (non-DICOM) clinical data to a case,
plus per-item tags and consent records. See ARCHITECTURE.md, "Case-centric
data model". Reading/listing this data lives in data-service, not here --
this router only covers the write/creation side.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import Case, ClinicalDataItem, Consent, ConsentStatus, Tag
from sqlalchemy.orm import Session

from app.api import input_checks
from app.storage import delete_object, upload_clinical_data_file

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
    """Attach a clinical data item to a case, with an optional file upload.

    Every value is checked, and the row flushed, before the file is
    written, and a commit that still fails removes the file again -- so a
    refused upload leaves no orphan object in the bucket (J-05). The
    stored key uses a sanitised filename (input_checks.safe_filename)."""
    case = _case_or_404(db, case_id)
    require_study_role(db, str(case.study_id), user, allowed_roles=["data_manager", "admin"])

    storage_key = None
    if file is not None and file.filename:
        storage_key = f"clinical-data/{case.id}/{uuid.uuid4()}-{input_checks.safe_filename(file.filename)}"

    item = ClinicalDataItem(
        case_id=case.id,
        date=input_checks.optional_date(item_date, "The document date"),
        type=input_checks.required_text(type, "The document type"),
        title=input_checks.required_text(title, "The document title"),
        object_storage_key=storage_key,
    )
    db.add(item)
    db.flush()
    if storage_key is not None:
        upload_clinical_data_file(storage_key, await file.read())
    try:
        db.commit()
    except Exception:
        if storage_key is not None:
            delete_object(storage_key)
        raise
    return {"id": str(item.id), "title": item.title}


@router.patch("/clinical-data-items/{item_id}")
def update_clinical_data_item(
    item_id: uuid.UUID,
    type: str | None = None,
    title: str | None = None,
    item_date: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Partial update. `type`/`title` are required fields on the model, so
    (unlike Case's optional fields) an empty value is ignored rather than
    clearing them -- only `item_date` can be cleared with an empty string."""
    item = _clinical_data_item_or_404(db, item_id)
    case = _case_or_404(db, str(item.case_id))
    require_study_role(db, str(case.study_id), user, allowed_roles=["data_manager", "admin"])

    if type:
        item.type = type
    if title:
        item.title = title
    if item_date is not None:
        item.date = input_checks.optional_date(item_date, "The document date")

    db.commit()
    return {
        "id": str(item.id),
        "type": item.type,
        "title": item.title,
        "date": item.date.isoformat() if item.date else None,
    }


@router.delete("/clinical-data-items/{item_id}")
def delete_clinical_data_item(
    item_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    item = _clinical_data_item_or_404(db, item_id)
    case = _case_or_404(db, str(item.case_id))
    require_study_role(db, str(case.study_id), user, allowed_roles=["data_manager", "admin"])

    if item.object_storage_key:
        delete_object(item.object_storage_key)
    for tag in item.tags:
        db.delete(tag)
    for consent in item.consents:
        db.delete(consent)
    db.delete(item)
    db.commit()
    return {"deleted": True}


@router.post("/clinical-data-items/{item_id}/tags")
def add_tag(
    item_id: uuid.UUID,
    label: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    item = _clinical_data_item_or_404(db, item_id)
    case = _case_or_404(db, str(item.case_id))
    require_study_role(db, str(case.study_id), user, allowed_roles=["data_manager", "admin", "annotator"])

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
    require_study_role(db, str(case.study_id), user, allowed_roles=["data_manager", "admin"])

    consent = Consent(clinical_data_item_id=item.id, consent_type=consent_type, status=status)
    db.add(consent)
    db.commit()
    return {"id": str(consent.id), "consent_type": consent.consent_type, "status": consent.status.value}
