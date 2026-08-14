"""HTTP API for DICOM ingestion: upload and job status."""
import os
import uuid

from fastapi import APIRouter, Depends, UploadFile
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user, require_project_role
from shared_models.database import get_db

from app.core.config import settings
from app.tasks import ingest_dicom_file

router = APIRouter(prefix="/ingestion", tags=["ingestion"])


@router.post("/projects/{project_id}/upload")
async def upload_dicom(
    project_id: str,
    file: UploadFile,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Accept a single DICOM file, stage it, and enqueue an ingestion job.

    Returns immediately with a job id; processing happens asynchronously in
    the Celery worker (see app/worker.py, app/tasks.py, app/pipeline.py).
    """
    require_project_role(db, project_id, user, allowed_roles=["data_manager", "admin"])

    job_id = str(uuid.uuid4())
    os.makedirs(settings.staging_dir, exist_ok=True)
    staged_path = os.path.join(settings.staging_dir, f"{job_id}.dcm")
    with open(staged_path, "wb") as staged_file:
        staged_file.write(await file.read())

    ingest_dicom_file.delay(job_id=job_id, project_id=project_id, staged_path=staged_path)
    return {"job_id": job_id, "status": "queued"}
