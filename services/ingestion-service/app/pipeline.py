"""Core DICOM ingestion pipeline: parse -> validate -> de-identify -> store -> persist metadata.

Kept separate from the Celery task wrapper (app/tasks.py) so this logic can
be unit-tested directly, without a running Celery worker or broker.
"""
import io
import uuid

import pydicom
from pydicom.dataset import FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRBigEndian, ExplicitVRLittleEndian, ImplicitVRLittleEndian
from shared_models.database import SessionLocal
from shared_models.models import Case, ImagingStudy, Instance, Series
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.deidentify import apply_deidentification_profile
from app.storage import delete_staged_file, download_staged_file, upload_pixel_data, upload_thumbnail
from app.thumbnail import ThumbnailGenerationError, generate_thumbnail

REQUIRED_TAGS = ("StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID")


class DicomValidationError(Exception):
    """Raised when an uploaded file is missing required DICOM tags."""


class ForeignImagingError(DicomValidationError):
    """The file's DICOM study or series already belongs to another case
    (possibly in another study). StudyInstanceUID/SeriesInstanceUID are
    unique platform-wide, so ingesting it would attach the images to that
    other case -- somewhere the uploader may not even have access to."""


def foreign_imaging_owner(db: Session, dataset, case: Case | None = None, study_id: str | None = None) -> str | None:
    """Why this file can't go into `case` (or, before a case is chosen, into
    `study_id`), or None when it can: its StudyInstanceUID or
    SeriesInstanceUID is already filed under a different case."""
    imaging = db.query(ImagingStudy).filter_by(study_instance_uid=dataset.StudyInstanceUID).first()
    if imaging is not None:
        if case is not None and imaging.case_id != case.id:
            return "This DICOM study is already filed under another case" + (
                " in a different study" if imaging.case.study_id != case.study_id else ""
            )
        if case is None and study_id is not None and str(imaging.case.study_id) != str(study_id):
            return "This DICOM study is already filed under a case in a different study"
    series = db.query(Series).filter_by(series_instance_uid=dataset.SeriesInstanceUID).first()
    if series is not None:
        owner = series.imaging_study
        if owner.study_instance_uid != dataset.StudyInstanceUID:
            return "This DICOM series already belongs to a different DICOM study"
        if case is not None and owner.case_id != case.id:
            return "This DICOM series is already filed under another case"
        if case is None and study_id is not None and str(owner.case.study_id) != str(study_id):
            return "This DICOM series is already filed under a case in a different study"
    return None


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


def duplicate_result(existing: Instance, *, study_id, case_id=None) -> dict:
    """What an upload of an instance that is already imported reports:
    where it is -- "this_case", "this_study" or "another_study" (a DICOM
    instance belongs to one study only). The existing instance's id only
    when it is in the same study: it isn't the uploader's to see
    otherwise. Before, the case page read every duplicate as "already in
    this case" (B-21) and the quick import skipped them silently (B-17)."""
    owner_case = existing.series.imaging_study.case
    if case_id is not None and owner_case.id == case_id:
        return {"status": "duplicate", "where": "this_case", "instance_id": str(existing.id)}
    if str(owner_case.study_id) == str(study_id):
        return {"status": "duplicate", "where": "this_study", "instance_id": str(existing.id)}
    return {"status": "duplicate", "where": "another_study"}


def _check_image_data(dataset) -> None:
    """Refuses a file whose image data can't be decoded -- cut short,
    damaged, or in an encoding no installed decoder handles. It used to
    be "imported", then every render of it failed and it broke the whole
    series' 3D views (B-06). The decoded array is kept on the dataset, so
    the thumbnail reuses it."""
    if "PixelData" not in dataset:
        return
    try:
        dataset.pixel_array  # noqa: B018 -- decoding is the check
    except Exception as exc:  # noqa: BLE001 -- any decoder failure means the same to the uploader
        raise DicomValidationError(f"The image data can't be read -- the file may be cut short or damaged ({exc})") from exc


