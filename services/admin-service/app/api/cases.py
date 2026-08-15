"""HTTP API for creating cases -- the central entity that ties a patient to
a project. Patient identity resolution (pseudonymization) happens here,
once, at case-creation time, rather than being repeated on every DICOM
upload. See ARCHITECTURE.md, "Case-centric data model".
"""
import hashlib
import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user, require_project_role
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


@router.post("/projects/{project_id}/cases")
def create_case(
    project_id: str,
    external_patient_id: str,
    accession_number: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Create a case in a project, resolving (or creating) the patient it
    belongs to from a real-world identifier."""
    require_project_role(db, project_id, user, allowed_roles=["data_manager", "admin"])

    patient = _get_or_create_patient(db, external_patient_id)
    case = Case(project_id=project_id, patient_id=patient.id, accession_number=accession_number)
    db.add(case)
    db.commit()
    return {"id": str(case.id), "patient_id": str(patient.id), "accession_number": case.accession_number}
