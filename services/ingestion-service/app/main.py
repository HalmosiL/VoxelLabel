"""Ingestion service entrypoint.

Accepts DICOM uploads, enqueues them for asynchronous processing by the
Celery worker (see app/worker.py), and exposes job status for polling.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as ingestion_router
from app.core.config import settings

app = FastAPI(title="CT Platform - Ingestion Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(ingestion_router)


@app.get("/health")
def health() -> dict:
    """Liveness/readiness probe target for Kubernetes."""
    return {"status": "ok"}
