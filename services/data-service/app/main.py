"""Data service entrypoint.

Read-focused API for browsing ingested imaging studies/series/instances
and fetching pixel data (via presigned object storage URLs, not proxied
through this service).
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from shared_auth.db_errors import install_db_error_handlers
from shared_auth.readiness import database_check, install_readiness
from shared_auth.request_limit import install_request_limit
from shared_auth.storage_errors import install_storage_error_handlers

from app.api.routes import router as data_router
from app.core.config import settings
from app.storage import storage_check

app = FastAPI(title="CT Platform - Data Service")
# Bad values in a request answer 4xx, not 500 (J-01, J-13).
install_db_error_handlers(app)
# no more requests at once than database connections: a burst jammed the
# threadpool for 30 s (see shared_auth.request_limit); inside CORS, so a
# waiting request still gets its headers
install_request_limit(app, exempt=("/health", "/data/objects"))
# File storage being unreachable answers 503, not 500 (I-08).
install_storage_error_handlers(app)
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
    """Liveness probe: the process answers. Dependencies: /health/ready."""
    return {"status": "ok"}


# /health is liveness only; /health/ready checks the dependencies and names what is down.
install_readiness(app, {"database": database_check, "storage": storage_check})
