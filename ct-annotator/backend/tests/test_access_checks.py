"""The pixel caches are shared by every user, so a cache hit must never
skip the access check (A-01), and mask payload keys outside the viewer's
own prefix are never read (A-04). data-service is faked: MEMBER may read
series S / instance I, OUTSIDER may not."""
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import main
from app.auth import CurrentUser, get_current_user

MEMBER = CurrentUser(subject="member", token="t-member")
OUTSIDER = CurrentUser(subject="outsider", token="t-outsider")
SERIES, INSTANCE = "s-1", "i-1"


class _Resp:
    def __init__(self, status, payload=None):
        self.status_code, self._payload, self.text = status, payload, "denied" if status >= 400 else "ok"

    def json(self):
        return self._payload


class _FakeDataService:
    """Answers the two RBAC checkpoints the viewer backend asks."""

    def __init__(self):
        self.calls = []

    async def get(self, url, headers=None, **_):
        token = (headers or {}).get("Authorization", "").split()[-1]
        self.calls.append((url, token))
        allowed = token == MEMBER.token
        if url.endswith(f"/data/instances/{INSTANCE}/pixel-data-url"):
            return _Resp(200, {"url": "/x", "storage_key": "k"}) if allowed else _Resp(403)
        if url.endswith(f"/data/series/{SERIES}/instances"):
            return _Resp(200, [{"id": INSTANCE, "instance_number": 1}]) if allowed else _Resp(403)
        return _Resp(404)


@pytest.fixture
def api(monkeypatch):
    fake = _FakeDataService()
    monkeypatch.setattr(main, "_http_client", fake)

    async def proxy_get(url, user):
        r = await fake.get(url, headers=main._auth_headers(user))
        if r.status_code >= 400:
            from fastapi import HTTPException

            raise HTTPException(status_code=r.status_code, detail=r.text)
        return r.json()

    monkeypatch.setattr(main, "_proxy_get", proxy_get)
    main._access_cache.clear()
    # the shared caches already hold this series/instance, as after a member opened it
    monkeypatch.setitem(main._dataset_cache, INSTANCE, (main.time.monotonic(), object()))
    monkeypatch.setitem(main._volume_cache, SERIES, (main.time.monotonic(), np.zeros((2, 2, 2), dtype=np.float32)))
    monkeypatch.setitem(main._lung_mask_cache, SERIES, (main.time.monotonic(), np.zeros((2, 2, 2), dtype=bool)))
    monkeypatch.setattr(main, "extract_metadata", lambda ds: {"rows": 2})
    holder = {"user": MEMBER}
    main.app.dependency_overrides[get_current_user] = lambda: holder["user"]
    client = TestClient(main.app)
    client.as_user = lambda u: holder.__setitem__("user", u)
    client.fake = fake
    yield client
    main.app.dependency_overrides.pop(get_current_user, None)
    main._access_cache.clear()


@pytest.mark.parametrize(
    "path",
    [
        f"/instances/{INSTANCE}/metadata",
        f"/series/{SERIES}/voxel-value?x=0&y=0&z=0",
        f"/series/{SERIES}/lung-mask",
    ],
)
def test_a_cached_image_is_not_served_to_someone_without_access(api, path):
    api.as_user(OUTSIDER)
    assert api.get(path).status_code == 403
    api.as_user(MEMBER)
    assert api.get(path).status_code == 200


def test_the_access_answer_is_remembered_per_user_not_per_image(api):
    api.as_user(MEMBER)
    for _ in range(5):
        assert api.get(f"/series/{SERIES}/voxel-value?x=0&y=0&z=0").status_code == 200
    # one check for five requests...
    assert len([c for c in api.fake.calls if c[1] == MEMBER.token]) == 1
    # ...and a series check also covers its instances
    assert api.get(f"/instances/{INSTANCE}/metadata").status_code == 200
    assert len([c for c in api.fake.calls if c[1] == MEMBER.token]) == 1
    # the member's answer never lets the outsider in
    api.as_user(OUTSIDER)
    assert api.get(f"/instances/{INSTANCE}/metadata").status_code == 403


