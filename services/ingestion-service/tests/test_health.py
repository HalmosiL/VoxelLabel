"""Smoke test for the ingestion service, runnable in isolation (no DB/Celery/Keycloak needed)."""
from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
