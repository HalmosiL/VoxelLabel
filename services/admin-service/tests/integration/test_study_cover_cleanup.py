"""B-14: a force-deleted study, or a replaced cover, left the cover image
in object storage. A replaced cover a saved version still shows stays."""
from app.api import studies

from .conftest import make_study


def _storage(monkeypatch):
    bucket = set()
    monkeypatch.setattr(studies, "upload_study_cover_image", lambda key, data: bucket.add(key))
    monkeypatch.setattr(studies, "delete_object", lambda key: bucket.discard(key), raising=False)
    monkeypatch.setattr(studies, "delete_prefix", lambda prefix: [bucket.discard(k) for k in list(bucket) if k.startswith(prefix)], raising=False)
    return bucket


def _cover(client, sid, name):
    r = client.post(f"/admin/studies/{sid}/cover-image", files={"file": (name, b"png", "image/png")})
    assert r.status_code == 200, r.text


def test_a_replaced_cover_goes_unless_a_saved_version_shows_it(client, monkeypatch):
    bucket = _storage(monkeypatch)
    sid = make_study(client)
    _cover(client, sid, "one.png")
    _cover(client, sid, "two.png")
    assert len(bucket) == 1 and next(iter(bucket)).endswith("two.png")  # one.png was on no version

    client.post(f"/admin/studies/{sid}/versions", json={"label": "with two"})
    _cover(client, sid, "three.png")
    assert sorted(k.rsplit("-", 1)[-1] for k in bucket) == ["three.png", "two.png"]  # the version still needs two.png


def test_a_force_deleted_study_takes_its_covers(client, monkeypatch):
    bucket = _storage(monkeypatch)
    sid = make_study(client)
    other = make_study(client, "Other")
    _cover(client, sid, "one.png")
    client.post(f"/admin/studies/{sid}/versions", json={"label": "v"})
    _cover(client, sid, "two.png")
    _cover(client, other, "theirs.png")
    assert client.delete(f"/admin/studies/{sid}", params={"force": True}).status_code == 204
    assert [k.rsplit("-", 1)[-1] for k in bucket] == ["theirs.png"]
