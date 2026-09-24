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
from shared_models.database import SessionLocal
from shared_models.models import Case, ImagingStudy, Instance, Patient, PatientIdentityMap
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.deidentify import apply_deidentification_profile
from app.pipeline import REQUIRED_TAGS, DicomValidationError, ForeignImagingError, _ingest_one_instance, foreign_imaging_owner
from app.storage import delete_staged_file, download_staged_file


def _get_or_create_patient(db: Session, external_patient_id: str) -> Patient:
    """Same pseudonymization convention as admin-service's own
    cases.py::_get_or_create_patient -- a patient quick-imported here
    resolves to the identical pseudonym a manually created case for the
    same real identifier (e.g. a PatientID re-typed by hand) would --
    trimmed the same way (admin-service's input_checks.external_patient_id),
    so a padded PatientID doesn't split one person into two patients."""
    external_id_hash = hashlib.sha256(external_patient_id.strip().encode()).hexdigest()

    mapping = db.query(PatientIdentityMap).filter_by(external_id_hash=external_id_hash).first()
    if mapping is not None:
        return db.get(Patient, mapping.patient_id)

    # Another worker importing the same new patient right now inserts the
    # same hash: the loser's insert fails on the unique key (after the
    # winner commits) inside this savepoint, and the winner's patient is
    # used instead of failing the file (B-04).
    try:
        with db.begin_nested():
            patient = Patient(pseudonym_id=str(uuid.uuid4()))
            db.add(patient)
            db.flush()
            db.add(PatientIdentityMap(patient_id=patient.id, external_id_hash=external_id_hash))
            db.flush()
        return patient
    except IntegrityError:
        mapping = db.query(PatientIdentityMap).filter_by(external_id_hash=external_id_hash).first()
        if mapping is None:
            raise
        return db.get(Patient, mapping.patient_id)


def _parse_dicom_date(value: str | None) -> date_type | None:
    if not value or len(value) != 8:
        return None
    try:
        return date_type(int(value[0:4]), int(value[4:6]), int(value[6:8]))
    except ValueError:
        return None


def _resolve_or_create_case(db: Session, study_id: str, dataset, external_patient_id: str) -> tuple[Case, bool]:
    """Returns (case, was_newly_created). Matches an existing Case by an
    ImagingStudy sharing this StudyInstanceUID *within this admin Study*
    (so quick-importing more slices for an already-known DICOM study
    lands on the same Case instead of a duplicate; the same
    StudyInstanceUID under a *different* admin Study, if that ever
    happens, correctly gets its own Case there) -- created fresh, titled
    from whatever StudyDescription/Modality/StudyDate the files carry, if
    none exists yet. `dataset` is already de-identified, so the match and
    the title/date use the de-identified tags; `external_patient_id` is
    the file's real PatientID, from before de-identification, since the
    patient's pseudonym is derived from the real identifier (the same one
    a manually created case uses).

    Serialised per (study, StudyInstanceUID) with a transaction-level
    advisory lock: two workers importing the same new DICOM study at once
    would otherwise both miss the lookup and each create a case (B-03).
    The lock is held until the caller commits -- which it does only after
    this file's ImagingStudy exists, so the next worker finds it.
    """
    lock_key = f"quick-import-case:{study_id}:{dataset.StudyInstanceUID}"
    db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": lock_key})
    existing_imaging_study = (
        db.query(ImagingStudy)
        .join(Case, Case.id == ImagingStudy.case_id)
        .filter(ImagingStudy.study_instance_uid == dataset.StudyInstanceUID, Case.study_id == study_id)
        .first()
    )
    if existing_imaging_study is not None:
        return db.get(Case, existing_imaging_study.case_id), False

    patient = _get_or_create_patient(db, external_patient_id)
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