def _ensure_file_meta(dataset) -> None:
    """Fills in the File Meta header a file was uploaded without (no
    preamble, no group 0002 -- read with force=True), so it can be stored
    as a standard DICOM file (see storage.dicom_file_bytes, B-07)."""
    meta = getattr(dataset, "file_meta", None)
    if meta is not None and "TransferSyntaxUID" in meta:
        meta.MediaStorageSOPInstanceUID = dataset.SOPInstanceUID
        return
    implicit, little = getattr(dataset, "original_encoding", (True, True))
    new = FileMetaDataset()
    new.MediaStorageSOPClassUID = dataset.get("SOPClassUID", CTImageStorage)
    new.MediaStorageSOPInstanceUID = dataset.SOPInstanceUID
    if implicit is False:
        new.TransferSyntaxUID = ExplicitVRLittleEndian if little is not False else ExplicitVRBigEndian
    else:
        new.TransferSyntaxUID = ImplicitVRLittleEndian
    dataset.file_meta = new


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
    # Serialised per SOP Instance UID for the rest of the caller's
    # transaction: a second worker with the same instance waits here, then
    # finds it below and reports "duplicate" -- before storing anything.
    # Unlocked, it failed with a raw IntegrityError after having uploaded
    # (possibly overwritten) the pixel data and a thumbnail (B-05).
    db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": f"sop:{dataset.SOPInstanceUID}"})
    existing = db.query(Instance).filter_by(sop_instance_uid=dataset.SOPInstanceUID).first()
    if existing is not None:
        return duplicate_result(existing, case_id=case.id, study_id=case.study_id)
    # Before anything is stored: never attach the images to someone else's case.
    reason = foreign_imaging_owner(db, dataset, case=case)
    if reason:
        raise ForeignImagingError(reason)

    _ensure_file_meta(dataset)  # first: decoding needs the transfer syntax
    _check_image_data(dataset)
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


def _get_or_create(db: Session, model, lookup: dict, build_row):
    """Find-or-insert a row by a unique key, safe under concurrent workers.

    Two Celery workers ingesting files of the same brand-new study/series
    at once both see "doesn't exist yet" and both try to INSERT; the
    loser's INSERT fails on the unique constraint. That failure is
    confined to a SAVEPOINT (`begin_nested`), so only the failed INSERT
    is undone and the rest of the caller's transaction survives -- a
    plain `db.rollback()` here would discard *everything* flushed so far
    in this transaction, which for the quick-import batch path (many
    instances per commit, see app/quick_import.py) would silently drop
    every already-processed instance of the batch. After the savepoint
    rolls back, the winner's row (committed by then -- Postgres blocks
    the losing INSERT on the unique index until the winner commits) is
    re-read and used instead.
    """
    row = db.query(model).filter_by(**lookup).first()
    if row is not None:
        return row
    try:
        with db.begin_nested():
            row = build_row()
            db.add(row)
            db.flush()
        return row
    except IntegrityError:
        db.expire_all()
        row = db.query(model).filter_by(**lookup).first()
        if row is None:  # not a unique-key race after all -- surface it
            raise
        return row


def _get_or_create_imaging_study(db: Session, dataset, case: Case) -> ImagingStudy:
    return _get_or_create(
        db,
        ImagingStudy,
        {"study_instance_uid": dataset.StudyInstanceUID},
        lambda: ImagingStudy(
            case_id=case.id,
            study_instance_uid=dataset.StudyInstanceUID,
            modality=getattr(dataset, "Modality", None),
            description=getattr(dataset, "StudyDescription", None),
        ),
    )


def _get_or_create_series(db: Session, dataset, imaging_study: ImagingStudy) -> Series:
    return _get_or_create(
        db,
        Series,
        {"series_instance_uid": dataset.SeriesInstanceUID},
        lambda: Series(
            imaging_study_id=imaging_study.id,
            series_instance_uid=dataset.SeriesInstanceUID,
            series_number=getattr(dataset, "SeriesNumber", None),
            body_part=getattr(dataset, "BodyPartExamined", None),
            series_description=getattr(dataset, "SeriesDescription", None),
        ),
    )
