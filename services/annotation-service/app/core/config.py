"""Runtime configuration for the annotation service, read from environment variables."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str = os.environ.get(
        "DATABASE_URL", "postgresql+psycopg://ctplatform:ctplatform@localhost:5432/ctplatform"
    )
    cors_allowed_origins: tuple = tuple(os.environ.get("ADMIN_UI_ORIGINS", "http://localhost:5173").split(","))


settings = Settings()
