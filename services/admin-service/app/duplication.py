"""Duplicates a Study into a genuinely independent copy.

Every Case/ImagingStudy/Series/Instance/ClinicalDataItem under the source
gets its own new row, every DICOM UID is freshly minted, and every
object-storage payload (pixel data, thumbnails, clinical data files, the
cover image) is really downloaded from its source key and re-uploaded
under a new one -- the result behaves exactly as if it had all been
freshly re-uploaded, not a reference to the original's rows or bytes.
Deleting the source afterwards (or the copy) never touches the other.

Deliberately NOT copied: WorkflowCard/WorkflowEdge (the pipeline is
work-in-progress state, not source data), Annotation/AnnotationReview
(that's the work product of the pipeline), and StudyVersion/AuditLog
history. A duplicated study starts as plain, unprocessed source data --
exactly like a brand-new upload -- with an empty workflow board, ready
for its own pipeline to be built from scratch.

Cases keep pointing at the *same* Patient row rather than cloning it: a
duplicate is still real imaging/documents for the same real person, and
Patient.pseudonym_id / PatientIdentityMap.external_id_hash are both
DB-unique, so a cloned Patient would need a fabricated external identity
with no real re-identification link -- out of scope for what "duplicate
this study's data" means.
"""
import uuid

from botocore.exceptions import ClientError
from shared_auth import CurrentUser
from shared_models.models import (
    Case,
    ClinicalDataItem,
    Consent,
    ImagingStudy,
    Instance,
    Series,
    Study,
    StudyMembership,
    Tag,
)
from sqlalchemy.orm import Session

from app.api import audit
from app.storage import copy_object_bytes
from app.versioning import autosave


def _new_dicom_uid() -> str:
    """A fresh, valid, collision-free DICOM UID with nothing but the
    stdlib: DICOM PS3.5 Annex B reserves the root "2.25" specifically for
    minting a UID from a UUID, so turning uuid4().int into the single
    leaf node under that root is a standards-legal way to get a
    guaranteed-unique UID without a DICOM UID generator dependency."""
    return f"2.25.{uuid.uuid4().int}"


def _copied_key(old_key: str | None, new_prefix: str) -> str | None:
    """Keeps the original filename tail (every upload route in this
    service writes keys as "<prefix>/<uuid>-<filename>") under a new
    prefix, with a fresh uuid of its own -- never collides with the
    source key."""
    if not old_key:
        return None
    tail = old_key.rsplit("/", 1)[-1]
    if "-" in tail:
        tail = tail.split("-", 1)[1]
    return f"{new_prefix}/{uuid.uuid4()}-{tail}"


def _copy_object_best_effort(src_key: str, dst_key: str) -> bool:
    """Same tolerance thumbnail.py's own generator already has for a
    thumbnail that doesn't exist or failed to generate at ingest time:
    a missing thumbnail is never a reason to fail the instance it
    belongs to. Returns whether the copy actually happened."""
    try:
        copy_object_bytes(src_key, dst_key)
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "NoSuchKey":
            return False
        raise


def _unique_study_name(db: Session, base_name: str) -> str:
    """Study.name is DB-unique -- duplicating the same study twice with
    no explicit name would otherwise 500 on the second attempt."""
    name = base_name
    suffix = 2
    while db.query(Study).filter_by(name=name).first() is not None:
        name = f"{base_name} ({suffix})"
        suffix += 1
    return name


