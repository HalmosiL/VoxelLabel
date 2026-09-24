"""Data service entrypoint.

Read-focused API for browsing ingested imaging studies/series/instances
and fetching pixel data (via presigned object storage URLs, not proxied
through this service).
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from shared_auth.db_errors import install_db_error_handlers

from app.api.routes import router as data_router
from app.core.config import settings

app = FastAPI(title="CT Platform - Data Service")
# Bad values in a request answer 4xx, not 500 (J-01, J-13).
install_db_error_handlers(app)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(data_router)


@app.get("/health")
def health() -> dict:
    """Liveness/readiness probe target for Kubernetes."""
    return {"status": "ok"}
