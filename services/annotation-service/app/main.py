"""Annotation service entrypoint.

Owns annotation create/list/review. Annotation types are data (see
AnnotationType in shared_models), not hardcoded here -- new types can be
registered without a deployment.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from shared_auth.db_errors import install_db_error_handlers
from shared_auth.readiness import database_check, install_readiness

from app.api.routes import router as annotations_router
from app.core.config import settings

app = FastAPI(title="CT Platform - Annotation Service")
# Bad values in a request answer 4xx, not 500 (J-01, J-13).
install_db_error_handlers(app)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(annotations_router)


@app.get("/health")
def health() -> dict:
    """Liveness probe: the process answers. Dependencies: /health/ready."""
    return {"status": "ok"}


# /health is liveness only; /health/ready checks the dependencies and names what is down.
install_readiness(app, {"database": database_check})
