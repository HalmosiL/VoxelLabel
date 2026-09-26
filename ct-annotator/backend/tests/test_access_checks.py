"""The pixel caches are shared by every user, so a cache hit must never
skip the access check (A-01), and mask payload keys outside the viewer's
own prefix are never read (A-04). data-service is faked: MEMBER may read
series S / instance I, OUTSIDER may not."""
import numpy as np
import pytest
from app import main
from app.auth import CurrentUser, get_current_user
from fastapi.testclient import TestClient

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



def test_with_a_platform_service_down_a_save_is_a_503_and_leaves_no_object(api, monkeypatch):
    """I-09: with annotation-service restarting, the save answered a bare 500
    and its uploaded mask object stayed behind in storage."""
    import httpx

    deleted = []
    monkeypatch.setattr(main, "upload_mask_volume", lambda data: "annotation-masks/new.gz")
    monkeypatch.setattr(main, "delete_mask_object", lambda key: deleted.append(key))

    async def post(url, **_):
        raise httpx.ConnectError("All connection attempts failed")

    api.fake.post = post
    api.as_user(MEMBER)
    r = api.post(f"/series/{SERIES}/mask-volume", json=_save_body("v1"))
    assert r.status_code == 503 and "try again" in r.json()["detail"], r.text
    assert deleted == ["annotation-masks/new.gz"]


def test_with_a_platform_service_down_a_read_is_a_503(api):
    import httpx

    async def get(url, **_):
        raise httpx.ConnectError("All connection attempts failed")

    api.fake.get = get
    main._access_cache.clear()
    r = api.get(f"/series/{SERIES}/mask-volume")
    assert r.status_code == 503 and "try again" in r.json()["detail"], r.text

def test_nothing_is_stored_for_someone_without_access_or_for_garbage(api, monkeypatch):
    uploaded = []
    monkeypatch.setattr(main, "upload_mask_volume", lambda data: uploaded.append(data) or "annotation-masks/x.gz")
    api.as_user(OUTSIDER)
    assert api.post(f"/series/{SERIES}/mask-volume", json=_save_body("v1")).status_code == 403
    api.as_user(MEMBER)
    assert api.post(f"/series/{SERIES}/mask-volume", json={**_save_body(), "mask_gzip_base64": "!!not base64!!"}).status_code == 422
    assert uploaded == []


def test_a_reviewers_save_says_which_handed_in_version_it_reviews(api, monkeypatch):
    """F-01: a save made while reviewing carries review_of, so it stays
    handed-in work instead of taking the case back to "not annotated"."""
    posted = []
    monkeypatch.setattr(main, "upload_mask_volume", lambda data: "annotation-masks/new.gz")

    async def post(url, params=None, json=None, headers=None):
        posted.append(params)
        return _Resp(200, {"id": "v3", "status": "draft", "review_of_id": params.get("review_of")})

    api.fake.post = post
    api.as_user(MEMBER)
    body = {**_save_body("v2"), "review_of": "v1"}
    assert api.post(f"/series/{SERIES}/mask-volume", json=body).json()["review_of_id"] == "v1"
    assert posted[-1]["review_of"] == "v1"
    api.post(f"/series/{SERIES}/mask-volume", json=_save_body("v3"))
    assert "review_of" not in posted[-1]  # an annotator's save


def test_the_loaded_version_says_whether_it_is_handed_in(api, monkeypatch):
    real_get = api.fake.get

    async def get(url, headers=None, **kw):
        if url.endswith(f"/annotations/series/{SERIES}"):
            return _Resp(200, [
                {"id": "v1", "type_id": "t", "status": "submitted", "review_of_id": None, "payload": {"mask_volume_key": "annotation-masks/a.gz", "labels": [], "objects": []}},
                {"id": "v2", "type_id": "t", "status": "draft", "review_of_id": "v1", "payload": {"mask_volume_key": "annotation-masks/b.gz", "labels": [], "objects": []}},
            ])
        return await real_get(url, headers=headers, **kw)

    async def types(user):
        return [{"id": "t", "name": "segmentation_volume"}]

    api.fake.get = get
    monkeypatch.setattr(main, "_get_annotation_types", types)
    monkeypatch.setattr(main, "download_bytes", lambda key: b"gz")
    api.as_user(MEMBER)
    r = api.get(f"/series/{SERIES}/mask-volume").json()
    assert (r["version_id"], r["version_status"], r["review_of_id"]) == ("v2", "draft", "v1")


