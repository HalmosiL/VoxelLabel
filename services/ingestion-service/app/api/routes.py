"""HTTP API for DICOM ingestion: upload, job status, and PyTorch exports."""
import json
import uuid

from celery.result import AsyncResult
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user, require_study_role
from shared_models.database import get_db
from shared_models.models import Case

from app.storage import download_object, presigned_export_url, upload_staged_file
from app.tasks import celery_app, export_pytorch_dataset, ingest_dicom_file

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

    job_id = str(uuid.uuid4())
    staging_key = f"_staging/{job_id}.dcm"
    upload_staged_file(staging_key, await file.read())

    ingest_dicom_file.delay(job_id=job_id, case_id=case_id, staging_key=staging_key)
    return {"job_id": job_id, "status": "queued"}


class PytorchExportIn(BaseModel):
    study_id: str
    case_ids: list[str]


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
    if not body.case_ids:
        raise HTTPException(status_code=422, detail="case_ids must not be empty")

    cases = db.query(Case).filter(Case.id.in_(body.case_ids)).all()
    if len(cases) != len(set(body.case_ids)):
        raise HTTPException(status_code=404, detail="One or more cases not found")
    if any(str(c.study_id) != body.study_id for c in cases):
        raise HTTPException(status_code=422, detail="All cases must belong to study_id")

    export_id = str(uuid.uuid4())
    # task_id=export_id is what lets the GET route below poll this run via
    # Celery's own AsyncResult, with no dedicated database table for job
    # status.
    export_pytorch_dataset.apply_async(kwargs={"export_id": export_id, "case_ids": body.case_ids}, task_id=export_id)
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
