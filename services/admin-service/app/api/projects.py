"""HTTP API for managing projects and project memberships (per-project roles)."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import Case, Project, ProjectMembership, ProjectRole

from app.storage import presigned_project_cover_image_url, upload_project_cover_image

router = APIRouter(prefix="/admin/projects", tags=["admin:projects"])


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


@router.get("")
def list_projects(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    _require_global_admin(user)
    projects = db.query(Project).all()
    return [
        {
            "id": str(p.id),
            "name": p.name,
            "description": p.description,
            "deidentification_profile_id": str(p.deidentification_profile_id) if p.deidentification_profile_id else None,
            "cover_image_url": presigned_project_cover_image_url(p.cover_image_key) if p.cover_image_key else None,
        }
        for p in projects
    ]


@router.post("")
def create_project(
    name: str,
    description: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)
    project = Project(name=name, description=description)
    db.add(project)
    db.commit()
    return {"id": str(project.id), "name": project.name}


@router.patch("/{project_id}")
def update_project(
    project_id: str,
    name: str | None = None,
    description: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    if name is not None:
        project.name = name
    if description is not None:
        project.description = description
    db.commit()
    return {"id": str(project.id), "name": project.name, "description": project.description}


@router.delete("/{project_id}", status_code=204)
def delete_project(
    project_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Deletes a project and its membership grants. Refuses to delete a
    project that still has cases -- cases carry real (pseudonymized)
    patient data, so removing them has to be a deliberate, separate
    action, not a side effect of deleting the project they're grouped
    under."""
    _require_global_admin(user)
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    case_count = db.query(Case).filter_by(project_id=project_id).count()
    if case_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete: this project still has {case_count} case(s). Remove them first.",
        )

    db.query(ProjectMembership).filter_by(project_id=project_id).delete()
    db.delete(project)
    db.commit()


@router.post("/{project_id}/cover-image")
async def upload_cover_image(
    project_id: str,
    file: UploadFile,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Attach (or replace) a project's cover image, shown on its card in
    the admin-ui project grid."""
    _require_global_admin(user)
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    storage_key = f"project-covers/{project_id}/{uuid.uuid4()}-{file.filename}"
    upload_project_cover_image(storage_key, await file.read())

    project.cover_image_key = storage_key
    db.commit()
    return {"id": str(project.id), "cover_image_url": presigned_project_cover_image_url(storage_key)}


@router.get("/{project_id}/members")
def list_project_members(
    project_id: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    _require_global_admin(user)
    memberships = db.query(ProjectMembership).filter_by(project_id=project_id).all()
    return [{"user_id": m.user_id, "role": m.role.value} for m in memberships]


@router.post("/{project_id}/members")
def add_project_member(
    project_id: str,
    user_id: str,
    role: ProjectRole,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Grant `user_id` (a Keycloak subject) a role scoped to this project."""
    _require_global_admin(user)
    membership = ProjectMembership(project_id=project_id, user_id=user_id, role=role)
    db.add(membership)
    db.commit()
    return {"project_id": project_id, "user_id": user_id, "role": role.value}
