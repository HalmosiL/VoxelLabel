"""Integration harness for data-service: the real app on a real, throwaway
Postgres (schema from the ORM models), auth as a dependency override
(a global admin). Refuses to run unless the database name ends in `_test`."""
import pytest
from fastapi.testclient import TestClient
from shared_auth import CurrentUser, get_current_user
from shared_models import database
from shared_models.models import Base

if not database.DATABASE_URL.rstrip("/").split("/")[-1].endswith("_test"):
    pytest.skip("integration tests need DATABASE_URL pointing at a *_test database", allow_module_level=True)

from app.main import app  # noqa: E402

ADMIN = "00000000-0000-4000-8000-0000000000a1"


@pytest.fixture(scope="session", autouse=True)
def _schema():
    Base.metadata.drop_all(database.engine)
    Base.metadata.create_all(database.engine)
    yield


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(subject=ADMIN, email=None, realm_roles=["admin"])
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)
