"""Smoke test for the admin service, runnable in isolation (no DB/Keycloak needed)."""
from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
