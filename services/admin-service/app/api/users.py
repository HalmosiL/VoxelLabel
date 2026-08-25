"""HTTP API for looking up and creating Keycloak users -- backs the
study-member picker (so members are added by selecting a real user
instead of pasting a raw Keycloak subject UUID) and the global Users
page in admin-ui. Global admin only.
"""
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from shared_auth import CurrentUser, get_current_user

from app.keycloak_admin import create_user, list_realm_users

router = APIRouter(prefix="/admin", tags=["admin:users"])


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


@router.get("/keycloak-users")
def list_keycloak_users(user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    _require_global_admin(user)
    return list_realm_users()


class CreateUserBody(BaseModel):
    username: str
    email: str
    first_name: str
    last_name: str
    password: str
    is_admin: bool = False


@router.post("/users")
def create_keycloak_user(body: CreateUserBody, user: CurrentUser = Depends(get_current_user)) -> dict:
    _require_global_admin(user)
    try:
        return create_user(body.username, body.email, body.first_name, body.last_name, body.password, body.is_admin)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 409:
            raise HTTPException(status_code=409, detail="A user with this username or email already exists")
        raise
