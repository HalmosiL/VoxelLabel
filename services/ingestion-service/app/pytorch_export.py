"""Builds a PyTorch-ready export of a chosen set of cases.

Every imaging Series is decoded straight to a real-HU-value numpy array
(RescaleSlope/RescaleIntercept applied, slices ordered by InstanceNumber)
and uploaded as a plain `.npy` file -- not a DICOM/NIfTI file the consumer
would still have to decode themselves. Every recorded annotation for the
case is included in the manifest as-is.

Deliberately does not attempt to rasterize a segmentation-mask annotation
into an array aligned with its image: `Annotation.payload`'s own
docstring (shared_models/models.py) says a large mask is "stored in
object storage with just a reference inside payload", but no code
anywhere in this repo actually writes that reference -- the real
convention, if any, is owned by the sibling ct-annotator client, not
inspected here. Rather than guess at a schema, this passes every
`payload` through verbatim (with its AnnotationType's own JSON Schema
alongside it, so a consumer can interpret it), and best-effort resolves
any key that *looks* like an object-storage reference (see
`_STORAGE_REFERENCE_KEYS`) to a real presigned URL -- so whatever
ct-annotator ends up storing there is still reachable without this
module hardcoding one assumed mask format.
"""
import io
import json
import uuid
from datetime import datetime, timezone

import numpy as np
import pydicom
from sqlalchemy.orm import Session

from shared_models.database import SessionLocal
from shared_models.models import (
    Annotation,
    AnnotationStatus,
    AnnotationType,
    Case,
    ImagingStudy,
    Instance,
    Series,
    case_tags,
)

from app.storage import download_object, upload_export_object

# The same "counts as a real, usable annotation" convention admin-
# service's own workflow.py uses (_ANNOTATED_STATUSES) -- kept in sync
# by hand, since ingestion-service can't import admin-service's code
# (separate deployable services, each with their own dependencies).
_ANNOTATED_STATUSES = (AnnotationStatus.SUBMITTED, AnnotationStatus.APPROVED)

# Payload keys that plausibly hold an object-storage reference to a large
# annotation asset (e.g. a segmentation mask) -- see this module's own
# docstring for why this is a best-effort guess, not one hardcoded schema.
# `mask_volume_key` is ct-annotator's real key for its segmentation_volume
# payloads (confirmed live against this platform's own data); the rest
# are speculative fallbacks for any other annotation type that follows
# the same naming instinct.
_STORAGE_REFERENCE_KEYS = ("mask_volume_key", "object_storage_key", "storage_key", "mask_key", "mask_object_storage_key")


def build_pytorch_export(export_id: str, case_ids: list[str]) -> dict:
    """Runs synchronously inside the Celery worker (see app/tasks.py).
    Writes one `.npy` per Series plus one `exports/{export_id}/
    manifest.json` to object storage, and also returns the manifest as
    this task's own return value (visible via Celery's AsyncResult while
    it's still fresh in Redis) -- but the object-storage copy is the
    durable source of truth the API polls (see get_pytorch_export),
    since a Celery result can be evicted from Redis long before anyone
    checks on a slow export.
    """
    db: Session = SessionLocal()
    try:
        manifest = {
            "export_id": export_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "cases": [],
        }
        for case_id in case_ids:
            case = db.get(Case, uuid.UUID(case_id))
            if case is None:
                continue
            manifest["cases"].append(_export_one_case(db, case, export_id))
        manifest["case_count"] = len(manifest["cases"])

        upload_export_object(f"exports/{export_id}/manifest.json", json.dumps(manifest).encode("utf-8"))
        return manifest
    finally:
        db.close()


def _export_one_case(db: Session, case: Case, export_id: str) -> dict:
    series_entries = []
    for imaging_study in db.query(ImagingStudy).filter_by(case_id=case.id).all():
        for series in db.query(Series).filter_by(imaging_study_id=imaging_study.id).all():
            entry = _export_one_series(db, series, imaging_study, export_id, case.id)
            if entry is not None:
                series_entries.append(entry)

    return {
        "case_id": str(case.id),
        # title/comment are deliberately excluded: both are free-text
        # fields that could carry PHI (see this module's own caller,
        # the export API route, for the same reasoning) -- only the
        # structured tag labels are included.
        "tags": case_tags(case),
        "series": series_entries,
        "annotations": _case_annotations(db, case),
    }


