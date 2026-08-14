"""Admin service entrypoint.

Platform administration: projects, project memberships (per-project
roles), and de-identification profiles. All endpoints require the global
Keycloak "admin" realm role.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.annotation_types import router as annotation_types_router
from app.api.deidentification import router as deidentification_router
from app.api.projects import router as projects_router
from app.core.config import settings

app = FastAPI(title="CT Platform - Admin Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(projects_router)
app.include_router(deidentification_router)
app.include_router(annotation_types_router)


@app.get("/health")
def health() -> dict:
    """Liveness/readiness probe target for Kubernetes."""
    return {"status": "ok"}
