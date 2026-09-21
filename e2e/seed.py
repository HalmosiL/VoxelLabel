#!/usr/bin/env python3
"""Provisions everything e2e/fixtures.js assumes exists, against a freshly
booted stack -- CI's `e2e` job runs this once before e2e/run.sh. Reproduces
exactly what e2e/README.md's "What they assume" section says to build by
hand: a study, one membership per role, a case with a real uploaded DICOM
series, an all-cases Dataset wired into an Annotation card (assigned to the
annotator) and a Review card (assigned to the reviewer).

Writes the real ids it creates to e2e/fixtures.generated.json; fixtures.js
loads that over its hardcoded local-dev defaults when present, so local
devs are unaffected and CI gets correct ids every run. Safe to re-run
against a stack that already has these users (a 409 on user creation is
treated as "already exists", not an error).

    KC=... ADMIN=... DATA=... INGESTION=... python e2e/seed.py   # override any base URL
    python e2e/seed.py                                            # defaults match fixtures.js
"""
import gzip
import io
import json
import os
import sys
import time
import uuid

import boto3
import httpx
import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

KC = os.environ.get("KC", "http://localhost:8080")
ADMIN = os.environ.get("ADMIN", "http://localhost:8004")
DATA = os.environ.get("DATA", "http://localhost:8002")
INGESTION = os.environ.get("INGESTION", "http://localhost:8001")
ANNOTATION = os.environ.get("ANNOTATION", "http://localhost:8003")
OBJECT_STORAGE_ENDPOINT = os.environ.get("OBJECT_STORAGE_ENDPOINT", "http://localhost:9000")
OBJECT_STORAGE_BUCKET = os.environ.get("OBJECT_STORAGE_BUCKET", "ct-pixel-data")
REALM = os.environ.get("KEYCLOAK_REALM", "ct-platform")
CLIENT_ID = os.environ.get("KEYCLOAK_CLIENT_ID", "ct-platform")

ADMIN_USERNAME, ADMIN_PASSWORD = "platform-admin", "platform-admin"
ANNOTATOR = {"username": "dr-test", "password": "Test1234!", "email": "dr-test@local"}
REVIEWER = {"username": "dr-review", "password": "Test1234!", "email": "dr-review@local"}
STUDY_NAME = "LIDC-IDRI Real CT Sample"


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def wait_for_keycloak() -> None:
    for _ in range(60):
        try:
            if httpx.get(f"{KC}/realms/master", timeout=5).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(2)
    raise RuntimeError("Keycloak never came up")


