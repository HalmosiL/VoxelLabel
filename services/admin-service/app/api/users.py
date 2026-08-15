"""HTTP API for looking up Keycloak users -- backs the project-member
picker in admin-ui, so members are added by selecting a real user instead
of pasting a raw Keycloak subject UUID. Read-only, global admin only.
"""
from fastapi import APIRouter, Depends, HTTPException

from shared_auth import CurrentUser, get_current_user

from app.keycloak_admin import list_realm_users

router = APIRouter(prefix="/admin", tags=["admin:users"])


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


@router.get("/keycloak-users")
def list_keycloak_users(user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    _require_global_admin(user)
    return list_realm_users()
