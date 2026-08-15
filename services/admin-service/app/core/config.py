"""Runtime configuration for the admin service, read from environment variables."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str = os.environ.get(
        "DATABASE_URL", "postgresql+psycopg://ctplatform:ctplatform@localhost:5432/ctplatform"
    )
    # Origins allowed to call this API directly from a browser (the admin-ui
    # dev server / deployment). Comma-separated.
    cors_allowed_origins: tuple = tuple(os.environ.get("ADMIN_UI_ORIGINS", "http://localhost:5173").split(","))
    # Real uploads happen here (unlike data-service, which only signs
    # presigned URLs) -- must be reachable from inside this container, so
    # the internal hostname, not the browser-facing one.
    object_storage_endpoint: str = os.environ.get("OBJECT_STORAGE_ENDPOINT", "http://localhost:9000")
    # For presigning URLs this service hands back to the browser (project
    # cover images) -- must be the browser-reachable published port, same
    # reasoning as data-service's OBJECT_STORAGE_ENDPOINT. See
    # services/data-service/app/storage.py.
    object_storage_public_endpoint: str = os.environ.get("OBJECT_STORAGE_PUBLIC_ENDPOINT", "http://localhost:9000")
    object_storage_bucket: str = os.environ.get("OBJECT_STORAGE_BUCKET", "ct-pixel-data")
    object_storage_access_key: str = os.environ.get("OBJECT_STORAGE_ACCESS_KEY", "minioadmin")
    object_storage_secret_key: str = os.environ.get("OBJECT_STORAGE_SECRET_KEY", "minioadmin")


settings = Settings()
