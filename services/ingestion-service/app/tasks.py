"""Celery tasks for asynchronous DICOM ingestion."""
from celery import Celery

from app.core.config import settings
from app.pipeline import ingest_dicom

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
