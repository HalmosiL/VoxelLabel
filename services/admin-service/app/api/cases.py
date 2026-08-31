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
from shared_models.models import Case, ClinicalDataItem, ImagingStudy, Patient, PatientIdentityMap

from app.api.imaging import _delete_instance
from app.api.studies import _require_global_admin
from app.api.workflow import _cascade_new_case
from app.storage import delete_object

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


@router.post("/patients")
def create_patient(
    external_patient_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Registers a patient from their real-world identifier (e.g. an MRN)
    with no case yet -- for pre-registering someone before their first
    study/case exists. Reuses the exact same pseudonymization path
    (_get_or_create_patient) case-creation already goes through, so a
    patient registered here and later referenced with the same
    external_patient_id at case-creation time resolves to this same
    pseudonym instead of a duplicate.

    Global admin only, same as the cross-study Patients list/profile
    pages (GET /data/patients) -- a patient with no case yet has no
    study to scope an ordinary study-role check against."""
    _require_global_admin(user)
    patient = _get_or_create_patient(db, external_patient_id)
    db.commit()
    return {"id": str(patient.id), "pseudonym_id": patient.pseudonym_id}


@router.post("/studies/{study_id}/cases")
def create_case(
    study_id: str,
    external_patient_id: str | None = None,
    patient_id: str | None = None,
    accession_number: str | None = None,
    case_date: str | None = None,
    type: str | None = None,
    title: str | None = None,
    comment: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Create a case in a study, for either a brand-new patient (resolved
    from a real-world identifier via `external_patient_id`) or an already
    -known patient (`patient_id`, e.g. picked from the existing patients
    list to add another case to them). Exactly one of the two must be
    given."""
    require_study_role(db, study_id, user, allowed_roles=["data_manager", "admin"])

    if patient_id:
        patient = db.get(Patient, patient_id)
        if patient is None:
            raise HTTPException(status_code=404, detail="Patient not found")
    elif external_patient_id:
        patient = _get_or_create_patient(db, external_patient_id)
    else:
        raise HTTPException(status_code=422, detail="Either external_patient_id or patient_id is required")

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

    # Push the new case through the board on its own -- every "all_cases"
    # Dataset card (and everything wired downstream of it) refreshes
    # right away, the same way a manual Run on the board already would.
    # Best-effort: a board mid-configuration somewhere downstream should
    # never block the case itself from having been created.
    try:
        _cascade_new_case(db, case.study_id)
    except Exception:
        pass

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


def _delete_case_cascade(db: Session, case: Case) -> None:
    """Deletes everything under a case: imaging studies -> series ->
    instances (cascaded the same way delete_imaging_study already does,
    reusing its own _delete_instance so pixel data/thumbnails in object
    storage get cleaned up too), clinical data items, and the case row
    itself. Does not commit -- shared by delete_case (one case, its own
    commit) and delete_study's force-delete (many cases, one commit for
    the whole batch plus the study row).

    Any case_id left dangling in a workflow card's manual case list or
    output_case_ids is not cleaned up -- board scratch space already
    tolerates staleness the same way elsewhere (see
    delete_workflow_card's own docstring)."""
    for imaging_study in db.query(ImagingStudy).filter_by(case_id=case.id).all():
        for series in imaging_study.series:
            for instance in series.instances:
                _delete_instance(db, instance)
            db.delete(series)
        db.delete(imaging_study)

    for item in db.query(ClinicalDataItem).filter_by(case_id=case.id).all():
        if item.object_storage_key:
            delete_object(item.object_storage_key)
        for tag in item.tags:
            db.delete(tag)
        for consent in item.consents:
            db.delete(consent)
        db.delete(item)

    db.delete(case)


@router.delete("/cases/{case_id}", status_code=204)
def delete_case(
    case_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Deletes a case and everything under it (see _delete_case_cascade).
    Not the "still has data, remove first" guard delete_study uses for
    its cases -- that guard exists specifically so removing the
    *sensitive data itself* stays a deliberate, separate action from
    deleting the organizational Study container around it; a case IS
    that data, so cascading here (behind its own explicit delete +
    confirm dialog on the frontend) is that separate, deliberate
    action."""
    case = db.get(Case, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found")
    require_study_role(db, str(case.study_id), user, allowed_roles=["data_manager", "admin"])

    _delete_case_cascade(db, case)
    db.commit()
