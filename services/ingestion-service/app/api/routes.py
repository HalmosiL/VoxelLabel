"""HTTP API for DICOM ingestion: upload, job status, PyTorch exports, and
quick import."""
import io
import json
import uuid

import pydicom
from celery.result import AsyncResult
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import Case, Study, WorkflowCard, WorkflowCardType

from app.storage import download_object, presigned_export_url, upload_staged_file
from app.pipeline import REQUIRED_TAGS
from app.tasks import celery_app, export_pytorch_dataset, ingest_dicom_file, quick_import_batch


def _reject_non_dicom(data: bytes) -> None:
    """Fail fast, in the request, on a file that isn't a usable DICOM --
    otherwise it would be staged, queued, and only fail minutes later
    inside a worker where nobody is looking (and its staged copy would
    linger in object storage). Header-only parse: pixel data is never
    decoded here."""
    try:
        dataset = pydicom.dcmread(io.BytesIO(data), stop_before_pixels=True, force=True)
    except Exception as exc:  # noqa: BLE001 -- any parse failure means "not DICOM" to the caller
        raise HTTPException(status_code=422, detail=f"Not a readable DICOM file: {exc}") from exc
    missing = [tag for tag in REQUIRED_TAGS if tag not in dataset]
    if missing:
        raise HTTPException(status_code=422, detail=f"Not a valid DICOM file: missing {', '.join(missing)}")

router = APIRouter(prefix="/ingestion", tags=["ingestion"])


