"""HTTP API for the notification service: delivery settings, a test
email, run-now, the loop's status, the delivery log, and per-user
preferences. Settings/log/all-users' preferences are global admin only;
a person can always read and change their own preferences."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import NotificationLog, NotificationPreference
from sqlalchemy.orm import Session

from app.keycloak_admin import list_realm_users

from .events import get_settings
from .mailer import send_email
from .poller import poller_state, run_once

router = APIRouter(prefix="/admin/notifications", tags=["admin:notifications"])


def _require_global_admin(user: CurrentUser) -> None:
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")


def _serialize_settings(row) -> dict:
    return {
        "enabled": row.enabled,
        "smtp_host": row.smtp_host,
        "smtp_port": row.smtp_port,
        "smtp_username": row.smtp_username,
        # Never echoed back -- only whether one is stored.
        "smtp_password_set": bool(row.smtp_password),
        "smtp_use_tls": row.smtp_use_tls,
        "smtp_use_ssl": row.smtp_use_ssl,
        "from_address": row.from_address,
        "platform_base_url": row.platform_base_url,
        "poll_interval_seconds": row.poll_interval_seconds,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


class SettingsPatch(BaseModel):
    enabled: bool | None = None
    smtp_host: str | None = None
    smtp_port: int | None = None
    smtp_username: str | None = None
    # null/absent = leave as is; "" = clear.
    smtp_password: str | None = None
    smtp_use_tls: bool | None = None
    smtp_use_ssl: bool | None = None
    from_address: str | None = None
    platform_base_url: str | None = None
    poll_interval_seconds: int | None = None


@router.get("/settings")
def read_settings(db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    _require_global_admin(user)
    return _serialize_settings(get_settings(db))


@router.put("/settings")
def update_settings(body: SettingsPatch, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    _require_global_admin(user)
    row = get_settings(db)
    for name in ("enabled", "smtp_host", "smtp_port", "smtp_username", "smtp_use_tls", "smtp_use_ssl", "from_address", "platform_base_url"):
        value = getattr(body, name)
        if value is not None:
            setattr(row, name, value)
    if body.smtp_password is not None:
        row.smtp_password = body.smtp_password or None
    if body.poll_interval_seconds is not None:
        if body.poll_interval_seconds < 10:
            raise HTTPException(status_code=422, detail="The check interval must be at least 10 seconds")
        row.poll_interval_seconds = body.poll_interval_seconds
    db.commit()
    db.refresh(row)
    return _serialize_settings(row)


class TestEmailBody(BaseModel):
    to: str | None = None


@router.post("/test-email")
def test_email(body: TestEmailBody, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    """Sends one message through the *saved* settings (save first) to the
    given address, or to the caller's own account email. Delivery
    doesn't need to be switched on for this -- it's exactly for checking
    the server before switching it on."""
    _require_global_admin(user)
    settings = get_settings(db)
    address = body.to or user.email
    if not address:
        raise HTTPException(status_code=422, detail="No address given and your account has no email")
    subject = "VoxelLabel: test email"
    text = (
        "This is a test message from the VoxelLabel notification service.\n\n"
        f"Server: {settings.smtp_host}:{settings.smtp_port} · From: {settings.from_address}\n"
        "If you can read this, job notifications will arrive the same way."
    )
    entry = NotificationLog(user_id=user.subject, email=address, event_type="test", subject=subject, body=text, status="sent")
    try:
        send_email(settings, address, subject, text)
    except Exception as err:
        entry.status = "failed"
        entry.error = str(err)[:2000]
        db.add(entry)
        db.commit()
        raise HTTPException(status_code=502, detail=f"Sending failed: {err}")
    db.add(entry)
    db.commit()
    return {"status": "sent", "to": address}


@router.post("/run-now")
def run_now(user: CurrentUser = Depends(get_current_user)) -> dict:
    """One observation cycle right away, instead of waiting for the timer."""
    _require_global_admin(user)
    try:
        return run_once()
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"The check failed: {err}")


@router.get("/status")
def read_status(db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    _require_global_admin(user)
    settings = get_settings(db)
    tracked = db.query(NotificationLog).count()
    return {**poller_state, "enabled": settings.enabled, "poll_interval_seconds": settings.poll_interval_seconds, "log_entries": tracked}


@router.get("/log")
def read_log(limit: int = 100, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    _require_global_admin(user)
    rows = db.query(NotificationLog).order_by(NotificationLog.created_at.desc()).limit(max(1, min(limit, 500))).all()
    return [
        {
            "id": str(r.id),
            "created_at": r.created_at.isoformat(),
            "user_id": r.user_id,
            "email": r.email,
            "event_type": r.event_type,
            "card_id": str(r.card_id) if r.card_id else None,
            "subject": r.subject,
            "body": r.body,
            "status": r.status,
            "error": r.error,
        }
        for r in rows
    ]


def _serialize_pref(user_id: str, pref: NotificationPreference | None) -> dict:
    return {
        "user_id": user_id,
        "email_enabled": pref.email_enabled if pref else True,
        "notify_new_job": pref.notify_new_job if pref else True,
        "notify_status_change": pref.notify_status_change if pref else True,
    }


class PreferencePatch(BaseModel):
    email_enabled: bool | None = None
    notify_new_job: bool | None = None
    notify_status_change: bool | None = None


def _apply_pref(db: Session, user_id: str, body: PreferencePatch) -> dict:
    pref = db.get(NotificationPreference, user_id)
    if pref is None:
        pref = NotificationPreference(user_id=user_id)
        db.add(pref)
    for name in ("email_enabled", "notify_new_job", "notify_status_change"):
        value = getattr(body, name)
        if value is not None:
            setattr(pref, name, value)
    db.commit()
    db.refresh(pref)
    return _serialize_pref(user_id, pref)


@router.get("/preferences/me")
def read_my_preferences(db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    return {**_serialize_pref(user.subject, db.get(NotificationPreference, user.subject)), "email": user.email}


@router.put("/preferences/me")
def update_my_preferences(body: PreferencePatch, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    return {**_apply_pref(db, user.subject, body), "email": user.email}


@router.get("/preferences")
def list_preferences(db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> list[dict]:
    """Every realm user with their preferences (defaults where they never
    changed anything) and the email the service would deliver to."""
    _require_global_admin(user)
    prefs = {p.user_id: p for p in db.query(NotificationPreference).all()}
    users = list_realm_users()
    return [
        {**_serialize_pref(u["id"], prefs.get(u["id"])), "username": u.get("username"), "email": u.get("email")}
        for u in sorted(users, key=lambda u: (u.get("username") or ""))
    ]


@router.put("/preferences/{user_id}")
def update_preferences(user_id: str, body: PreferencePatch, db: Session = Depends(get_db), user: CurrentUser = Depends(get_current_user)) -> dict:
    _require_global_admin(user)
    return _apply_pref(db, user_id, body)
