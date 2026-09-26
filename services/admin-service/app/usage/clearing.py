"""Clearing the usage log -- and undoing it.

A clear moves every usage event and screen snapshot out of the live
tables into their archive twins, stamped with one UsageClear id; the
Usage page (and study analytics' working time, which reads the same
events) then starts from empty. A restore moves that clear's rows back;
anything recorded since the clear stays, so the two simply merge. A
permanent delete drops the archived rows and keeps the UsageClear row
as the record of what happened.

Each move is a single statement (DELETE ... RETURNING feeding an
INSERT), so an event that arrives mid-clear is either moved or stays
live -- never lost in between. Column lists come from the models, so a
column added to UsageEventFields/UsageSnapshotFields is carried along
without touching this file.

Stylesheets (usage_snapshot_styles) are shared and stay where they are;
the retention purge keeps any that an archived snapshot still needs.
"""
from datetime import datetime, timezone

from shared_models.models import UsageClear, UsageEvent, UsageEventArchive, UsageSnapshot, UsageSnapshotArchive
from sqlalchemy import func, text
from sqlalchemy.orm import Session

# live table model -> archive table model
PAIRS = ((UsageEvent, UsageEventArchive), (UsageSnapshot, UsageSnapshotArchive))


class ClearStateError(ValueError):
    """The clear can't do that any more (already restored or deleted)."""


def _columns(live) -> str:
    return ", ".join(f'"{c.name}"' for c in live.__table__.columns)


def _move_out(db: Session, live, archive, clear_id) -> int:
    cols = _columns(live)
    sql = (
        f"WITH moved AS (DELETE FROM {live.__tablename__} RETURNING {cols}) "
        f"INSERT INTO {archive.__tablename__} (clear_id, {cols}) SELECT :clear_id, {cols} FROM moved"
    )
    return db.execute(text(sql), {"clear_id": clear_id}).rowcount or 0


def _move_back(db: Session, live, archive, clear_id) -> int:
    cols = _columns(live)
    sql = (
        f"WITH moved AS (DELETE FROM {archive.__tablename__} WHERE clear_id = :clear_id RETURNING {cols}) "
        f"INSERT INTO {live.__tablename__} ({cols}) SELECT {cols} FROM moved ON CONFLICT (id) DO NOTHING"
    )
    return db.execute(text(sql), {"clear_id": clear_id}).rowcount or 0


def live_counts(db: Session) -> dict:
    return {"events": db.query(func.count(UsageEvent.id)).scalar() or 0, "snapshots": db.query(func.count(UsageSnapshot.id)).scalar() or 0}


def clear_all(db: Session, actor: str) -> UsageClear | None:
    """Moves the whole live log into the archive under a new clear.
    None (and nothing written) when there was nothing to clear. The
    caller commits."""
    clear = UsageClear(cleared_by=actor)
    db.add(clear)
    db.flush()
    clear.events = _move_out(db, UsageEvent, UsageEventArchive, clear.id)
    clear.snapshots = _move_out(db, UsageSnapshot, UsageSnapshotArchive, clear.id)
    if clear.events == 0 and clear.snapshots == 0:
        db.delete(clear)
        db.flush()
        return None
    first, last = db.query(func.min(UsageEventArchive.occurred_at), func.max(UsageEventArchive.occurred_at)).filter(UsageEventArchive.clear_id == clear.id).one()
    clear.first_at, clear.last_at = first, last
    return clear


def _check_open(clear: UsageClear) -> None:
    if clear.restored_at is not None:
        raise ClearStateError("This clear has already been restored.")
    if clear.deleted_at is not None:
        raise ClearStateError("This clear's data has been deleted for good -- there is nothing to restore.")


def restore(db: Session, clear: UsageClear, actor: str) -> dict:
    """Puts a clear's archived rows back in the live log. Returns how
    many came back (fewer than were cleared when the retention period
    has since removed the oldest). The caller commits."""
    _check_open(clear)
    back = {"events": _move_back(db, UsageEvent, UsageEventArchive, clear.id), "snapshots": _move_back(db, UsageSnapshot, UsageSnapshotArchive, clear.id)}
    clear.restored_at = datetime.now(timezone.utc)
    clear.restored_by = actor
    return back


def delete_for_good(db: Session, clear: UsageClear, actor: str) -> None:
    """Drops a clear's archived rows; the clear itself stays as a record.
    The caller commits."""
    _check_open(clear)
    for _, archive in PAIRS:
        db.query(archive).filter(archive.clear_id == clear.id).delete(synchronize_session=False)
    clear.deleted_at = datetime.now(timezone.utc)
    clear.deleted_by = actor


def archived_counts(db: Session) -> dict[str, dict]:
    """clear id -> how many of its rows are still in the archive."""
    out: dict[str, dict] = {}
    for key, archive in (("events", UsageEventArchive), ("snapshots", UsageSnapshotArchive)):
        for clear_id, n in db.query(archive.clear_id, func.count(archive.id)).group_by(archive.clear_id).all():
            out.setdefault(str(clear_id), {"events": 0, "snapshots": 0})[key] = n
    return out


def status_of(clear: UsageClear, remaining: dict | None) -> str:
    """restored | deleted | expired (the retention period took all of
    it) | archived (restorable)."""
    if clear.restored_at is not None:
        return "restored"
    if clear.deleted_at is not None:
        return "deleted"
    if not remaining or (remaining["events"] == 0 and remaining["snapshots"] == 0):
        return "expired"
    return "archived"


def serialize(clear: UsageClear, remaining: dict | None, names: dict[str, dict]) -> dict:
    def who(subject: str | None) -> str | None:
        return (names.get(subject) or {}).get("name") or (names.get(subject) or {}).get("username", subject) if subject else None

    def when(value) -> str | None:
        return value.isoformat() if value else None

    return {
        "id": str(clear.id),
        "cleared_at": when(clear.cleared_at),
        "cleared_by": who(clear.cleared_by),
        "events": clear.events,
        "snapshots": clear.snapshots,
        "first_at": when(clear.first_at),
        "last_at": when(clear.last_at),
        "remaining": remaining or {"events": 0, "snapshots": 0},
        "status": status_of(clear, remaining),
        "restored_at": when(clear.restored_at),
        "restored_by": who(clear.restored_by),
        "deleted_at": when(clear.deleted_at),
        "deleted_by": who(clear.deleted_by),
    }
