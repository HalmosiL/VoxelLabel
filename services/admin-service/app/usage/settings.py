"""The recording switches (usage_settings, one row), what they mean for
one particular caller, and the retention purge."""
import time
from datetime import datetime, timedelta, timezone

from shared_models.models import UsageEvent, UsageSettings
from sqlalchemy.orm import Session

# Which switch governs which event type. focus/idle ride along with page
# tracking: they describe the session itself, not any one interaction.
CATEGORY_OF_EVENT = {
    "page_view": "track_pages",
    "page_leave": "track_pages",
    "focus": "track_pages",
    "idle": "track_pages",
    "action": "track_actions",
    "click": "track_clicks",
    "mouse_trace": "track_mouse",
    "scroll": "track_scroll",
    "key": "track_keys",
    "error": "track_errors",
    "perf": "track_perf",
    # the screen's layout behind the click heatmap: part of recording clicks
    "layout": "track_clicks",
}
CATEGORY_FLAGS = ("track_pages", "track_actions", "track_clicks", "track_mouse", "track_scroll", "track_keys", "track_errors", "track_perf")

PURGE_INTERVAL_SECONDS = 3600
_last_purge_at = 0.0


def get_settings(db: Session) -> UsageSettings:
    """The single settings row, created with defaults on first use."""
    row = db.get(UsageSettings, 1)
    if row is None:
        row = UsageSettings(id=1)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def effective_config(settings: UsageSettings, user_id: str) -> dict:
    """The category flags as they apply to `user_id`: everything off when
    the master switch is off or the person is on the excluded list,
    otherwise the per-category switches as saved. What the frontends
    fetch and what ingestion filters by, so the two can never disagree."""
    recording = bool(settings.enabled) and user_id not in (settings.disabled_user_ids or [])
    return {
        "enabled": recording,
        **{flag: recording and bool(getattr(settings, flag)) for flag in CATEGORY_FLAGS},
        "mouse_sample_ms": settings.mouse_sample_ms,
        # 0 while not recording: nobody is asked anything then either.
        "rating_every_n": settings.rating_every_n if recording else 0,
    }


def allows(config: dict, event_type: str) -> bool:
    flag = CATEGORY_OF_EVENT.get(event_type)
    return bool(flag) and bool(config.get(flag))


def purge_expired(db: Session, settings: UsageSettings, *, force: bool = False) -> int:
    """Deletes events older than retention_days -- at most once an hour
    from the ingest path (mouse traces are bulky, so this isn't optional),
    or on demand with force=True. Returns how many rows went."""
    global _last_purge_at
    now = time.monotonic()
    if not force and now - _last_purge_at < PURGE_INTERVAL_SECONDS:
        return 0
    _last_purge_at = now
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.retention_days)
    deleted = db.query(UsageEvent).filter(UsageEvent.occurred_at < cutoff).delete(synchronize_session=False)
    db.commit()
    return deleted
