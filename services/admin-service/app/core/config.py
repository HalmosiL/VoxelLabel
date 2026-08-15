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
    # For calling Keycloak's own Admin API (listing realm users for the
    # project-member picker) -- a real server-to-server call, so the
    # internal hostname, not the browser-facing KEYCLOAK_ISSUER.
    keycloak_internal_url: str = os.environ.get("KEYCLOAK_INTERNAL_URL", "http://keycloak:8080")
    keycloak_realm: str = os.environ.get("KEYCLOAK_REALM", "ct-platform")
    keycloak_admin_client_id: str = os.environ.get("KEYCLOAK_ADMIN_CLIENT_ID", "admin-service-account")
    keycloak_admin_client_secret: str = os.environ.get("KEYCLOAK_ADMIN_CLIENT_SECRET", "admin-service-account-secret")


settings = Settings()
