"""Cases that appear without admin-service still reach the workflow board.

create_case (app/api/cases.py) pushes a new case through the board right
away via _cascade_new_case. A quick import, however, is ingestion-service
writing Case rows straight to the database -- a separate service that
can't call admin-service's code, from a Celery worker that holds no user
token to call its API with. Those cases used to sit in the study until
someone pressed Run (B-22).

This module closes that gap from admin-service's side, without a schema
change: a short background pass finds every study where some case is
newer than the last Run of a card wired directly downstream of an
"all cases" Dataset, and gives that study the same cascade create_case
does. Rules:

- Only cards that have been Run at least once count. A board still being
  built is never started by an import, the same as it isn't by anything
  else.
- A study is tried once per newest case. If a downstream card can't Run
  for its own reasons, its last Run time stays old, and without this
  guard the study would be retried on every pass. It gets its next try
  when another case arrives, or when someone presses Run.
- Case.created_at is the database's transaction-start time. A case whose
  import transaction started before a Run and committed after it looks
  older than that Run and is missed. That window is one file's
  processing time, and the next Run or new case picks it up.

The loop runs in-process, like the notification poller. With more than
one admin-service replica, set NEW_CASES_POLLER_ENABLED=0 on all but
one; a double cascade is only a wasted recompute, not wrong data.
"""
import asyncio
import logging
import os
import uuid
from datetime import datetime

from shared_models.database import SessionLocal
from shared_models.models import Case, WorkflowCard, WorkflowCardType
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.workflow import _cascade_new_case
from app.api.workflow.constants import _NO_RUN_TYPES
from app.api.workflow.graph import _downstream_cards

log = logging.getLogger(__name__)

INTERVAL_S = 15

# study_id -> the newest case created_at a cascade was already tried for
_tried: dict[uuid.UUID, datetime] = {}


def _cascaded_card(card: WorkflowCard) -> bool:
    """Would _cascade_run actually run this card? Criterion cards and the
    no-Run types never are, so their last Run time says nothing."""
    return card.type not in _NO_RUN_TYPES and card.type != WorkflowCardType.CRITERION


def _studies_with_new_cases(db: Session) -> dict[uuid.UUID, datetime]:
    """study_id -> its newest case's created_at, for every study with a
    case newer than the last Run of some card directly downstream of an
    "all cases" Dataset."""
    found: dict[uuid.UUID, datetime] = {}
    for dataset in db.query(WorkflowCard).filter(WorkflowCard.type == WorkflowCardType.DATASET).all():
        if (dataset.config or {}).get("mode") != "all_cases":
            continue
        runs = [c.last_run_at for c in _downstream_cards(db, dataset) if _cascaded_card(c) and c.last_run_at is not None]
        if not runs:
            continue
        newest = db.query(func.max(Case.created_at)).filter(Case.study_id == dataset.study_id).scalar()
        if newest is not None and newest > min(runs):
            found[dataset.study_id] = newest
    return found


def cascade_new_cases(db: Session) -> list[uuid.UUID]:
    """One pass: cascades every study that has new cases and hasn't been
    tried for its newest one yet. Returns the studies it cascaded."""
    done = []
    for study_id, newest in _studies_with_new_cases(db).items():
        if _tried.get(study_id) is not None and newest <= _tried[study_id]:
            continue
        _tried[study_id] = newest
        try:
            _cascade_new_case(db, study_id)
        except Exception:
            db.rollback()
            log.exception("new cases: cascade failed for study %s", study_id)
            continue
        done.append(study_id)
    return done


def _run_once() -> None:
    db = SessionLocal()
    try:
        studies = cascade_new_cases(db)
        if studies:
            log.info("new cases: pushed through the board of %d study(ies)", len(studies))
    finally:
        db.close()


async def _loop() -> None:
    await asyncio.sleep(10)  # let the service (and its migrations) come up first
    while True:
        try:
            await asyncio.to_thread(_run_once)
        except Exception:
            log.exception("new cases: pass failed")
        await asyncio.sleep(INTERVAL_S)


def start_new_cases_poller() -> None:
    if os.environ.get("NEW_CASES_POLLER_ENABLED", "1") != "1":
        log.info("new cases: poller disabled by NEW_CASES_POLLER_ENABLED")
        return
    asyncio.get_event_loop().create_task(_loop())