@router.post("/cases/{case_id}/upload")
async def upload_dicom(
    case_id: str,
    file: UploadFile,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Accept a single DICOM file for an existing case, stage it, and
    enqueue an ingestion job.

    Returns immediately with a job id; processing happens asynchronously in
    the Celery worker (see app/worker.py, app/tasks.py, app/pipeline.py).
    The file is staged in object storage, not local disk -- this API and
    the worker run in separate containers with no shared filesystem. The
    case must already exist -- see admin-service's
    POST /admin/studies/{study_id}/cases -- patient identity resolution
    happens once there, not on every upload.
    """
    case = db.get(Case, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found")
    require_study_role(db, str(case.study_id), user, allowed_roles=["data_manager", "admin"])

    data = await file.read()
    _reject_non_dicom(data)
    job_id = str(uuid.uuid4())
    staging_key = f"_staging/{job_id}.dcm"
    upload_staged_file(staging_key, data)
    # task_id=job_id makes the job pollable via GET /ingestion/jobs/{job_id}
    # (Celery's own result backend), the same way quick imports are.
    ingest_dicom_file.apply_async(kwargs={"job_id": job_id, "case_id": case_id, "staging_key": staging_key}, task_id=job_id)
    return {"job_id": job_id, "status": "queued"}


@router.get("/jobs/{job_id}")
def get_ingestion_job(job_id: str, user: CurrentUser = Depends(get_current_user)) -> dict:
    """Polls one single-file upload job -- completed (with the instance
    id, or "duplicate"), failed (with the reason), or still pending."""
    result = AsyncResult(job_id, app=celery_app)
    if result.state == "SUCCESS":
        return {"status": "completed", **(result.result if isinstance(result.result, dict) else {})}
    if result.state == "FAILURE":
        return {"status": "failed", "error": str(result.result)}
    return {"status": (result.state or "PENDING").lower()}


@router.post("/studies/{study_id}/quick-import")
async def quick_import(
    study_id: str,
    files: list[UploadFile],
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Drop a whole folder/zip's worth of loose DICOM files -- any mix of
    patients and studies -- and get back fully ingested Cases with no
    manual "create a case first" step (see app/quick_import.py for the
    grouping/matching rules). Returns immediately; poll
    GET /ingestion/quick-imports/{import_id} for the outcome (which
    cases were created vs. matched, how many instances landed, and any
    per-file errors)."""
    require_study_role(db, study_id, user, allowed_roles=["data_manager", "admin"])
    if db.get(Study, study_id) is None:
        raise HTTPException(status_code=404, detail="Study not found")
    if not files:
        raise HTTPException(status_code=422, detail="No files given")

    import_id = str(uuid.uuid4())
    staging_keys = []
    # staging_key -> the name the browser actually sent (the multipart
    # part's own filename -- FormData preserves File.name for this
    # automatically, no frontend change needed). Reported back instead
    # of the staging_key itself wherever a file shows up in progress/
    # errors (see quick_import.py's run_quick_import) -- the staging key
    # is a throwaway "_staging/<id>/<uuid>.dcm" object-storage path that
    # means nothing to whoever picked the files.
    filenames: dict[str, str] = {}
    for file in files:
        staging_key = f"_staging/{import_id}/{uuid.uuid4()}.dcm"
        upload_staged_file(staging_key, await file.read())
        staging_keys.append(staging_key)
        if file.filename:
            filenames[staging_key] = file.filename

    quick_import_batch.apply_async(
        kwargs={"study_id": study_id, "staging_keys": staging_keys, "filenames": filenames}, task_id=import_id
    )
    return {"import_id": import_id, "status": "queued", "file_count": len(staging_keys)}


@router.get("/quick-imports/{import_id}")
def get_quick_import(import_id: str, user: CurrentUser = Depends(get_current_user)) -> dict:
    """Polls one quick-import batch's status/result via Celery's own
    AsyncResult -- no durable object-storage marker needed here (unlike
    the PyTorch export's manifest.json) since this is a short-lived,
    actively-watched foreground action, not something checked back on
    a day later."""
    result = AsyncResult(import_id, app=celery_app)
    if result.state == "SUCCESS":
        return {"status": "completed", **result.result}
    if result.state == "FAILURE":
        return {"status": "failed", "error": str(result.result)}
    if result.state == "PROGRESS" and isinstance(result.info, dict):
        # Set by quick_import_batch's own on_progress callback -- "N of
        # M files" progress for a batch that can take a while.
        return {"status": "progress", **result.info}
    return {"status": (result.state or "PENDING").lower()}


class PytorchExportIn(BaseModel):
    study_id: str
    # Exactly one of the two: either the caller already knows the exact
    # case list (e.g. admin-ui's own DatasetFields, which has to resolve
    # a card's Manual-pick/All-cases mode anyway to show it), or it just
    # names the Dataset card and lets this route resolve it -- letting
    # any outside caller ask "what's in this dataset" by naming the
    # dataset itself, without having to duplicate that resolution logic.
    case_ids: list[str] | None = None
    card_id: str | None = None


def _resolve_dataset_card_case_ids(db: Session, card_id: str, study_id: str) -> list[str]:
    """Same mode/case_ids convention admin-service's own workflow.py uses
    for a Dataset card (_dataset_output_ids) -- duplicated here rather
    than imported since ingestion-service and admin-service are separate
    deployable services with their own dependencies, no shared code path
    between them beyond shared_models itself."""
    card = db.get(WorkflowCard, card_id)
    if card is None or str(card.study_id) != study_id:
        raise HTTPException(status_code=404, detail="Dataset card not found in this study")
    if card.type != WorkflowCardType.DATASET:
        raise HTTPException(status_code=422, detail="card_id must reference a Dataset card")
    if card.config.get("mode") == "manual":
        return list(card.config.get("case_ids", []))
    return [str(c.id) for c in db.query(Case).filter_by(study_id=study_id).all()]


@router.post("/exports")
def create_pytorch_export(
    body: PytorchExportIn,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Kicks off an async PyTorch-ready export (app/pytorch_export.py) of
    the given cases -- every imaging Series decoded to a real-HU-value
    numpy array, plus every recorded annotation, addressable afterward via
    GET /ingestion/exports/{export_id}. Every case must actually belong to
    study_id, so a caller can't smuggle in cases from a study they don't
    hold this role in.
    """
    require_study_role(db, body.study_id, user, allowed_roles=["data_manager", "admin"])
    if bool(body.case_ids) == bool(body.card_id):
        raise HTTPException(status_code=422, detail="Provide exactly one of case_ids or card_id")

    case_ids = body.case_ids or _resolve_dataset_card_case_ids(db, body.card_id, body.study_id)
    if not case_ids:
        raise HTTPException(status_code=422, detail="No cases to export")

    cases = db.query(Case).filter(Case.id.in_(case_ids)).all()
    if len(cases) != len(set(case_ids)):
        raise HTTPException(status_code=404, detail="One or more cases not found")
    if any(str(c.study_id) != body.study_id for c in cases):
        raise HTTPException(status_code=422, detail="All cases must belong to study_id")

    export_id = str(uuid.uuid4())
    # task_id=export_id is what lets the GET route below poll this run via
    # Celery's own AsyncResult, with no dedicated database table for job
    # status.
    export_pytorch_dataset.apply_async(kwargs={"export_id": export_id, "case_ids": case_ids}, task_id=export_id)
    return {"export_id": export_id, "status": "queued"}


@router.get("/exports/{export_id}")
def get_pytorch_export(export_id: str, user: CurrentUser = Depends(get_current_user)) -> dict:
    """Polls one export's status.

    The manifest itself, once it exists in object storage, is treated as
    the durable source of truth -- checked there directly rather than
    through Celery's AsyncResult, since a Celery/Redis result can be
    evicted long before anyone gets around to checking on a slow export.
    AsyncResult is only consulted to tell "still running" from "failed"
    from "never existed" *before* that manifest shows up.

    No extra per-study role check here beyond being an authenticated
    user: export_id is an unguessable UUID nobody else is handed, the
    same trust model this platform's own presigned URLs already rely on
    once a link has been given out.
    """
    try:
        raw = download_object(f"exports/{export_id}/manifest.json")
    except Exception:
        # Any failure to fetch means "not ready yet" (or never existed) --
        # fall back to Celery for a more specific in-progress/failed state.
        result = AsyncResult(export_id, app=celery_app)
        if result.state == "FAILURE":
            return {"status": "failed", "error": str(result.result)}
        return {"status": (result.state or "PENDING").lower()}

    manifest = json.loads(raw)
    for case in manifest["cases"]:
        for series in case["series"]:
            series["image_url"] = presigned_export_url(series.pop("image_key"))
        for annotation in case.get("annotations", []):
            annotation["asset_urls"] = {
                key: presigned_export_url(value) for key, value in annotation.get("asset_keys", {}).items()
            }
    return {"status": "completed", "manifest": manifest}
