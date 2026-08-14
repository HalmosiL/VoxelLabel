"""Celery worker entrypoint: `celery -A app.worker worker --loglevel=info`."""
from app.tasks import celery_app

__all__ = ["celery_app"]
