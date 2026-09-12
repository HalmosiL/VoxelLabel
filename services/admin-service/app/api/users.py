"""HTTP API for looking up and creating Keycloak users -- backs the
study-member picker (so members are added by selecting a real user
instead of pasting a raw Keycloak subject UUID) and the global Users
page in admin-ui. Global admin only.
"""
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import Study, StudyMembership, StudyRole

from app.api import audit
from app.keycloak_admin import create_user, delete_user, get_user, list_realm_users, reset_password, set_admin_role, update_user

router = APIRouter(prefix="/admin", tags=["admin:users"])


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


@router.get("/me")
def get_me(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Who am I, platform-wise: the global admin flag and every study
    membership with its role. The access token carries realm roles but
    nothing study-scoped, and admin-ui needs both to decide what to
    show (nav groups, edit buttons, a read-only board) -- the backend
    checks stay the real access control regardless."""
    memberships = db.query(StudyMembership).filter_by(user_id=user.subject).all()
    studies = {str(s.id): s for s in db.query(Study).filter(Study.id.in_([m.study_id for m in memberships])).all()} if memberships else {}
    return {
        "subject": user.subject,
        "email": user.email,
        "is_admin": "admin" in user.realm_roles,
        "realm_roles": user.realm_roles,
        "memberships": [
            {
                "study_id": str(m.study_id),
                "study_name": studies[str(m.study_id)].name if str(m.study_id) in studies else None,
                "role": m.role.value,
            }
            for m in memberships
        ],
    }


@router.get("/keycloak-users")
def list_keycloak_users(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """The realm's user directory -- for a global admin, and for anyone
    who administers at least one study (they need it to pick new members
    for that study); everyone else resolves names through the per-study
    members endpoint instead."""
    if "admin" not in user.realm_roles:
        administers_any = (
            db.query(StudyMembership).filter_by(user_id=user.subject, role=StudyRole.ADMIN).first() is not None
        )
        if not administers_any:
            raise HTTPException(status_code=403, detail="Admin realm role (or a study admin role) required")
    return list_realm_users()


class CreateUserBody(BaseModel):
    username: str
    email: str
    first_name: str
    last_name: str
    password: str
    is_admin: bool = False


@router.post("/users")
def create_keycloak_user(body: CreateUserBody, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    _require_global_admin(user)
    try:
        created = create_user(body.username, body.email, body.first_name, body.last_name, body.password, body.is_admin)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 409:
            raise HTTPException(status_code=409, detail="A user with this username or email already exists")
        raise
    audit.record(db, user, "user.create", "user", created["id"], {"username": body.username, "is_admin": body.is_admin})
    db.commit()
    return created


class UpdateUserBody(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    email: str | None = None
    enabled: bool | None = None
    is_admin: bool | None = None


class ResetPasswordBody(BaseModel):
    password: str
    # True: the person must pick their own password at the next login.
    temporary: bool = True


def _keycloak_error(exc: httpx.HTTPStatusError) -> HTTPException:
    if exc.response.status_code == 404:
        return HTTPException(status_code=404, detail="User not found")
    if exc.response.status_code == 409:
        return HTTPException(status_code=409, detail="A user with this username or email already exists")
    return HTTPException(status_code=502, detail=f"Keycloak refused the change ({exc.response.status_code})")


@router.get("/users/{user_id}")
def get_keycloak_user(user_id: str, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    """One account with its study memberships -- what the Users page's
    edit dialog shows."""
    _require_global_admin(user)
    try:
        account = get_user(user_id)
    except httpx.HTTPStatusError as exc:
        raise _keycloak_error(exc) from exc
    memberships = db.query(StudyMembership).filter_by(user_id=user_id).all()
    studies = {str(s.id): s.name for s in db.query(Study).filter(Study.id.in_([m.study_id for m in memberships])).all()} if memberships else {}
    account["memberships"] = [
        {"study_id": str(m.study_id), "study_name": studies.get(str(m.study_id)), "role": m.role.value} for m in memberships
    ]
    return account


@router.patch("/users/{user_id}")
def update_keycloak_user(
    user_id: str, body: UpdateUserBody, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)
) -> dict:
    """Edit profile fields, enable/disable the account, grant/revoke the
    global admin flag. An admin can't lock themselves out (disable or
    demote their own account)."""
    _require_global_admin(user)
    if user_id == user.subject and (body.enabled is False or body.is_admin is False):
        raise HTTPException(status_code=409, detail="You cannot disable or demote your own account")
    try:
        if body.is_admin is not None:
            set_admin_role(user_id, body.is_admin)
        updated = update_user(
            user_id, first_name=body.first_name, last_name=body.last_name, email=body.email, enabled=body.enabled
        )
    except httpx.HTTPStatusError as exc:
        raise _keycloak_error(exc) from exc
    audit.record(db, user, "user.update", "user", user_id, {k: v for k, v in body.model_dump().items() if v is not None})
    db.commit()
    return updated


@router.post("/users/{user_id}/reset-password", status_code=204)
def reset_keycloak_password(
    user_id: str, body: ResetPasswordBody, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)
) -> None:
    _require_global_admin(user)
    if len(body.password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    try:
        reset_password(user_id, body.password, body.temporary)
    except httpx.HTTPStatusError as exc:
        raise _keycloak_error(exc) from exc
    audit.record(db, user, "user.reset_password", "user", user_id, {"temporary": body.temporary})
    db.commit()


@router.delete("/users/{user_id}", status_code=204)
def delete_keycloak_user(
    user_id: str, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)
) -> None:
    """Removes the account and every study membership it held. Annotations
    they authored stay (attributed by subject id) -- they're clinical
    work, not the account's property. Jobs still assigned to them keep
    the assignment until someone reassigns them on the board."""
    _require_global_admin(user)
    if user_id == user.subject:
        raise HTTPException(status_code=409, detail="You cannot delete your own account")
    try:
        delete_user(user_id)
    except httpx.HTTPStatusError as exc:
        raise _keycloak_error(exc) from exc
    db.query(StudyMembership).filter_by(user_id=user_id).delete()
    audit.record(db, user, "user.delete", "user", user_id)
    db.commit()

