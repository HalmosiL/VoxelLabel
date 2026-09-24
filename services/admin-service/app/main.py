"""Admin service entrypoint.

Platform administration: studies, study memberships (per-study
roles), de-identification profiles, cases, and clinical data items. Most
endpoints require study-scoped roles (see shared_auth); study/profile
management specifically requires the global Keycloak "admin" realm role.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.annotation_types import router as annotation_types_router
from app.api.audit import router as audit_router
from app.api.backups import router as backups_router
from app.api.cases import router as cases_router
from app.api.clinical_data import router as clinical_data_router
from app.api.deidentification import router as deidentification_router
from app.api.imaging import router as imaging_router
from app.api.objects import router as objects_router
from app.api.pipeline_templates import router as pipeline_templates_router
from app.api.registration import public_router as registration_public_router
from app.api.registration import router as registration_router
from app.api.studies import router as studies_router
from app.api.users import router as users_router
from app.api.versions import router as versions_router
from app.api.workflow import router as workflow_router
from app.core.config import settings
from app.notifications import router as notifications_router
from app.notifications import start_poller
from app.pipeline_health import router as pipeline_health_router
from app.study_analytics import router as study_analytics_router
from app.usage import router as usage_router
from app.workflow_new_cases import start_new_cases_poller


@asynccontextmanager
async def lifespan(_: FastAPI):
    # The notification service's observation loop runs inside this
    # process -- see app/notifications/poller.py.
    start_poller()
    # Quick-imported cases reach the board -- see app/workflow_new_cases.py.
    start_new_cases_poller()
    yield


app = FastAPI(title="CT Platform - Admin Service", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(studies_router)
app.include_router(deidentification_router)
app.include_router(annotation_types_router)
app.include_router(cases_router)
app.include_router(clinical_data_router)
app.include_router(imaging_router)
app.include_router(users_router)
app.include_router(workflow_router)
app.include_router(pipeline_templates_router)
app.include_router(versions_router)
app.include_router(backups_router)
app.include_router(notifications_router)
app.include_router(registration_router)
app.include_router(registration_public_router)
app.include_router(audit_router)
app.include_router(usage_router)
app.include_router(objects_router)
app.include_router(pipeline_health_router)
app.include_router(study_analytics_router)


@app.get("/health")
def health() -> dict:
    """Liveness/readiness probe target for Kubernetes."""
    return {"status": "ok"}
