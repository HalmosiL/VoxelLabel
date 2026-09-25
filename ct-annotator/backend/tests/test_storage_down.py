"""I-08: object storage (MinIO) unreachable answers 503 with a reason,
not a bare 500 -- opening a slice, a document or saving a mask."""
from app.storage import install_storage_error_handlers
from botocore.exceptions import EndpointConnectionError, ReadTimeoutError
from fastapi import FastAPI
from fastapi.testclient import TestClient


def test_storage_connection_errors_are_a_503():
    app = FastAPI()
    install_storage_error_handlers(app)

    @app.get("/refused")
    def refused():
        raise EndpointConnectionError(endpoint_url="http://minio:9000")

    @app.get("/hung")
    def hung():
        raise ReadTimeoutError(endpoint_url="http://minio:9000")

    client = TestClient(app)
    for path in ("/refused", "/hung"):
        r = client.get(path)
        assert r.status_code == 503 and "storage" in r.json()["detail"], r.text


def test_ready_names_what_is_down(monkeypatch):
    """/health said "ok" with storage or the platform services unreachable."""
    import httpx
    from app import main

    def storage_down():
        raise EndpointConnectionError(endpoint_url="http://minio:9000")

    class _Platform:
        async def get(self, url, **_):
            if "8003" in url or "annotation" in url:
                raise httpx.ConnectError("refused")
            return type("R", (), {"status_code": 200})()

    monkeypatch.setattr(main, "storage_check", storage_down)
    monkeypatch.setattr(main, "_http_client", _Platform())
    r = TestClient(main.app).get("/health/ready")
    assert r.status_code == 503
    checks = r.json()["checks"]
    assert checks["storage"] == "unavailable (EndpointConnectionError)" and checks["annotation-service"] == "unavailable (ConnectError)"
    assert checks["data-service"] == "ok" and checks["admin-service"] == "ok"