def _export_one_series(db: Session, series: Series, imaging_study: ImagingStudy, export_id: str, case_id) -> dict | None:
    instances = (
        db.query(Instance)
        .filter_by(series_id=series.id)
        .order_by(Instance.instance_number.asc().nulls_last())
        .all()
    )
    if not instances:
        return None

    slices = []
    spacing_xy = None
    slice_thickness = 1.0
    for i, instance in enumerate(instances):
        dataset = pydicom.dcmread(io.BytesIO(download_object(instance.object_storage_key)))
        slope = float(getattr(dataset, "RescaleSlope", 1.0))
        intercept = float(getattr(dataset, "RescaleIntercept", 0.0))
        slices.append(dataset.pixel_array.astype(np.float32) * slope + intercept)
        if i == 0:
            if hasattr(dataset, "PixelSpacing"):
                spacing_xy = [float(v) for v in dataset.PixelSpacing]
            slice_thickness = float(getattr(dataset, "SliceThickness", 1.0))

    volume = np.stack(slices, axis=0).astype(np.float32)
    image_key = f"exports/{export_id}/{case_id}/{series.id}.npy"
    upload_export_object(image_key, _npy_bytes(volume))

    return {
        "series_id": str(series.id),
        "modality": imaging_study.modality,
        "body_part": series.body_part,
        "image_key": image_key,
        "shape": list(volume.shape),
        # [slice thickness, row spacing, column spacing] -- the MONAI/
        # NIfTI convention of z-first, matching the array's own axis 0.
        "spacing": [slice_thickness] + (spacing_xy or [1.0, 1.0]),
    }


def _npy_bytes(array: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    np.save(buffer, array)
    return buffer.getvalue()


def _case_annotations(db: Session, case: Case) -> list[dict]:
    """The case's current annotations -- one per (target_type, target_id),
    whichever version is latest -- across every Series/Instance the case
    has. Mirrors admin-service's own _latest_annotation_per_case (app/
    api/workflow.py), simplified: this export has no notion of "since a
    workflow card was created", it always wants the current state of
    everything in scope. No Annotation ever has target_type == "study" in
    this codebase (see that same docstring), so only series/instance are
    queried.
    """
    series_ids = []
    for imaging_study in db.query(ImagingStudy).filter_by(case_id=case.id).all():
        series_ids.extend(s.id for s in db.query(Series).filter_by(imaging_study_id=imaging_study.id).all())
    instance_ids = []
    for series_id in series_ids:
        instance_ids.extend(i.id for i in db.query(Instance).filter_by(series_id=series_id).all())

    target_ids = set(series_ids) | set(instance_ids)
    if not target_ids:
        return []

    rows = (
        db.query(Annotation)
        .filter(Annotation.target_id.in_(target_ids), Annotation.status.in_(_ANNOTATED_STATUSES))
        .order_by(Annotation.created_at.asc())
        .all()
    )
    # Last one wins per (target_type, target_id) -- the same "current
    # version" convention used everywhere else annotation history is
    # collapsed down to "the one that counts now".
    latest_by_target: dict[tuple, Annotation] = {}
    for row in rows:
        latest_by_target[(row.target_type, row.target_id)] = row

    types_by_id = {t.id: t for t in db.query(AnnotationType).all()}
    result = []
    for annotation in latest_by_target.values():
        annotation_type = types_by_id.get(annotation.type_id)
        result.append(
            {
                "target_type": annotation.target_type,
                "target_id": str(annotation.target_id),
                "type_name": annotation_type.name if annotation_type else None,
                "type_schema": annotation_type.json_schema if annotation_type else None,
                "status": annotation.status.value,
                "payload": annotation.payload,
                "asset_keys": _find_storage_references(annotation.payload),
            }
        )
    return result


def _find_storage_references(payload: dict) -> dict:
    """Best-effort: any payload key that looks like an object-storage
    reference (see _STORAGE_REFERENCE_KEYS, and this module's own
    docstring) is surfaced here so the export API layer can resolve it
    to a real presigned URL -- without this module assuming one
    specific mask-storage schema."""
    return {key: payload[key] for key in _STORAGE_REFERENCE_KEYS if isinstance(payload.get(key), str)}
