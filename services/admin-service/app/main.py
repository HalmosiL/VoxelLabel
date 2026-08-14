"""Admin service entrypoint.

Platform administration: projects, project memberships (per-project
roles), and de-identification profiles. All endpoints require the global
Keycloak "admin" realm role.
"""
from fastapi import FastAPI

from app.api.deidentification import router as deidentification_router
from app.api.projects import router as projects_router

app = FastAPI(title="CT Platform - Admin Service")
app.include_router(projects_router)
app.include_router(deidentification_router)


@app.get("/health")
def health() -> dict:
    """Liveness/readiness probe target for Kubernetes."""
    return {"status": "ok"}
