"""Ingestion service entrypoint.

Accepts DICOM uploads, enqueues them for asynchronous processing by the
Celery worker (see app/worker.py), and exposes job status for polling.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from shared_auth.db_errors import install_db_error_handlers

from app.api.routes import router as ingestion_router
from app.core.config import settings
from app.queue import install_queue_error_handlers

app = FastAPI(title="CT Platform - Ingestion Service")
# Bad values in a request answer 4xx, not 500 (J-01, J-13).
install_db_error_handlers(app)
# The task queue being down answers 503, not 500 (I-06).
install_queue_error_handlers(app)
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
