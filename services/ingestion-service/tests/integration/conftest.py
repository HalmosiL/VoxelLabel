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