def duplicate_study(db: Session, source: Study, user: CurrentUser, new_name: str | None = None) -> Study:
    """Builds, commits and returns the new Study. Not wrapped in a savepoint
    beyond the normal request transaction -- like delete_study's cascade,
    a failure partway through rolls back the whole thing when the route's
    session is torn down on an unhandled exception."""
    name = _unique_study_name(db, new_name or f"{source.name} (copy)")

    new_study = Study(
        name=name,
        description=source.description,
        deidentification_profile_id=source.deidentification_profile_id,
    )
    db.add(new_study)
    db.flush()

    if source.cover_image_key:
        dst_key = _copied_key(source.cover_image_key, f"study-covers/{new_study.id}")
        copy_object_bytes(source.cover_image_key, dst_key)
        new_study.cover_image_key = dst_key

    for membership in db.query(StudyMembership).filter_by(study_id=source.id).all():
        db.add(StudyMembership(study_id=new_study.id, user_id=membership.user_id, role=membership.role))

    for case in db.query(Case).filter_by(study_id=source.id).all():
        new_case = Case(
            study_id=new_study.id,
            patient_id=case.patient_id,
            accession_number=case.accession_number,
            date=case.date,
            type=case.type,
            title=case.title,
            comment=case.comment,
        )
        db.add(new_case)
        db.flush()

        for imaging_study in db.query(ImagingStudy).filter_by(case_id=case.id).all():
            new_imaging_study = ImagingStudy(
                case_id=new_case.id,
                study_instance_uid=_new_dicom_uid(),
                study_date=imaging_study.study_date,
                modality=imaging_study.modality,
                description=imaging_study.description,
            )
            db.add(new_imaging_study)
            db.flush()

            for series in db.query(Series).filter_by(imaging_study_id=imaging_study.id).all():
                new_series = Series(
                    imaging_study_id=new_imaging_study.id,
                    series_instance_uid=_new_dicom_uid(),
                    series_number=series.series_number,
                    body_part=series.body_part,
                    series_description=series.series_description,
                )
                db.add(new_series)
                db.flush()

                for instance in db.query(Instance).filter_by(series_id=series.id).all():
                    new_instance_id = uuid.uuid4()
                    new_sop_uid = _new_dicom_uid()
                    # Same key shape ingestion-service's pipeline.py uses:
                    # "{StudyInstanceUID}/{SeriesInstanceUID}/{SOPInstanceUID}.dcm".
                    new_pixel_key = f"{new_imaging_study.study_instance_uid}/{new_series.series_instance_uid}/{new_sop_uid}.dcm"
                    copy_object_bytes(instance.object_storage_key, new_pixel_key)

                    new_thumbnail_key = None
                    if instance.thumbnail_key:
                        candidate_key = f"thumbnails/{new_instance_id}.png"
                        if _copy_object_best_effort(instance.thumbnail_key, candidate_key):
                            new_thumbnail_key = candidate_key

                    db.add(Instance(
                        id=new_instance_id,
                        series_id=new_series.id,
                        sop_instance_uid=new_sop_uid,
                        instance_number=instance.instance_number,
                        object_storage_key=new_pixel_key,
                        thumbnail_key=new_thumbnail_key,
                        checksum=instance.checksum,
                        rows=instance.rows,
                        columns=instance.columns,
                        pixel_spacing=instance.pixel_spacing,
                        window_center=instance.window_center,
                        window_width=instance.window_width,
                    ))

        for item in db.query(ClinicalDataItem).filter_by(case_id=case.id).all():
            new_key = _copied_key(item.object_storage_key, f"clinical-data/{new_case.id}")
            if item.object_storage_key:
                copy_object_bytes(item.object_storage_key, new_key)
            new_item = ClinicalDataItem(
                case_id=new_case.id,
                date=item.date,
                type=item.type,
                title=item.title,
                object_storage_key=new_key,
            )
            db.add(new_item)
            db.flush()
            for tag in item.tags:
                db.add(Tag(clinical_data_item_id=new_item.id, label=tag.label))
            for consent in item.consents:
                db.add(Consent(clinical_data_item_id=new_item.id, consent_type=consent.consent_type, status=consent.status))

    db.flush()
    audit.record(db, user, "study.duplicate", "study", new_study.id, {"source_study_id": str(source.id), "name": name})
    db.commit()
    autosave(db, new_study.id, user.subject)
    return new_study
