from urllib.parse import parse_qs, urlparse

from shared_auth.object_links import LINK_LIFETIME_S, link_secret, sign_object_link, verify_object_link

SECRET = link_secret("minio-secret")


def _parts(link):
    q = parse_qs(urlparse(link).query)
    return q["key"][0], int(q["exp"][0]), q["sig"][0]


def test_a_signed_link_verifies_for_its_own_key_until_it_expires():
    link = sign_object_link("/data/objects", "thumbnails/a.png", SECRET, now=1_000_000)
    assert link.startswith("/data/objects?")
    key, exp, sig = _parts(link)
    assert key == "thumbnails/a.png" and exp - 1_000_000 >= LINK_LIFETIME_S
    assert verify_object_link(key, exp, sig, SECRET, now=1_000_000)
    assert not verify_object_link("thumbnails/b.png", exp, sig, SECRET, now=1_000_000)
    assert not verify_object_link(key, exp + 1, sig, SECRET, now=1_000_000)
    assert not verify_object_link(key, exp, sig, link_secret("another"), now=1_000_000)
    assert not verify_object_link(key, exp, sig, SECRET, now=exp + 1)


def test_the_same_object_keeps_one_url_within_the_hour_so_it_can_be_cached():
    a = sign_object_link("/x", "k", SECRET, now=7200 + 10)
    b = sign_object_link("/x", "k", SECRET, now=7200 + 3000)
    assert a == b


def test_an_explicit_secret_wins(monkeypatch):
    monkeypatch.setenv("OBJECT_LINK_SECRET", "s3cret")
    assert link_secret("ignored") == b"s3cret"