def test_a_review_comment_is_forwarded_in_the_body(monkeypatch):
    """F-08: as a query parameter a long comment overflowed the URL -> 500."""
    sent = {}

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, params=None, json=None, headers=None):
            sent.update(params=params, json=json)
            return _Resp(200, {"id": "a1", "status": "rejected"})

    monkeypatch.setattr(main.httpx, "AsyncClient", _Client)
    app = main.app
    app.dependency_overrides[main.get_current_user] = lambda: MEMBER
    try:
        from fastapi.testclient import TestClient

        r = TestClient(app).post("/annotations/a1/review", json={"decision": "reject", "comment": "ő" * 12000})
    finally:
        app.dependency_overrides.pop(main.get_current_user, None)
    assert r.status_code == 200
    assert sent["params"] == {"decision": "reject"} and len(sent["json"]["comment"]) == 12000


def test_a_series_mixing_image_sizes_is_a_clear_422(api, monkeypatch):
    """E-11: np.stack's ValueError came out as a 500 without CORS headers,
    shown in the viewer as "Failed to fetch"."""
    main._volume_cache.clear()

    async def two_instances(url, user):
        return [{"id": "i1", "instance_number": 1}, {"id": "i2", "instance_number": 2}]

    shapes = {"i1": (4, 4), "i2": (2, 2)}

    async def dataset(instance_id, user):
        return shapes[instance_id]

    monkeypatch.setattr(main, "_series_instances_checked", two_instances)
    monkeypatch.setattr(main, "_require_series_access", lambda *a, **k: _noop())
    monkeypatch.setattr(main, "_get_dataset", dataset)
    monkeypatch.setattr(main, "rescaled_pixels", lambda shape: np.zeros(shape, dtype=np.float32))
    import asyncio

    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        asyncio.run(main._get_volume(SERIES, MEMBER))
    assert exc.value.status_code == 422 and "mixes image sizes" in exc.value.detail


async def _noop():
    return None


def test_an_upstream_error_keeps_its_own_message():
    """F-11: the whole upstream body went on as the detail -- the viewer
    showed {"detail":"{\\"detail\\":\\"Insufficient study role\\"}"}."""
    assert main._upstream_error(_Resp(403, {"detail": "Insufficient study role"})).detail == "Insufficient study role"
    plain = _Resp(502)
    assert main._upstream_error(plain).detail == plain.text


def test_the_annotation_types_are_asked_for_per_caller_not_served_from_the_cache(api, monkeypatch):
    """A-09: once a member had loaded them, the viewer's shared cache served
    the annotation types to anyone, even an account in no study."""
    calls = []

    async def proxy_get(url, user):
        calls.append(user.subject)
        if user is OUTSIDER:
            from fastapi import HTTPException

            raise HTTPException(status_code=403, detail="Insufficient study role")
        return [{"id": "t1", "name": "segmentation_volume"}]

    monkeypatch.setattr(main, "_proxy_get", proxy_get)
    monkeypatch.setattr(main, "_annotation_types_cache", None)
    api.as_user(MEMBER)
    assert api.get("/annotation-types").status_code == 200
    api.as_user(OUTSIDER)
    assert api.get("/annotation-types").status_code == 403
    assert calls == [MEMBER.subject, OUTSIDER.subject]


def test_undo_goes_to_annotation_service_and_its_refusal_comes_back(monkeypatch):
    """The viewer's "Undo" after a hand-in or a decision: annotation-service
    decides, and a 409 ("too late") reaches the viewer as a 409."""
    calls = []

    class _Resp:
        def __init__(self, code, body):
            self.status_code, self._body, self.text = code, body, str(body)

        def json(self):
            return self._body

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, **kw):
            calls.append(url)
            if url.endswith("/a2/undo"):
                return _Resp(409, {"detail": "It's too late to take this hand-in back"})
            return _Resp(200, {"id": "a1", "status": "draft"})

    monkeypatch.setattr(main.httpx, "AsyncClient", _Client)
    app = main.app
    app.dependency_overrides[main.get_current_user] = lambda: MEMBER
    try:
        from fastapi.testclient import TestClient

        ok = TestClient(app).post("/annotations/a1/undo")
        late = TestClient(app).post("/annotations/a2/undo")
    finally:
        app.dependency_overrides.pop(main.get_current_user, None)
    assert ok.status_code == 200 and ok.json()["status"] == "draft"
    assert calls[0].endswith("/annotations/a1/undo")
    assert late.status_code == 409 and "too late" in late.json()["detail"]


