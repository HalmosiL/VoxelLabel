"""HTTP API for managing projects and project memberships (per-project roles)."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import Project, ProjectMembership, ProjectRole

router = APIRouter(prefix="/admin/projects", tags=["admin:projects"])


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


@router.post("")
def create_project(
    name: str,
    description: str | None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    _require_global_admin(user)
    project = Project(name=name, description=description)
    db.add(project)
    db.commit()
    return {"id": str(project.id), "name": project.name}


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
