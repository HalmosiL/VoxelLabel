"""The background loop that runs the notification service's observation
cycle inside this process -- no extra container or scheduler. Reads its
interval from the settings row each pass, so changing it in the admin UI
takes effect without a restart. With more than one admin-service
replica every replica would poll; set NOTIFICATIONS_POLLER_ENABLED=0 on
all but one in that case.

Only one cycle runs at a time, across threads and replicas: run_once
holds a Postgres advisory lock for the whole pass. Overlapping passes --
a double click on "Check for changes now", or a click during the
poller's own pass -- used to send every email several times (D-04); now
the second one raises CycleBusy (run-now answers 409, the loop skips)."""
import asyncio
import logging
import os
from datetime import datetime, timezone

from shared_models.database import engine, get_db
from sqlalchemy import text

from .events import get_settings, run_cycle

log = logging.getLogger(__name__)

# In-memory view of the loop for the admin UI's status card.
poller_state: dict = {"running": False, "last_run_at": None, "last_result": None, "last_error": None, "next_run_at": None}


# Any fixed 64-bit number, unique to this lock among the platform's advisory locks.
_CYCLE_LOCK_KEY = 0x6E6F7469667963  # "notifyc"


class CycleBusy(Exception):
    """Another notification cycle is running right now."""


def run_once() -> dict:
    # A dedicated connection holds the (session-level) lock for the whole
    # pass: the cycle's own session commits along the way, so a lock taken
    # inside it would not last.
    with engine.connect() as lock_conn:
        if not lock_conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _CYCLE_LOCK_KEY}).scalar():
            raise CycleBusy()
        try:
            return _run_locked()
        finally:
            lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _CYCLE_LOCK_KEY})
            lock_conn.commit()


def _run_locked() -> dict:
    db = next(get_db())
    try:
        result = run_cycle(db)
        poller_state["last_run_at"] = datetime.now(timezone.utc).isoformat()
        poller_state["last_result"] = result
        poller_state["last_error"] = None
        return result
    except Exception as err:
        db.rollback()
        poller_state["last_run_at"] = datetime.now(timezone.utc).isoformat()
        poller_state["last_error"] = str(err)[:2000]
        log.exception("notification service: cycle failed")
        raise
    finally:
        db.close()


def _current_interval() -> int:
    db = next(get_db())
    try:
        return max(10, int(get_settings(db).poll_interval_seconds))
    except Exception:
        return 60
    finally:
        db.close()


async def _loop() -> None:
    poller_state["running"] = True
    # A short first delay so the service is fully up (and the DB
    # migrated) before the first pass.
    await asyncio.sleep(5)
    while True:
        try:
            await asyncio.to_thread(run_once)
        except CycleBusy:
            pass  # a manual check is running this very moment -- it covers this pass
        except Exception:
            pass  # already logged and recorded in poller_state
        interval = await asyncio.to_thread(_current_interval)
        poller_state["next_run_at"] = datetime.fromtimestamp(
            datetime.now(timezone.utc).timestamp() + interval, tz=timezone.utc
        ).isoformat()
        await asyncio.sleep(interval)


def start_poller() -> None:
    if os.environ.get("NOTIFICATIONS_POLLER_ENABLED", "1") != "1":
        log.info("notification service: poller disabled by NOTIFICATIONS_POLLER_ENABLED")
        return
    asyncio.get_event_loop().create_task(_loop())
