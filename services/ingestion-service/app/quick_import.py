"""Quick import: turn a folder/zip of loose DICOM files -- of any mix of
patients and studies -- straight into fully ingested Cases, with no manual
"create a case first" step.

Files are grouped by (PatientID, StudyInstanceUID): each distinct pair
resolves to one Patient (the same real-identifier-hash pseudonymization
admin-service's own case-creation uses, duplicated here since ingestion-
service and admin-service are separate deployable services with no shared
code path beyond shared_models itself) and one Case, auto-titled from the
DICOM tags -- created fresh the first time that pair is seen, or reused
for every subsequent file. Deliberately runs every file for one import
through a single Celery task, sequentially (see app/tasks.py's
quick_import_batch) -- concurrent workers racing to create the *same*
brand-new ImagingStudy/Series row is a real, previously-hit bug (see
project memory / pipeline.py's IntegrityError handling); a batch upload
is exactly the workload most likely to trigger it, so this path avoids
concurrency entirely rather than relying only on that defensive fallback.
"""
import hashlib
import io
import uuid
from datetime import date as date_type

import pydicom
from sqlalchemy.orm import Session

from shared_models.database import SessionLocal
from shared_models.models import Case, ImagingStudy, Instance, Patient, PatientIdentityMap

from app.deidentify import apply_deidentification_profile
from app.pipeline import REQUIRED_TAGS, DicomValidationError, _ingest_one_instance
from app.storage import delete_staged_file, download_staged_file


def _get_or_create_patient(db: Session, external_patient_id: str) -> Patient:
    """Same pseudonymization convention as admin-service's own
    cases.py::_get_or_create_patient -- a patient quick-imported here
    resolves to the identical pseudonym a manually created case for the
    same real identifier (e.g. a PatientID re-typed by hand) would."""
    external_id_hash = hashlib.sha256(external_patient_id.encode()).hexdigest()

    mapping = db.query(PatientIdentityMap).filter_by(external_id_hash=external_id_hash).first()
    if mapping is not None:
        return db.get(Patient, mapping.patient_id)

    patient = Patient(pseudonym_id=str(uuid.uuid4()))
    db.add(patient)
    db.flush()
    db.add(PatientIdentityMap(patient_id=patient.id, external_id_hash=external_id_hash))
    return patient


def _parse_dicom_date(value: str | None) -> date_type | None:
    if not value or len(value) != 8:
        return None
    try:
        return date_type(int(value[0:4]), int(value[4:6]), int(value[6:8]))
    except ValueError:
        return None


def _resolve_or_create_case(db: Session, study_id: str, dataset) -> tuple[Case, bool]:
    """Returns (case, was_newly_created). Matches an existing Case by an
    ImagingStudy sharing this StudyInstanceUID *within this admin Study*
    (so quick-importing more slices for an already-known DICOM study
    lands on the same Case instead of a duplicate; the same
    StudyInstanceUID under a *different* admin Study, if that ever
    happens, correctly gets its own Case there) -- created fresh, titled
    from whatever StudyDescription/Modality/StudyDate the files carry, if
    none exists yet.
    """
    existing_imaging_study = (
        db.query(ImagingStudy)
        .join(Case, Case.id == ImagingStudy.case_id)
        .filter(ImagingStudy.study_instance_uid == dataset.StudyInstanceUID, Case.study_id == study_id)
        .first()
    )
    if existing_imaging_study is not None:
        return db.get(Case, existing_imaging_study.case_id), False

    patient = _get_or_create_patient(db, dataset.PatientID)
    modality = getattr(dataset, "Modality", None)
    description = getattr(dataset, "StudyDescription", None)
    title = description or (f"{modality} study" if modality else "Imported case")

    case = Case(
        study_id=study_id,
        patient_id=patient.id,
        date=_parse_dicom_date(getattr(dataset, "StudyDate", None)),
        type=modality,
        title=title,
        comment="Quick-imported from DICOM upload",
    )
    db.add(case)
    db.flush()
    return case, True


def run_quick_import(study_id: str, staging_keys: list[str]) -> dict:
    """Processes every staged file for one quick-import batch, in order.
    Never raises for a single bad file -- each file's own outcome (or
    error) is recorded and the rest of the batch still runs, since one
    corrupt file in a folder of hundreds shouldn't sink the whole import.
    """
    db: Session = SessionLocal()
    cases: dict[str, dict] = {}  # case_id -> {"title", "created", "instance_count"}
    errors: list[dict] = []

    try:
        for staging_key in staging_keys:
            try:
                raw = download_staged_file(staging_key)
                dataset = pydicom.dcmread(io.BytesIO(raw))

                missing = [tag for tag in REQUIRED_TAGS if tag not in dataset]
                if not hasattr(dataset, "PatientID"):
                    missing = [*missing, "PatientID"]
                if missing:
                    raise DicomValidationError(f"Missing required DICOM tags: {missing}")

                # Checked *before* resolving/creating a Case: SOPInstanceUID
                # uniqueness is global (the same instance already ingested
                # under any case, in any study, counts), and
                # _resolve_or_create_case's own matching relies on this
                # batch's Case actually gaining a real ImagingStudy row --
                # which never happens for a duplicate (_ingest_one_instance
                # returns early, before ever creating one). Checking here
                # instead avoids spinning up an empty, orphaned Case every
                # time a duplicate happens to be the first file seen for
                # its StudyInstanceUID in this batch.
                if db.query(Instance).filter_by(sop_instance_uid=dataset.SOPInstanceUID).first() is not None:
                    delete_staged_file(staging_key)
                    continue

                case, created = _resolve_or_create_case(db, study_id, dataset)
                # Committed immediately, independent of this file's own
                # instance-level outcome below -- so a later IntegrityError
                # retry (see _ingest_one_instance -> _get_or_create_*,
                # which rolls back on conflict) can never undo a
                # patient/case that's already real.
                db.commit()

                dataset = apply_deidentification_profile(dataset, study_id=study_id)
                result = _ingest_one_instance(db, case, dataset)
                db.commit()
                delete_staged_file(staging_key)

                entry = cases.setdefault(str(case.id), {"title": case.title, "created": created, "instance_count": 0})
                if result["status"] == "completed":
                    entry["instance_count"] += 1
            except Exception as exc:
                db.rollback()
                errors.append({"file": staging_key, "error": str(exc)})
                try:
                    # A failed file is never retried automatically (see
                    # the Celery task's own docstring), so there's
                    # nothing left to stage it for -- best-effort cleanup,
                    # wrapped separately so a delete failure here can
                    # never hide the real error just recorded above.
                    delete_staged_file(staging_key)
                except Exception:
                    pass

        return {
            "cases": [{"case_id": cid, **info} for cid, info in cases.items()],
            "instances_ingested": sum(c["instance_count"] for c in cases.values()),
            "errors": errors,
        }
    finally:
        db.close()