def test_access_is_asked_again_after_the_ttl(api, monkeypatch):
    api.as_user(MEMBER)
    assert api.get(f"/instances/{INSTANCE}/metadata").status_code == 200
    real = main.time.monotonic
    monkeypatch.setattr(main.time, "monotonic", lambda: real() + main._ACCESS_TTL_SECONDS + 1)
    # caches are aged out too at this point; only the access decision matters here
    main._dataset_cache[INSTANCE] = (main.time.monotonic(), object())
    assert api.get(f"/instances/{INSTANCE}/metadata").status_code == 200
    assert len([c for c in api.fake.calls if c[1] == MEMBER.token]) == 2


def test_only_the_viewers_own_mask_keys_are_read():
    assert main._is_mask_key("annotation-masks/0b7c.gz")
    for bad in ("1.2.3/4.5/6.dcm", "annotation-masks/../x.dcm", "thumbnails/x.png", "annotation-masks\\x", None, 12):
        assert not main._is_mask_key(bad), bad


@pytest.mark.parametrize(
    ("name", "ctype", "inline"),
    [("report.pdf", "application/pdf", True), ("scan.png", "image/png", True), ("x.html", "text/html", False), ("x.svg", "image/svg+xml", False), ("x.bin", None, False)],
)
def test_documents_are_inline_only_when_they_cannot_run_script(name, ctype, inline):
    media, headers = main._safe_document_headers(name, ctype)
    assert headers["Content-Disposition"].startswith("inline" if inline else "attachment")
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert (media == ctype) if inline else (media == "application/octet-stream")
    assert ("Content-Security-Policy" in headers) is (not inline)


def test_a_hungarian_filename_is_sent_in_a_header_safe_form():
    _, headers = main._safe_document_headers("lelet-ő-ű.pdf", "application/pdf")
    headers["Content-Disposition"].encode("latin-1")  # must not raise
    assert "filename*=UTF-8''lelet-%C5%91-%C5%B1.pdf" in headers["Content-Disposition"]


def _save_body(base=None):
    import base64 as b64

    body = {"study_id": "st-1", "mask_gzip_base64": b64.b64encode(b"gz").decode(), "labels": [], "objects": []}
    if base is not None:
        body["base_version_id"] = base
    return body


def test_a_save_forwards_its_base_version_and_a_refused_one_leaves_no_object(api, monkeypatch):
    uploaded, deleted, posted = [], [], []
    monkeypatch.setattr(main, "upload_mask_volume", lambda data: uploaded.append(data) or "annotation-masks/new.gz")
    monkeypatch.setattr(main, "delete_mask_object", lambda key: deleted.append(key))

    async def post(url, params=None, json=None, headers=None):
        posted.append(params)
        return _Resp(409) if params.get("base_version_id") == "old" else _Resp(200, {"id": "v2", "status": "draft"})

    api.fake.post = post
    api.as_user(MEMBER)
    assert api.post(f"/series/{SERIES}/mask-volume", json=_save_body("v1")).status_code == 201
    assert posted[-1]["base_version_id"] == "v1"
    assert api.post(f"/series/{SERIES}/mask-volume", json=_save_body("")).status_code == 201
    assert posted[-1]["base_version_id"] == "none"
    assert api.post(f"/series/{SERIES}/mask-volume", json=_save_body()).status_code == 201
    assert "base_version_id" not in posted[-1]  # older clients: no check
    r = api.post(f"/series/{SERIES}/mask-volume", json=_save_body("old"))
    assert r.status_code == 409 and deleted == ["annotation-masks/new.gz"]


def test_nothing_is_stored_for_someone_without_access_or_for_garbage(api, monkeypatch):
    uploaded = []
    monkeypatch.setattr(main, "upload_mask_volume", lambda data: uploaded.append(data) or "annotation-masks/x.gz")
    api.as_user(OUTSIDER)
    assert api.post(f"/series/{SERIES}/mask-volume", json=_save_body("v1")).status_code == 403
    api.as_user(MEMBER)
    assert api.post(f"/series/{SERIES}/mask-volume", json={**_save_body(), "mask_gzip_base64": "!!not base64!!"}).status_code == 422
    assert uploaded == []