def run_quick_import(
    study_id: str, staging_keys: list[str], filenames: dict[str, str] | None = None, on_progress=None
) -> dict:
    """Processes every staged file for one quick-import batch, in order.
    Never raises for a single bad file -- each file's own outcome (or
    error) is recorded and the rest of the batch still runs, since one
    corrupt file in a folder of hundreds shouldn't sink the whole import.

    `filenames` maps each staging_key back to the name the browser sent
    (the multipart part's own filename, threaded through by the route --
    see quick_import there) -- used everywhere a file is reported on
    below instead of the staging_key itself, which is a throwaway
    "_staging/<import_id>/<uuid>.dcm" object-storage path with no
    relation to what the person actually selected. Without this, a
    reported error ("uuid.dcm: Missing required DICOM tags: [...]")
    names no file the uploader can recognize or go looking for -- falls
    back to the staging_key's own basename when a mapping is missing
    (an older caller, or a client that genuinely sent no filename).

    `on_progress(index, total, filename)`, if given, is called after
    each file (whether it succeeded, was a duplicate, or errored) --
    the Celery task wires this to `self.update_state` so a caller
    polling GET /ingestion/quick-imports/{id} can show real "N of M"
    progress instead of an indeterminate spinner for what can be a
    multi-hundred-file, multi-minute batch.
    """
    filenames = filenames or {}

    def display_name(staging_key: str) -> str:
        return filenames.get(staging_key) or staging_key.rsplit("/", 1)[-1]

    db: Session = SessionLocal()
    cases: dict[str, dict] = {}  # case_id -> {"title", "created", "instance_count"}
    errors: list[dict] = []
    total = len(staging_keys)

    try:
        for index, staging_key in enumerate(staging_keys):
            try:
                raw = download_staged_file(staging_key)
                # force=True: see app/pipeline.py::ingest_dicom's own
                # comment -- some real-world exports omit the optional
                # preamble/"DICM" magic; the REQUIRED_TAGS check right
                # below still rejects anything that isn't actually DICOM.
                dataset = pydicom.dcmread(io.BytesIO(raw), force=True)

                missing = [tag for tag in REQUIRED_TAGS if tag not in dataset]
                if not hasattr(dataset, "PatientID"):
                    missing = [*missing, "PatientID"]
                if missing:
                    raise DicomValidationError(f"Missing required DICOM tags: {missing}")

                # De-identified before anything is looked up or created, so
                # cases group by the de-identified UIDs and are titled from
                # de-identified tags (B-08/B-09); a rule that can't be
                # applied fails the file here, with nothing created yet.
                # Only the patient's pseudonym still comes from the real ID.
                external_patient_id = str(dataset.PatientID)
                dataset = apply_deidentification_profile(dataset, study_id=study_id)

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

                # A DICOM study already filed in another study: refuse it
                # before a case is made for it here (it would stay empty).
                reason = foreign_imaging_owner(db, dataset, study_id=study_id)
                if reason:
                    raise ForeignImagingError(reason)

                case, created = _resolve_or_create_case(db, study_id, dataset, external_patient_id)
                # One commit for the case AND its first ImagingStudy: that
                # releases the case lock only once another worker's lookup
                # can find this case, and a file that fails below leaves
                # no empty case behind (the rollback takes it too).
                # _get_or_create_* conflicts are confined to savepoints,
                # so they never undo the case.
                result = _ingest_one_instance(db, case, dataset)
                if result["status"] == "duplicate":
                    # another import stored this very instance meanwhile:
                    # drop the case made for it, if any, rather than commit it empty
                    db.rollback()
                    delete_staged_file(staging_key)
                    continue
                db.commit()
                delete_staged_file(staging_key)

                entry = cases.setdefault(str(case.id), {"title": case.title, "created": created, "instance_count": 0})
                if result["status"] == "completed":
                    entry["instance_count"] += 1
            except Exception as exc:
                db.rollback()
                errors.append({"file": display_name(staging_key), "error": str(exc)})
                try:
                    # A failed file is never retried automatically (see
                    # the Celery task's own docstring), so there's
                    # nothing left to stage it for -- best-effort cleanup,
                    # wrapped separately so a delete failure here can
                    # never hide the real error just recorded above.
                    delete_staged_file(staging_key)
                except Exception:
                    pass
            finally:
                # Runs for every file regardless of outcome (success,
                # duplicate-skip via `continue` above, or the except
                # block) -- Python still runs a try's `finally` before a
                # `continue` actually moves the loop on.
                if on_progress is not None:
                    on_progress(index + 1, total, display_name(staging_key))

        return {
            "cases": [{"case_id": cid, **info} for cid, info in cases.items()],
            "instances_ingested": sum(c["instance_count"] for c in cases.values()),
            "errors": errors,
        }
    finally:
        db.close()
