"""ingestion-service integration harness: a real, throwaway Postgres
(schema from the ORM models). Refuses to run unless the database name
ends in `_test`."""
import pytest
from shared_models import database
from shared_models.models import Base
from sqlalchemy import text

if not database.DATABASE_URL.rstrip("/").split("/")[-1].endswith("_test"):
    pytest.skip("integration tests need DATABASE_URL pointing at a *_test database", allow_module_level=True)


@pytest.fixture(scope="session", autouse=True)
def _schema():
    Base.metadata.drop_all(database.engine)
    Base.metadata.create_all(database.engine)
    yield


@pytest.fixture
def db():
    session = database.SessionLocal()
    try:
        yield session
    finally:
        session.close()
        tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
        with database.engine.begin() as conn:
            conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))


class Staged(dict):
    """Staging key -> dataset for a quick import run in-process; `uploaded`
    collects every dataset the pipeline stored, as stored."""

    def __init__(self):
        super().__init__()
        self.uploaded = []


@pytest.fixture
def staged(monkeypatch):
    """Staging keys resolve to in-memory datasets and nothing touches object
    storage. De-identification is the real one (a study without a profile
    passes unchanged)."""
    from app import pipeline, quick_import

    datasets = Staged()
    monkeypatch.setattr(quick_import, "download_staged_file", lambda key: key.encode())
    monkeypatch.setattr(quick_import, "delete_staged_file", lambda key: None)
    monkeypatch.setattr(quick_import.pydicom, "dcmread", lambda f, force=False: datasets[f.read().decode()])
    monkeypatch.setattr(pipeline, "upload_pixel_data", lambda key, ds: datasets.uploaded.append(ds))
    monkeypatch.setattr(pipeline, "upload_thumbnail", lambda key, png: None)
    monkeypatch.setattr(pipeline, "generate_thumbnail", lambda ds: b"png")
    return datasets
