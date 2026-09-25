"""I-08: with object storage (MinIO) unreachable, every request that
touched it answered a bare 500 after several seconds of retries. Now a
503 that says storage is unavailable."""
import uuid

from app.api import routes
from botocore.exceptions import EndpointConnectionError
from shared_models.models import Study


def test_an_upload_with_storage_down_is_a_503(client, db, monkeypatch):
    study = Study(name=f"qa-storage-{uuid.uuid4().hex[:6]}")
    db.add(study)
    db.commit()

    def refuse(key, data):
        raise EndpointConnectionError(endpoint_url="http://minio:9000/ct-pixel-data")

    monkeypatch.setattr(routes, "upload_staged_file", refuse)
    r = client.post(f"/ingestion/studies/{study.id}/quick-import", files=[("files", ("a.dcm", b"x"))])
    assert r.status_code == 503 and "storage" in r.json()["detail"], r.text
