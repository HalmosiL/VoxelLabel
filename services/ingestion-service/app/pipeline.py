"""Core DICOM ingestion pipeline: parse -> validate -> de-identify -> store -> persist metadata.

Kept separate from the Celery task wrapper (app/tasks.py) so this logic can
be unit-tested directly, without a running Celery worker or broker.
"""
import hashlib
import io
import uuid

import pydicom
from sqlalchemy.orm import Session

from shared_models.database import SessionLocal
from shared_models.models import Instance, Patient, PatientIdentityMap, Series, Study

from app.deidentify import apply_deidentification_profile
from app.storage import delete_staged_file, download_staged_file, upload_pixel_data

REQUIRED_TAGS = ("StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID")


class DicomValidationError(Exception):
    """Raised when an uploaded file is missing required DICOM tags."""


def ingest_dicom(job_id: str, project_id: str, staging_key: str) -> dict:
    """Process one staged DICOM file end to end. Idempotent: re-ingesting an
    already-known SOPInstanceUID is a no-op that reports "duplicate".

    The staged file is fetched from object storage (not local disk) since
    this runs in a separate container/process from the API that staged it.
    """
    dataset = pydicom.dcmread(io.BytesIO(download_staged_file(staging_key)))

    missing = [tag for tag in REQUIRED_TAGS if tag not in dataset]
    if missing:
        raise DicomValidationError(f"Missing required DICOM tags: {missing}")

    dataset = apply_deidentification_profile(dataset, project_id=project_id)

    db: Session = SessionLocal()
    try:
        existing = db.query(Instance).filter_by(sop_instance_uid=dataset.SOPInstanceUID).first()
        if existing is not None:
            delete_staged_file(staging_key)
            return {"job_id": job_id, "status": "duplicate", "instance_id": str(existing.id)}

        storage_key = f"{dataset.StudyInstanceUID}/{dataset.SeriesInstanceUID}/{dataset.SOPInstanceUID}.dcm"
        upload_pixel_data(storage_key, dataset)

        patient = _get_or_create_patient(db, dataset)
        study = _get_or_create_study(db, dataset, patient, project_id)
        series = _get_or_create_series(db, dataset, study)

        instance = Instance(
            series_id=series.id,
            sop_instance_uid=dataset.SOPInstanceUID,
            instance_number=getattr(dataset, "InstanceNumber", None),
            object_storage_key=storage_key,
            rows=getattr(dataset, "Rows", None),
            columns=getattr(dataset, "Columns", None),
        )
        db.add(instance)
        db.commit()
        delete_staged_file(staging_key)
        return {"job_id": job_id, "status": "completed", "instance_id": str(instance.id)}
    finally:
        db.close()


def _get_or_create_patient(db: Session, dataset) -> Patient:
    """Look up or create a pseudonymized patient record.

    The mapping from the real PatientID to a pseudonym lives only in
    PatientIdentityMap (access-restricted); this hash is a lookup key, not
    a re-identification mechanism on its own. Final hashing/salting
    strategy is pending the compliance decision noted in ARCHITECTURE.md.
    """
    external_id_hash = hashlib.sha256(str(getattr(dataset, "PatientID", "")).encode()).hexdigest()

    mapping = db.query(PatientIdentityMap).filter_by(external_id_hash=external_id_hash).first()
    if mapping is not None:
        return db.get(Patient, mapping.patient_id)

    patient = Patient(pseudonym_id=str(uuid.uuid4()))
    db.add(patient)
    db.flush()
    db.add(PatientIdentityMap(patient_id=patient.id, external_id_hash=external_id_hash))
    return patient


def _get_or_create_study(db: Session, dataset, patient: Patient, project_id: str) -> Study:
    study = db.query(Study).filter_by(study_instance_uid=dataset.StudyInstanceUID).first()
    if study is None:
        study = Study(
            project_id=project_id,
            patient_id=patient.id,
            study_instance_uid=dataset.StudyInstanceUID,
            modality=getattr(dataset, "Modality", None),
            description=getattr(dataset, "StudyDescription", None),
        )
        db.add(study)
        db.flush()
    return study


def _get_or_create_series(db: Session, dataset, study: Study) -> Series:
    series = db.query(Series).filter_by(series_instance_uid=dataset.SeriesInstanceUID).first()
    if series is None:
        series = Series(
            study_id=study.id,
            series_instance_uid=dataset.SeriesInstanceUID,
            series_number=getattr(dataset, "SeriesNumber", None),
            body_part=getattr(dataset, "BodyPartExamined", None),
            series_description=getattr(dataset, "SeriesDescription", None),
        )
        db.add(series)
        db.flush()
    return series