def test_object_stats_measure_the_mask_sent_with_the_series_hu(api, monkeypatch):
    """The review card's numbers (UX-rev-1-17): the viewer sends its mask as
    it is now, and gets each object's slices, volume, long axis and HU."""
    import base64
    import gzip
    from types import SimpleNamespace

    hu = np.array([[[40, -900], [40, 40]], [[40, 40], [40, 40]]], dtype=np.float32)
    monkeypatch.setitem(main._volume_cache, SERIES, (main.time.monotonic(), hu))
    first = SimpleNamespace(PixelSpacing=[0.5, 0.5], ImagePositionPatient=[0, 0, 0.0])

    async def dataset(instance_id, user):
        return first

    monkeypatch.setattr(main, "_get_dataset", dataset)
    mask = np.array([[[1, 1], [0, 0]], [[0, 0], [0, 2]]], dtype=np.uint8)
    body = {"mask_gzip_base64": base64.b64encode(gzip.compress(mask.tobytes())).decode()}
    api.as_user(MEMBER)
    r = api.post(f"/series/{SERIES}/object-stats", json=body)
    assert r.status_code == 200, r.text
    got = r.json()
    one = got["objects"]["1"]
    assert (one["voxels"], one["first_slice"], one["slice_count"], one["hu_min"], one["below_minus_500"]) == (2, 1, 1, -900, 0.5)
    assert got["objects"]["2"]["first_slice"] == 2
    # a mask of the wrong size is refused, and so is a caller without access
    wrong = {"mask_gzip_base64": base64.b64encode(gzip.compress(b"\x00" * 3)).decode()}
    assert api.post(f"/series/{SERIES}/object-stats", json=wrong).status_code == 422
    api.as_user(OUTSIDER)
    assert api.post(f"/series/{SERIES}/object-stats", json=body).status_code == 403


def test_the_series_spacing_is_given_for_the_ruler(api, monkeypatch):
    """The viewer's ruler turns pixels into mm with the series' own spacing."""
    from types import SimpleNamespace

    async def dataset(instance_id, user):
        return SimpleNamespace(PixelSpacing=[0.6, 0.6], SliceThickness=2.0)

    monkeypatch.setattr(main, "_get_dataset", dataset)
    api.as_user(MEMBER)
    assert api.get(f"/series/{SERIES}/spacing").json() == {"spacing_mm": [2.0, 0.6, 0.6]}
    api.as_user(OUTSIDER)
    assert api.get(f"/series/{SERIES}/spacing").status_code == 403


def test_case_answers_travel_with_the_save_and_come_back(api, monkeypatch):
    """UX-ux-admin-16: questions answered once per case ride in the payload
    beside labels/objects -- only when there are any, so a payload without
    them stays exactly as before."""
    sent = []
    monkeypatch.setattr(main, "upload_mask_volume", lambda data: "annotation-masks/new.gz")

    async def post(url, params=None, json=None, headers=None):
        sent.append(json)
        return _Resp(200, {"id": "v9", "status": "draft", "review_of_id": None})

    api.fake.post = post
    api.as_user(MEMBER)
    fields = [{"name": "Finding", "kind": "choice", "options": ["No finding", "Nodule"]}]
    api.post(f"/series/{SERIES}/mask-volume", json={**_save_body("v1"), "case_fields": fields, "case_answers": {"Finding": "No finding"}})
    assert sent[-1]["case_fields"] == fields and sent[-1]["case_answers"] == {"Finding": "No finding"}
    api.post(f"/series/{SERIES}/mask-volume", json=_save_body("v9"))
    assert "case_fields" not in sent[-1] and "case_answers" not in sent[-1]

    real_get = api.fake.get

    async def get(url, headers=None, **kw):
        if url.endswith(f"/annotations/series/{SERIES}"):
            payload = {"mask_volume_key": "annotation-masks/a.gz", "labels": [], "objects": [], "case_fields": fields, "case_answers": {"Finding": "No finding"}}
            return _Resp(200, [{"id": "v9", "type_id": "t", "status": "draft", "review_of_id": None, "payload": payload}])
        return await real_get(url, headers=headers, **kw)

    async def types(user):
        return [{"id": "t", "name": "segmentation_volume"}]

    api.fake.get = get
    monkeypatch.setattr(main, "_get_annotation_types", types)
    monkeypatch.setattr(main, "download_bytes", lambda key: b"gz")
    r = api.get(f"/series/{SERIES}/mask-volume").json()
    assert r["case_fields"] == fields and r["case_answers"] == {"Finding": "No finding"}
