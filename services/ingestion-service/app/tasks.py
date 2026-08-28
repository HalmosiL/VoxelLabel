"""Celery tasks for asynchronous DICOM ingestion."""
from celery import Celery

from app.core.config import settings
from app.pipeline import ingest_dicom
from app.pytorch_export import build_pytorch_export
from app.quick_import import run_quick_import

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


@celery_app.task(name="ingestion.quick_import_batch", bind=True)
def quick_import_batch(self, study_id: str, staging_keys: list[str]) -> dict:
    """Runs one quick-import batch (see app/quick_import.py) -- every
    staged file processed sequentially in this single task, deliberately
    never fanned out across workers (see that module's own docstring for
    why). Not retried as a whole: a per-file failure is already captured
    in the returned "errors" list rather than raising, so a task-level
    retry would only be useful for a failure between files (e.g. losing
    the DB connection entirely), which is rare enough not to warrant the
    complexity of resuming a partially-done batch.
    """
    return run_quick_import(study_id=study_id, staging_keys=staging_keys)
