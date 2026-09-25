"""C-17: an export id that was never requested answers 404, not "pending"
forever (Celery reports PENDING for any id it has never seen)."""
from app.api import routes


def test_an_unknown_export_is_a_404_and_a_requested_one_is_pending(client, monkeypatch):
    stored = {}
    monkeypatch.setattr(routes, "upload_export_object", lambda key, data: stored.__setitem__(key, data), raising=False)
    monkeypatch.setattr(routes, "object_exists", lambda key: key in stored, raising=False)

    def download(key):
        if key not in stored:
            raise KeyError(key)
        return stored[key]

    monkeypatch.setattr(routes, "download_object", download)

    class _Pending:  # what Celery says for any id -- known or not
        state, result = "PENDING", None

    monkeypatch.setattr(routes, "AsyncResult", lambda *a, **k: _Pending())
    r = client.get("/ingestion/exports/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404, r.text

    routes.record_export_request("11111111-1111-1111-1111-111111111111", "study", "someone")
    assert client.get("/ingestion/exports/11111111-1111-1111-1111-111111111111").json()["status"] == "pending"
