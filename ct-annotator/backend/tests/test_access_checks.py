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
