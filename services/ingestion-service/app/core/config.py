"""Runtime configuration for the ingestion service, read from environment variables."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str = os.environ.get(
        "DATABASE_URL", "postgresql+psycopg://ctplatform:ctplatform@localhost:5432/ctplatform"
    )
    redis_url: str = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    object_storage_endpoint: str = os.environ.get("OBJECT_STORAGE_ENDPOINT", "http://localhost:9000")
    # The browser-reachable endpoint, used only to sign PyTorch export
    # download URLs (see app/storage.py's _public_client) -- distinct from
    # object_storage_endpoint since that one is the container-internal
    # address (e.g. "http://minio:9000"), unreachable from a user's own
    # machine. Same split admin-service's own config already has.
    object_storage_public_endpoint: str = os.environ.get("OBJECT_STORAGE_PUBLIC_ENDPOINT", "http://localhost:9000")
    object_storage_bucket: str = os.environ.get("OBJECT_STORAGE_BUCKET", "ct-pixel-data")
    object_storage_access_key: str = os.environ.get("OBJECT_STORAGE_ACCESS_KEY", "minioadmin")
    object_storage_secret_key: str = os.environ.get("OBJECT_STORAGE_SECRET_KEY", "minioadmin")
    # Origins allowed to call this API directly from a browser (admin-ui
    # itself, plus the clinician-app Electron shell's own local static
    # server -- see clinician-app/main.js's STATIC_SERVER_PORT).
    cors_allowed_origins: tuple = tuple(os.environ.get("ADMIN_UI_ORIGINS", "http://localhost:5173,http://127.0.0.1:45678").split(","))


settings = Settings()
