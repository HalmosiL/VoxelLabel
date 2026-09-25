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
