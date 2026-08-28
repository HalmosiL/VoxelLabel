"""Core DICOM ingestion pipeline: parse -> validate -> de-identify -> store -> persist metadata.

Kept separate from the Celery task wrapper (app/tasks.py) so this logic can
be unit-tested directly, without a running Celery worker or broker.
"""
import io
import uuid

import pydicom
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from shared_models.database import SessionLocal
from shared_models.models import Case, ImagingStudy, Instance, Series

from app.deidentify import apply_deidentification_profile
from app.storage import delete_staged_file, download_staged_file, upload_pixel_data, upload_thumbnail
from app.thumbnail import ThumbnailGenerationError, generate_thumbnail

REQUIRED_TAGS = ("StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID")


class DicomValidationError(Exception):
    """Raised when an uploaded file is missing required DICOM tags."""


def ingest_dicom(job_id: str, case_id: str, staging_key: str) -> dict:
    """Process one staged DICOM file end to end. Idempotent: re-ingesting an
    already-known SOPInstanceUID is a no-op that reports "duplicate".

    The staged file is fetched from object storage (not local disk) since
    this runs in a separate container/process from the API that staged it.
    The target Case (and therefore its patient/study) must already
    exist -- identity resolution happens once at case-creation time in
    admin-service, not on every upload.
    """
    # force=True: some real-world DICOM exports omit the optional 128-byte
    # preamble + "DICM" magic bytes pydicom otherwise insists on -- the
    # dataset itself is still perfectly valid, so refusing to read it
    # would reject real files for no reason. This does not weaken the
    # REQUIRED_TAGS check right below: a file that's genuinely not DICOM
    # at all still won't have those tags and gets rejected there instead.
    dataset = pydicom.dcmread(io.BytesIO(download_staged_file(staging_key)), force=True)

    missing = [tag for tag in REQUIRED_TAGS if tag not in dataset]
    if missing:
        raise DicomValidationError(f"Missing required DICOM tags: {missing}")

    db: Session = SessionLocal()
    try:
        case = db.get(Case, case_id)
        dataset = apply_deidentification_profile(dataset, study_id=str(case.study_id))
        result = _ingest_one_instance(db, case, dataset)
        db.commit()
        delete_staged_file(staging_key)
        return {"job_id": job_id, **result}
    finally:
        db.close()


def _ingest_one_instance(db: Session, case: Case, dataset) -> dict:
    """Given an already-resolved Case and a parsed (and de-identified)
    dataset, uploads its pixel data + thumbnail and inserts its Instance
    row -- idempotent by SOPInstanceUID. Shared by the single-file upload
    path above and the multi-file quick-import batch path
    (app/quick_import.py), so "what actually happens to one DICOM file"
    stays in exactly one place. Caller owns the transaction (commit) and
    any staged-file cleanup -- a quick-import batch commits once per
    resolved case, not once per instance.
    """
    existing = db.query(Instance).filter_by(sop_instance_uid=dataset.SOPInstanceUID).first()
    if existing is not None:
        return {"status": "duplicate", "instance_id": str(existing.id)}

    storage_key = f"{dataset.StudyInstanceUID}/{dataset.SeriesInstanceUID}/{dataset.SOPInstanceUID}.dcm"
    upload_pixel_data(storage_key, dataset)

    imaging_study = _get_or_create_imaging_study(db, dataset, case)
    series = _get_or_create_series(db, dataset, imaging_study)

    instance_id = uuid.uuid4()
    thumbnail_key = None
    try:
        thumbnail_key = f"thumbnails/{instance_id}.png"
        upload_thumbnail(thumbnail_key, generate_thumbnail(dataset))
    except ThumbnailGenerationError:
        # A preview image is a nice-to-have, not a requirement for a
        # successful ingest (e.g. an unsupported transfer syntax
        # pydicom can't decode without an extra codec plugin).
        thumbnail_key = None

    instance = Instance(
        id=instance_id,
        series_id=series.id,
        sop_instance_uid=dataset.SOPInstanceUID,
        instance_number=getattr(dataset, "InstanceNumber", None),
        object_storage_key=storage_key,
        thumbnail_key=thumbnail_key,
        rows=getattr(dataset, "Rows", None),
        columns=getattr(dataset, "Columns", None),
    )
    db.add(instance)
    db.flush()
    return {"status": "completed", "instance_id": str(instance.id)}


def _get_or_create_imaging_study(db: Session, dataset, case: Case) -> ImagingStudy:
    imaging_study = db.query(ImagingStudy).filter_by(study_instance_uid=dataset.StudyInstanceUID).first()
    if imaging_study is not None:
        return imaging_study

    imaging_study = ImagingStudy(
        case_id=case.id,
        study_instance_uid=dataset.StudyInstanceUID,
        modality=getattr(dataset, "Modality", None),
        description=getattr(dataset, "StudyDescription", None),
    )
    db.add(imaging_study)
    try:
        db.flush()
    except IntegrityError:
        # Another worker won the race and inserted this same
        # study_instance_uid first (its own unique constraint) -- this is
        # the fix for a known bug (see project memory, 2026-08-22 entry):
        # concurrent uploads for a brand-new series used to raise
        # uncaught here and silently drop the losing instance. Roll back
        # this half-done insert and use the winner's row instead.
        db.rollback()
        imaging_study = db.query(ImagingStudy).filter_by(study_instance_uid=dataset.StudyInstanceUID).first()
    return imaging_study


def _get_or_create_series(db: Session, dataset, imaging_study: ImagingStudy) -> Series:
    series = db.query(Series).filter_by(series_instance_uid=dataset.SeriesInstanceUID).first()
    if series is not None:
        return series

    series = Series(
        imaging_study_id=imaging_study.id,
        series_instance_uid=dataset.SeriesInstanceUID,
        series_number=getattr(dataset, "SeriesNumber", None),
        body_part=getattr(dataset, "BodyPartExamined", None),
        series_description=getattr(dataset, "SeriesDescription", None),
    )
    db.add(series)
    try:
        db.flush()
    except IntegrityError:
        # Same race as _get_or_create_imaging_study, one level down.
        db.rollback()
        series = db.query(Series).filter_by(series_instance_uid=dataset.SeriesInstanceUID).first()
    return series
