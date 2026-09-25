"""/health said "ok" while the database, storage or the task queue was
unreachable. /health stays the liveness check; /health/ready checks each
dependency and names what is down."""
from fastapi import FastAPI
from fastapi.testclient import TestClient
from shared_auth.readiness import install_readiness


def _down():
    raise ConnectionRefusedError("refused")


def test_ready_names_the_dependency_that_is_down():
    app = FastAPI()
    install_readiness(app, {"database": lambda: None, "storage": _down})
    r = TestClient(app).get("/health/ready")
    assert r.status_code == 503
    assert r.json() == {"status": "not ready", "checks": {"database": "ok", "storage": "unavailable (ConnectionRefusedError)"}}


def test_admin_service_checks_its_database_and_storage():
    from app import main

    r = TestClient(main.app).get("/health/ready")  # no storage in the test run
    assert r.status_code == 503 and set(r.json()["checks"]) == {"database", "storage"}
