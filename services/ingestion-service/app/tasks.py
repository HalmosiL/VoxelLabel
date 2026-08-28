"""Celery tasks for asynchronous DICOM ingestion."""
from celery import Celery

from app.core.config import settings
from app.pipeline import ingest_dicom
from app.pytorch_export import build_pytorch_export

celery_app = Celery("ingestion", broker=settings.redis_url, backend=settings.redis_url)


class TransientIngestionError(Exception):
    """Raised for failures worth retrying (e.g. storage/network blips), as
    opposed to permanent validation failures which are not retried."""


@celery_app.task(name="ingestion.ingest_dicom_file", bind=True, max_retries=3, default_retry_delay=30)
def ingest_dicom_file(self, job_id: str, case_id: str, staging_key: str) -> dict:
    """Parse, de-identify, upload and register a single staged DICOM file."""
    try:
        return ingest_dicom(job_id=job_id, case_id=case_id, staging_key=staging_key)
    except TransientIngestionError as exc:
        raise self.retry(exc=exc)


@celery_app.task(name="ingestion.export_pytorch_dataset", bind=True)
def export_pytorch_dataset(self, export_id: str, case_ids: list[str]) -> dict:
    """Builds and stores a PyTorch-ready export (see app/pytorch_export.py)
    for the given cases. Not retried -- unlike a single DICOM upload, an
    export failure is more likely a real bug (a bad case id, a decode
    error) than a transient storage blip, and retrying a possibly-large,
    slow job automatically is more likely to waste resources than to help.
    Called with task_id=export_id (see the /ingestion/exports POST route)
    so it's addressable by that id afterward via Celery's own AsyncResult,
    without a dedicated database table for job status.
    """
    return build_pytorch_export(export_id=export_id, case_ids=case_ids)