def token_for(username: str, password: str) -> str:
    r = httpx.post(
        f"{KC}/realms/{REALM}/protocol/openid-connect/token",
        data={"client_id": CLIENT_ID, "grant_type": "password", "username": username, "password": password},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def ensure_user(admin_token: str, username: str, email: str, password: str) -> str:
    """Creates the user if missing, then resets their password to a
    non-temporary one either way -- a freshly created user's password is
    always temporary (see admin-service's keycloak_admin.create_user),
    which blocks the direct password grant every e2e spec uses to log in."""
    r = httpx.post(
        f"{ADMIN}/admin/users",
        headers=_auth(admin_token),
        json={"username": username, "email": email, "first_name": username, "last_name": "e2e", "password": password, "is_admin": False},
        timeout=30,
    )
    if r.status_code == 409:
        directory = httpx.get(f"{ADMIN}/admin/keycloak-users", headers=_auth(admin_token), timeout=30).json()
        user_id = next(u["id"] for u in directory if u["username"] == username)
    else:
        r.raise_for_status()
        user_id = r.json()["id"]

    httpx.post(
        f"{ADMIN}/admin/users/{user_id}/reset-password",
        headers=_auth(admin_token),
        json={"password": password, "temporary": False},
        timeout=30,
    ).raise_for_status()
    return user_id


def admin_subject(admin_token: str) -> str:
    directory = httpx.get(f"{ADMIN}/admin/keycloak-users", headers=_auth(admin_token), timeout=30).json()
    return next(u["id"] for u in directory if u["username"] == ADMIN_USERNAME)


def create_study(admin_token: str, name: str) -> str:
    r = httpx.post(f"{ADMIN}/admin/studies", headers=_auth(admin_token), params={"name": name}, timeout=30)
    r.raise_for_status()
    return r.json()["id"]


def add_member(admin_token: str, study_id: str, user_id: str, role: str) -> None:
    httpx.post(
        f"{ADMIN}/admin/studies/{study_id}/members", headers=_auth(admin_token), params={"user_id": user_id, "role": role}, timeout=30
    ).raise_for_status()


def create_case(admin_token: str, study_id: str) -> str:
    r = httpx.post(
        f"{ADMIN}/admin/studies/{study_id}/cases",
        headers=_auth(admin_token),
        params={"external_patient_id": f"e2e-patient-{uuid.uuid4()}", "title": "e2e seeded case"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["id"]


SLICE_COUNT = 8  # 1 would ingest as a scout/localizer -- see synthetic_dicom_bytes


def synthetic_dicom_bytes(study_uid: str, series_uid: str, instance_number: int) -> bytes:
    """One genuinely valid CT slice of a real multi-slice stack, built in
    memory -- real enough for the ingestion pipeline and the viewer (MPR
    panes, window/level, HU readout) to work against, without shipping a
    binary fixture file or depending on sample data outside this repo.
    Called once per slice, sharing `study_uid`/`series_uid` across calls
    -- ct-annotator's sagittal/coronal reconstruction 422s a series with
    fewer than 2 images or a shared/duplicate instance_number (it reads
    as a scout/localizer, see ct-annotator/backend/app/main.py's
    _get_volume), so a single-instance upload isn't enough."""
    rows = cols = 64
    pixels = ((np.fromfunction(lambda y, x: (x + y) * 4 + instance_number * 10, (rows, cols)) % 2000) - 1000).astype(np.int16)

    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"  # CT Image Storage
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = file_meta
    ds.SOPClassUID = file_meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.PatientID = f"e2e-{uuid.uuid4().hex[:8]}"
    ds.PatientName = "E2E^Synthetic"
    ds.Modality = "CT"
    ds.Rows, ds.Columns = rows, cols
    ds.BitsAllocated = ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 1
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.RescaleIntercept = 0
    ds.RescaleSlope = 1
    ds.WindowCenter = 40
    ds.WindowWidth = 400
    ds.PixelSpacing = [1.0, 1.0]
    ds.SliceThickness = 1.0
    ds.ImagePositionPatient = [0.0, 0.0, float(instance_number)]
    ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    ds.InstanceNumber = instance_number
    ds.PixelData = pixels.tobytes()
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


def upload_and_wait(admin_token: str, case_id: str) -> None:
    study_uid, series_uid = generate_uid(), generate_uid()
    for instance_number in range(1, SLICE_COUNT + 1):
        files = {"file": (f"e2e-synthetic-{instance_number}.dcm", synthetic_dicom_bytes(study_uid, series_uid, instance_number), "application/dicom")}
        r = httpx.post(f"{INGESTION}/ingestion/cases/{case_id}/upload", headers=_auth(admin_token), files=files, timeout=30)
        r.raise_for_status()
        job_id = r.json()["job_id"]
        for _ in range(60):
            status = httpx.get(f"{INGESTION}/ingestion/jobs/{job_id}", headers=_auth(admin_token), timeout=30).json()
            if status["status"] == "completed":
                break
            if status["status"] == "failed":
                raise RuntimeError(f"Seed DICOM upload failed: {status}")
            time.sleep(2)
        else:
            raise RuntimeError("Seed DICOM upload never completed")


def series_for_case(admin_token: str, case_id: str) -> str:
    r = httpx.get(f"{DATA}/data/cases/{case_id}/series", headers=_auth(admin_token), timeout=30)
    r.raise_for_status()
    return r.json()[0]["id"]


def create_card(admin_token: str, study_id: str, **body) -> str:
    r = httpx.post(f"{ADMIN}/admin/studies/{study_id}/workflow/cards", headers=_auth(admin_token), json=body, timeout=30)
    r.raise_for_status()
    return r.json()["id"]


def connect(admin_token: str, study_id: str, source_card_id: str, target_card_id: str) -> None:
    httpx.post(
        f"{ADMIN}/admin/studies/{study_id}/workflow/edges",
        headers=_auth(admin_token),
        json={"source_card_id": source_card_id, "target_card_id": target_card_id},
        timeout=30,
    ).raise_for_status()


def submit_annotation(annotator_token: str, study_id: str, series_id: str) -> None:
    """Directly creates one real, SUBMITTED segmentation_volume Annotation
    on `series_id` -- bypassing ct-annotator/backend's own save endpoint,
    but not the object storage write it does: opening this case for real
    (tour.spec.js does, read-only) fetches GET /mask-volume, which reads
    the blob straight out of MinIO at mask_volume_key, so a fabricated
    key 404s and breaks the page. Upload a real (if trivial) gzip volume
    -- one object id (1) painted into every voxel, matching SLICE_COUNT
    -- under the same annotation-masks/ prefix ct-annotator/backend's own
    upload_mask_volume uses, and reference that key.

    Several specs (tour.spec.js, viewas-viewer.spec.js) read the Review
    job before doing anything themselves and crash if it's empty -- see
    status.py's _cases_with_annotated_status, which drops a Review
    card's case entirely once it has *never* had anything submitted. On
    a hand-maintained long-lived sandbox that's always accidentally true
    by the time anyone runs those specs; on a fresh seed it isn't unless
    something creates it up front."""
    rows = cols = 64
    volume_bytes = np.full(rows * cols * SLICE_COUNT, 1, dtype=np.uint8).tobytes()
    s3 = boto3.client("s3", endpoint_url=OBJECT_STORAGE_ENDPOINT, aws_access_key_id="minioadmin", aws_secret_access_key="minioadmin")
    mask_key = f"annotation-masks/{uuid.uuid4()}.gz"
    s3.put_object(Bucket=OBJECT_STORAGE_BUCKET, Key=mask_key, Body=gzip.compress(volume_bytes), ContentType="application/gzip")

    payload = {
        "mask_volume_key": mask_key,
        "labels": [{"id": 1, "name": "Nodule", "color": "#ff4d4f"}],
        "objects": [{"id": 1, "label_id": 1, "instance_number": 1, "locked": False, "hidden": False}],
    }
    r = httpx.post(
        f"{ANNOTATION}/annotations/studies/{study_id}",
        headers=_auth(annotator_token),
        params={"target_type": "series", "target_id": series_id, "type_name": "segmentation_volume", "status": "submitted"},
        json=payload,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["id"]


def reject_annotation(reviewer_token: str, annotation_id: str, comment: str) -> None:
    """Rejects `annotation_id` with `comment` -- tour.spec.js's job-page
    tour only shows its "here's what the reviewer said" step once some
    case in the job has a real rejection to point at, same underlying
    cause as submit_annotation's own docstring."""
    r = httpx.post(
        f"{ANNOTATION}/annotations/{annotation_id}/review",
        headers=_auth(reviewer_token),
        params={"decision": "reject", "comment": comment},
        timeout=30,
    )
    r.raise_for_status()


def approve_annotation(reviewer_token: str, annotation_id: str) -> None:
    """Approves `annotation_id` -- gives pipeline-health one genuinely
    completed Annotation-then-Review cycle (both legs' terminal action
    reached) so its cycle-time/bottleneck/learning-curve reads have real
    data on a fresh seed, not just the one open (rejected, still
    pending re-annotation) case reject_annotation leaves behind."""
    r = httpx.post(
        f"{ANNOTATION}/annotations/{annotation_id}/review",
        headers=_auth(reviewer_token),
        params={"decision": "approve"},
        timeout=30,
    )
    r.raise_for_status()


def run_card(admin_token: str, card_id: str) -> None:
    """Populates `card`'s output_case_ids (and ripples the same downstream
    -- see run_card_with_ripple) so its cases actually show up via
    GET /admin/my-jobs; wiring a Dataset into Annotation/Review with
    `connect()` alone leaves both empty until something Runs the board,
    exactly as clicking Run in the UI would. Must be called on the
    Annotation card, not the root all_cases Dataset -- an "all_cases"
    Dataset's own output is computed live on every read regardless of
    Run state (Run is only for a Dataset chained off another card), so
    Running it 422s with "requires exactly one incoming connection"."""
    httpx.post(f"{ADMIN}/admin/workflow-cards/{card_id}/run", headers=_auth(admin_token), timeout=30).raise_for_status()


def main() -> None:
    wait_for_keycloak()
    admin_token = token_for(ADMIN_USERNAME, ADMIN_PASSWORD)

    annotator_id = ensure_user(admin_token, ANNOTATOR["username"], ANNOTATOR["email"], ANNOTATOR["password"])
    reviewer_id = ensure_user(admin_token, REVIEWER["username"], REVIEWER["email"], REVIEWER["password"])

    study_id = create_study(admin_token, STUDY_NAME)
    add_member(admin_token, study_id, annotator_id, "annotator")
    add_member(admin_token, study_id, reviewer_id, "reviewer")

    # Several specs each grab "the" pending case off the Annotation job
    # (job.cases.find(c => c.status !== "done")) and carry it through a
    # real annotate/submit/review cycle -- tour.spec.js, viewer.spec.js
    # and viewas-viewer.spec.js all do this independently. A single
    # seeded case works for a hand-maintained long-lived sandbox (each
    # spec run days apart), but run back-to-back against one fresh case
    # they race for it and whichever runs later finds it already
    # consumed. CASE_COUNT gives each of those, plus every fixed
    # F.CASE/F.SERIES reference (audit-log, review-round, tablet,
    # viewer-handoff -- none of which need a *pristine* case, just a
    # real one), enough independent cases that nobody comes up empty.
    CASE_COUNT = 6
    case_ids = []
    for _ in range(CASE_COUNT):
        cid = create_case(admin_token, study_id)
        upload_and_wait(admin_token, cid)
        case_ids.append(cid)
    case_id = case_ids[0]
    series_id = series_for_case(admin_token, case_id)

    dataset_id = create_card(admin_token, study_id, type="dataset", title="Dataset", position_x=0, position_y=0, config={"mode": "all_cases"})
    annot_card_id = create_card(
        admin_token, study_id, type="annotation", title="Annotation", position_x=300, position_y=0,
        config={"status": "todo", "assigned_user_id": annotator_id},
    )
    review_card_id = create_card(
        admin_token, study_id, type="review", title="Review", position_x=600, position_y=0,
        config={"status": "todo", "assigned_user_id": reviewer_id},
    )
    connect(admin_token, study_id, dataset_id, annot_card_id)
    connect(admin_token, study_id, annot_card_id, review_card_id)
    run_card(admin_token, annot_card_id)

    # See submit_annotation's docstring -- primes the Review job with one
    # real submitted case up front so specs that read it before doing any
    # annotating themselves don't crash on an empty list. A different
    # case than case_ids[0] (== CASE/SERIES above), so the fixed
    # F.CASE/F.SERIES reference stays whatever a given spec expects
    # (annotated or not -- none of its readers actually care, but no
    # reason to force it either way).
    annotator_token = token_for(ANNOTATOR["username"], ANNOTATOR["password"])
    reviewer_token = token_for(REVIEWER["username"], REVIEWER["password"])
    primed_series_id = series_for_case(admin_token, case_ids[1])
    primed_annotation_id = submit_annotation(annotator_token, study_id, primed_series_id)
    reject_annotation(reviewer_token, primed_annotation_id, "Boundary too generous on the medial side.")

    # A second, fully completed cycle (submitted then approved, on a
    # third case) -- pipeline-health's cycle-time/bottleneck/
    # learning-curve reads need at least one leg pair whose terminal
    # action was actually reached on both the Annotation and Review
    # side, not just the one still-open rejection above.
    approved_series_id = series_for_case(admin_token, case_ids[2])
    approved_annotation_id = submit_annotation(annotator_token, study_id, approved_series_id)
    approve_annotation(reviewer_token, approved_annotation_id)

    generated = {
        "STUDY": study_id,
        "ANNOT_CARD": annot_card_id,
        "REVIEW_CARD": review_card_id,
        "CASE": case_id,
        "SERIES": series_id,
        "ADMIN_USER": {"subject": admin_subject(admin_token)},
        "ANNOTATOR": {"subject": annotator_id},
        "REVIEWER": {"subject": reviewer_id},
    }
    out_path = os.path.join(os.path.dirname(__file__), "fixtures.generated.json")
    with open(out_path, "w") as fh:
        json.dump(generated, fh, indent=2)
    print(f"Wrote {out_path}:")
    print(json.dumps(generated, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 -- top-level: any failure should exit non-zero with a readable message
        print(f"e2e seed failed: {exc}", file=sys.stderr)
        sys.exit(1)
