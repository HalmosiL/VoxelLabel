"""Public self-service registration, and the admin review queue for it.

Two routers on purpose: `public_router` (no auth -- the registration
form itself posts here) and `router` (global-admin only -- list,
approve, reject). Kept out of users.py so the "this one is
intentionally unauthenticated" boundary is a whole separate file, not
one missing Depends among many in the admin-only module.

Approving creates the real Keycloak account with a random one-time
password (the same "temporary password, choose your own at first
login" pattern the admin's manual "create user" flow already uses) --
nothing the requester typed ever reaches Keycloak, so there's no raw
password sitting in this service's database while a request is
pending. Every email this flow sends goes through the one delivery log
the notification service already keeps.
"""
import re
import secrets
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import NotificationLog, NotificationSettings, RegistrationRequest

from app.keycloak_admin import create_user, list_realm_users
from app.notifications.events import get_settings
from app.notifications.mailer import send_email
from app.notifications.registration_emails import compose_admin_alert, compose_approved, compose_received, compose_rejected

_USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

public_router = APIRouter(prefix="/public", tags=["public:registration"])
router = APIRouter(prefix="/admin", tags=["admin:registration"])


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


def _serialize(req: RegistrationRequest) -> dict:
    return {
        "id": str(req.id),
        "created_at": req.created_at.isoformat() if req.created_at else None,
        "username": req.username,
        "email": req.email,
        "first_name": req.first_name,
        "last_name": req.last_name,
        "note": req.note,
        "status": req.status,
        "decided_at": req.decided_at.isoformat() if req.decided_at else None,
        "decided_by": req.decided_by,
        "rejection_reason": req.rejection_reason,
    }


def _send(
    db: Session, settings: NotificationSettings, *, user_id: str, email: str | None, event_type: str, subject: str, text: str, html: str
) -> None:
    """Delivers (or records why it didn't) one registration-flow email
    into NotificationLog -- the same sent/failed/skipped bookkeeping the
    job-change notifications use, so this is visible in the one
    delivery log rather than a second, invisible mail path."""
    status, error = "skipped", None
    if not settings.enabled:
        error = "email delivery is switched off"
    elif not email:
        error = "no email address"
    else:
        try:
            send_email(settings, email, subject, text, html)
            status = "sent"
        except Exception as err:  # noqa: BLE001 -- recorded, not swallowed silently
            status, error = "failed", str(err)[:2000]
    db.add(NotificationLog(user_id=user_id, email=email, event_type=event_type, subject=subject, body=text, status=status, error=error))


class RegisterBody(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    email: str = Field(min_length=3, max_length=255)
    first_name: str = Field(min_length=1, max_length=255)
    last_name: str = Field(min_length=1, max_length=255)
    note: str | None = Field(default=None, max_length=2000)


@public_router.post("/registration-requests", status_code=201)
def submit_registration_request(body: RegisterBody, db: Session = Depends(get_db)) -> dict:
    """The public registration form's target. Creates a pending request,
    emails the requester a receipt and every global admin an alert.
    Refuses a username/email that's already a real account or already
    has a pending request, so nobody piles up duplicate asks or squats
    a name that's taken."""
    username = body.username.strip()
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=422, detail="Enter a valid email address")
    if not _USERNAME_RE.match(username):
        raise HTTPException(status_code=422, detail="Username can only contain letters, digits, dot, underscore or hyphen")

    existing_users = list_realm_users()
    if any(u["username"] == username or (u["email"] or "").lower() == email for u in existing_users):
        raise HTTPException(status_code=409, detail="An account with this username or email already exists")

    pending = (
        db.query(RegistrationRequest)
        .filter(RegistrationRequest.status == "pending")
        .filter((RegistrationRequest.username == username) | (RegistrationRequest.email == email))
        .first()
    )
    if pending is not None:
        raise HTTPException(status_code=409, detail="There's already a pending request for this username or email")

    req = RegistrationRequest(
        username=username,
        email=email,
        first_name=body.first_name.strip(),
        last_name=body.last_name.strip(),
        note=(body.note or "").strip() or None,
    )
    db.add(req)
    db.commit()
    db.refresh(req)

    settings = get_settings(db)
    admin_emails = {u["email"] for u in existing_users if u["is_admin"] and u.get("email")}

    subject, text, html = compose_received(req, settings.platform_base_url)
    _send(db, settings, user_id=str(req.id), email=req.email, event_type="registration_received", subject=subject, text=text, html=html)

    subject, text, html = compose_admin_alert(req, settings.platform_base_url)
    for admin_email in admin_emails:
        _send(db, settings, user_id=str(req.id), email=admin_email, event_type="registration_submitted", subject=subject, text=text, html=html)

    db.commit()
    return _serialize(req)


@router.get("/registration-requests")
def list_registration_requests(
    status: str | None = None, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)
) -> list[dict]:
    """The Users page's "Registration requests" panel. `status` filters
    to one of pending/approved/rejected; omitted, everything (newest
    first)."""
    _require_global_admin(user)
    query = db.query(RegistrationRequest)
    if status:
        query = query.filter(RegistrationRequest.status == status)
    rows = query.order_by(RegistrationRequest.created_at.desc()).all()
    return [_serialize(r) for r in rows]


def _get_pending(db: Session, request_id: str) -> RegistrationRequest:
    try:
        rid = uuid.UUID(request_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Registration request not found") from None
    req = db.get(RegistrationRequest, rid)
    if req is None:
        raise HTTPException(status_code=404, detail="Registration request not found")
    if req.status != "pending":
        raise HTTPException(status_code=409, detail=f"This request was already {req.status}")
    return req


@router.post("/registration-requests/{request_id}/approve")
def approve_registration_request(
    request_id: str, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)
) -> dict:
    """Creates the real Keycloak account -- never as an admin; granting
    that stays a separate, deliberate action on the Users page
    afterward -- with a random one-time password, marks the request
    decided, and emails the person their credentials."""
    _require_global_admin(user)
    req = _get_pending(db, request_id)

    temporary_password = secrets.token_urlsafe(9)  # ~12 chars, plenty of entropy for a one-time login
    try:
        created = create_user(req.username, req.email, req.first_name, req.last_name, temporary_password, is_admin=False)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 409:
            raise HTTPException(status_code=409, detail="A user with this username or email already exists") from exc
        raise

    req.status = "approved"
    req.decided_at = datetime.now(timezone.utc)
    req.decided_by = user.subject
    db.add(req)

    settings = get_settings(db)
    subject, text, html = compose_approved(req, created["username"], temporary_password, settings.platform_base_url)
    _send(db, settings, user_id=str(req.id), email=req.email, event_type="registration_approved", subject=subject, text=text, html=html)

    db.commit()
    return _serialize(req)


class RejectBody(BaseModel):
    reason: str | None = Field(default=None, max_length=2000)


@router.post("/registration-requests/{request_id}/reject")
def reject_registration_request(
    request_id: str, body: RejectBody, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)
) -> dict:
    _require_global_admin(user)
    req = _get_pending(db, request_id)

    req.status = "rejected"
    req.decided_at = datetime.now(timezone.utc)
    req.decided_by = user.subject
    req.rejection_reason = (body.reason or "").strip() or None
    db.add(req)

    settings = get_settings(db)
    subject, text, html = compose_rejected(req, req.rejection_reason)
    _send(db, settings, user_id=str(req.id), email=req.email, event_type="registration_rejected", subject=subject, text=text, html=html)

    db.commit()
    return _serialize(req)
