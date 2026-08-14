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


settings = Settings()
