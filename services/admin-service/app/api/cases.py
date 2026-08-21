"""HTTP API for creating and updating cases -- the central entity that
ties a patient to a study. Patient identity resolution
(pseudonymization) happens here, once, at case-creation time, rather than
being repeated on every DICOM upload. See ARCHITECTURE.md, "Case-centric
data model".
"""
import hashlib
import uuid
from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import Case, Patient, PatientIdentityMap

router = APIRouter(prefix="/admin", tags=["admin:cases"])


def _get_or_create_patient(db: Session, external_patient_id: str) -> Patient:
    """Look up or create a pseudonymized patient record from a real-world
    identifier (e.g. an MRN). The mapping lives only in
    PatientIdentityMap (access-restricted); external_patient_id itself is
    never stored anywhere else.
    """
    external_id_hash = hashlib.sha256(external_patient_id.encode()).hexdigest()

    mapping = db.query(PatientIdentityMap).filter_by(external_id_hash=external_id_hash).first()
    if mapping is not None:
        return db.get(Patient, mapping.patient_id)

    patient = Patient(pseudonym_id=str(uuid.uuid4()))
    db.add(patient)
    db.flush()
    db.add(PatientIdentityMap(patient_id=patient.id, external_id_hash=external_id_hash))
    return patient


@router.post("/studies/{study_id}/cases")
def create_case(
    study_id: str,
    external_patient_id: str,
    accession_number: str | None = None,
    case_date: str | None = None,
    type: str | None = None,
    title: str | None = None,
    comment: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Create a case in a study, resolving (or creating) the patient it
    belongs to from a real-world identifier."""
    require_study_role(db, study_id, user, allowed_roles=["data_manager", "admin"])

    patient = _get_or_create_patient(db, external_patient_id)
    case = Case(
        study_id=study_id,
        patient_id=patient.id,
        accession_number=accession_number,
        date=date_type.fromisoformat(case_date) if case_date else None,
        type=type,
        title=title,
        comment=comment,
    )
    db.add(case)
    db.commit()
    return {"id": str(case.id), "patient_id": str(patient.id), "accession_number": case.accession_number}


@router.patch("/cases/{case_id}")
def update_case(
    case_id: str,
    accession_number: str | None = None,
    case_date: str | None = None,
    type: str | None = None,
    title: str | None = None,
    comment: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Partial update -- only fields explicitly passed are changed. To
    clear a field, pass an empty string."""
    case = db.get(Case, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found")
    require_study_role(db, str(case.study_id), user, allowed_roles=["data_manager", "admin"])

    if accession_number is not None:
        case.accession_number = accession_number or None
    if case_date is not None:
        case.date = date_type.fromisoformat(case_date) if case_date else None
    if type is not None:
        case.type = type or None
    if title is not None:
        case.title = title or None
    if comment is not None:
        case.comment = comment or None

    db.commit()
    return {
        "id": str(case.id),
        "accession_number": case.accession_number,
        "date": case.date.isoformat() if case.date else None,
        "type": case.type,
        "title": case.title,
        "comment": case.comment,
    }
