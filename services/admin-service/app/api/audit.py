"""The platform's audit trail for admin actions -- who created/changed/
deleted which study, case, membership, account, workflow card, version
or registration request, and when. The `audit_log` table has existed
in the schema since the initial migration; this module is what finally
writes to it (record) and reads it back (the /admin/audit-log endpoint
behind the System page's "Audit log" card).

Annotations are deliberately NOT here: they have their own versioned
history chain (Annotation.parent_version_id + AnnotationReview), which
is a richer record than a flat log line could be.

`record()` only stages the row on the caller's session -- it commits
with whatever the caller was about to commit, so an audit line never
outlives a change that was rolled back, and a change is never
committed without its line.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from shared_auth import CurrentUser, get_current_user
from shared_models.database import get_db
from shared_models.models import AuditLog
from sqlalchemy.orm import Session

from app.keycloak_admin import list_realm_users

router = APIRouter(prefix="/admin", tags=["admin:audit"])


def record(db: Session, user: CurrentUser, action: str, entity_type: str, entity_id, diff: dict | None = None) -> None:
    """Stage one audit line. `action` is "<entity>.<verb>" ("study.update",
    "member.add", "user.reset_password"); `entity_id` anything
    uuid.UUID() accepts (Keycloak subjects are UUIDs too) -- or a name
    (a backup file, an annotation type, "usage" settings), which gets a
    stable UUID5 of its own; put the name in `diff` to keep it readable."""
    try:
        entity_uuid = uuid.UUID(str(entity_id))
    except ValueError:
        entity_uuid = uuid.uuid5(uuid.NAMESPACE_URL, f"voxellabel:{entity_type}:{entity_id}")
    db.add(
        AuditLog(
            actor_id=user.subject,
            action=action,
            entity_type=entity_type,
            entity_id=entity_uuid,
            diff=diff,
        )
    )


@router.get("/audit-log")
def list_audit_log(
    limit: int = Query(100, ge=1, le=1000),
    entity_type: str | None = None,
    entity_id: str | None = None,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Newest first. Global admin only -- this is the one place every
    study's changes are visible side by side. Actor names are resolved
    from Keycloak once per call (best-effort: an unreachable Keycloak
    still returns the log, just with bare subject ids)."""
    if "admin" not in user.realm_roles:
        raise HTTPException(status_code=403, detail="Admin realm role required")
    query = db.query(AuditLog)
    if entity_type:
        query = query.filter(AuditLog.entity_type == entity_type)
    if entity_id:
        try:
            query = query.filter(AuditLog.entity_id == uuid.UUID(entity_id))
        except ValueError:
            raise HTTPException(status_code=422, detail="entity_id must be a UUID") from None
    rows = query.order_by(AuditLog.created_at.desc()).limit(limit).all()
    try:
        actors = {u["id"]: (u.get("username") or u["id"]) for u in list_realm_users()}
    except Exception:  # noqa: BLE001 -- names are a nicety, the log itself is the point
        actors = {}
    return {
        "entries": [
            {
                "id": str(r.id),
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "actor_id": r.actor_id,
                "actor": actors.get(r.actor_id, r.actor_id),
                "action": r.action,
                "entity_type": r.entity_type,
                "entity_id": str(r.entity_id),
                "diff": r.diff,
            }
            for r in rows
        ]
    }
