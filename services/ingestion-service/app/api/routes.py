"""HTTP API for DICOM ingestion: upload and job status."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user, require_project_role
from shared_models.database import get_db
from shared_models.models import Case

from app.storage import upload_staged_file
from app.tasks import ingest_dicom_file

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
    POST /admin/projects/{project_id}/cases -- patient identity resolution
    happens once there, not on every upload.
    """
    case = db.get(Case, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found")
    require_project_role(db, str(case.project_id), user, allowed_roles=["data_manager", "admin"])

    job_id = str(uuid.uuid4())
    staging_key = f"_staging/{job_id}.dcm"
    upload_staged_file(staging_key, await file.read())

    ingest_dicom_file.delay(job_id=job_id, case_id=case_id, staging_key=staging_key)
    return {"job_id": job_id, "status": "queued"}
