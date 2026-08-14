"""Ingestion service entrypoint.

Accepts DICOM uploads, enqueues them for asynchronous processing by the
Celery worker (see app/worker.py), and exposes job status for polling.
"""
from fastapi import FastAPI

from app.api.routes import router as ingestion_router

app = FastAPI(title="CT Platform - Ingestion Service")
app.include_router(ingestion_router)


@app.get("/health")
def health() -> dict:
    """Liveness/readiness probe target for Kubernetes."""
    return {"status": "ok"}
