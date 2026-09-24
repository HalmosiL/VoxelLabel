from urllib.parse import parse_qs, urlparse

import pytest
from shared_auth import object_links
from shared_auth.object_links import LINK_LIFETIME_S, link_secret, sign_object_link, verify_object_link

SECRET = link_secret("a-long-random-storage-password")
P = "/data/objects"


def _parts(link):
    q = parse_qs(urlparse(link).query)
    return q["key"][0], int(q["exp"][0]), q["sig"][0]


def test_a_signed_link_verifies_for_its_own_path_and_key_until_it_expires():
    link = sign_object_link(P, "thumbnails/a.png", SECRET, now=1_000_000)
    assert link.startswith("/data/objects?")
    key, exp, sig = _parts(link)
    assert key == "thumbnails/a.png" and exp - 1_000_000 >= LINK_LIFETIME_S
    assert verify_object_link(P, key, exp, sig, SECRET, now=1_000_000)
    assert not verify_object_link(P, "thumbnails/b.png", exp, sig, SECRET, now=1_000_000)
    assert not verify_object_link(P, key, exp + 1, sig, SECRET, now=1_000_000)
    assert not verify_object_link(P, key, exp, sig, link_secret("another-long-password"), now=1_000_000)
    assert not verify_object_link(P, key, exp, sig, SECRET, now=exp + 1)


def test_a_link_only_works_on_the_endpoint_that_issued_it():
    key, exp, sig = _parts(sign_object_link(P, "k", SECRET, now=1_000_000))
    assert not verify_object_link("/admin/objects", key, exp, sig, SECRET, now=1_000_000)


def test_an_expiry_further_out_than_any_real_link_is_refused_even_when_correctly_signed():
    far = 4_102_444_800  # 2100-01-01
    sig = object_links._signature(P, "k", far, SECRET)
    assert not verify_object_link(P, "k", far, sig, SECRET, now=1_000_000)


def test_the_same_object_keeps_one_url_within_the_hour_so_it_can_be_cached():
    assert sign_object_link(P, "k", SECRET, now=7200 + 10) == sign_object_link(P, "k", SECRET, now=7200 + 3000)


def test_an_explicit_secret_wins(monkeypatch):
    monkeypatch.setenv("OBJECT_LINK_SECRET", "s3cret")
    assert link_secret("ignored") == b"s3cret"


@pytest.mark.parametrize("default", ["minioadmin", ""])
def test_a_public_default_storage_password_never_becomes_the_secret(monkeypatch, default):
    monkeypatch.delenv("OBJECT_LINK_SECRET", raising=False)
    monkeypatch.setattr(object_links, "_process_secret", None)
    derived_from_default = __import__("hashlib").sha256(f"voxellabel-object-links:{default}".encode()).digest()
    secret = link_secret(default)
    assert secret != derived_from_default and len(secret) == 32
    # stable within the process
    assert link_secret(default) == secret


@pytest.mark.parametrize(
    ("name", "ctype", "inline"),
    [("report.pdf", "application/pdf", True), ("scan.jpg", "image/jpeg", True), ("x.html", "text/html", False), ("x.svg", "image/svg+xml", False), ("a.dcm", "application/pdf", False)],
)
def test_stored_objects_are_inline_only_when_they_cannot_run_script(name, ctype, inline):
    from shared_auth.object_links import safe_download_headers

    media, headers = safe_download_headers(name, ctype)
    assert headers["Content-Disposition"].startswith("inline" if inline else "attachment")
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert (media == ctype) if inline else (media == "application/octet-stream")


def test_a_hungarian_filename_is_header_safe():
    from shared_auth.object_links import safe_download_headers

    _, headers = safe_download_headers("zárójelentés-ő.pdf", "application/pdf")
    headers["Content-Disposition"].encode("latin-1")
    assert "filename*=UTF-8''" in headers["Content-Disposition"]
