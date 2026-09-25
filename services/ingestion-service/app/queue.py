"""Queueing work for the Celery worker when the queue (Redis) may be down.

Every upload, quick import and export hands its work to the worker through
Redis. With Redis unreachable that answered a bare 500 and left the staged
files (or an export's request marker) behind in object storage; a status
poll answered 500 too (I-06). `enqueue` answers 503 and removes what was
staged; `install_queue_error_handlers` turns a queue error anywhere else
(a poll) into the same 503."""

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from kombu.exceptions import OperationalError
from redis.exceptions import RedisError

from app.storage import delete_staged_file

log = logging.getLogger(__name__)

QUEUE_ERRORS = (OperationalError, RedisError)
QUEUE_DOWN = "The processing queue is unavailable right now -- try again in a minute."


def enqueue(task, task_id: str, kwargs: dict, staged: list[str]) -> None:
    """Queues `task`; if the queue can't be reached, deletes the `staged`
    object keys (best effort) and answers 503."""
    try:
        task.apply_async(kwargs=kwargs, task_id=task_id)
    except Exception as err:  # noqa: BLE001 -- with Redis down Celery raises its own RuntimeError
        # ("Retry limit exceeded ... result store"), not only kombu/redis errors
        log.warning("queueing %s failed: %s", task_id, err)
        for key in staged:
            try:
                delete_staged_file(key)
            except Exception:  # noqa: BLE001 -- the 503 matters more than a leftover object
                log.warning("could not remove staged object %s", key)
        raise HTTPException(status_code=503, detail=QUEUE_DOWN) from None


def install_queue_error_handlers(app: FastAPI) -> None:
    async def queue_down(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": QUEUE_DOWN})

    for error in QUEUE_ERRORS:
        app.add_exception_handler(error, queue_down)


def queue_check() -> None:
    """For /health/ready: the task queue (Redis) answers."""
    import redis

    from app.core.config import settings

    redis.Redis.from_url(settings.redis_url, socket_connect_timeout=2, socket_timeout=2).ping()
