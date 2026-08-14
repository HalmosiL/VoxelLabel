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
    object_storage_bucket: str = os.environ.get("OBJECT_STORAGE_BUCKET", "ct-pixel-data")
    object_storage_access_key: str = os.environ.get("OBJECT_STORAGE_ACCESS_KEY", "minioadmin")
    object_storage_secret_key: str = os.environ.get("OBJECT_STORAGE_SECRET_KEY", "minioadmin")
    staging_dir: str = os.environ.get("INGESTION_STAGING_DIR", "/tmp/ingestion-staging")


settings = Settings()
