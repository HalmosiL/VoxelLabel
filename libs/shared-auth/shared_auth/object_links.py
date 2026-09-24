"""Signed links to stored objects, served by the service's own API.

A thumbnail, a document or a DICOM file used to reach the browser as a
MinIO presigned URL -- signed for PUBLIC_MINIO_URL, so it only worked
where the browser could reach MinIO's port directly. Behind a firewall,
a reverse proxy or an unset PUBLIC_MINIO_URL (it defaults to
localhost:9000) every image stayed blank. A signed link instead points
at the API the browser already talks to (`/data/objects?...`): the
service checks the signature and streams the object from MinIO over
the internal network.

The signature is the access check, like a presigned URL's: whoever
issues the link has already checked the caller's role. Links expire; the
expiry is rounded up to the next full hour plus one, so the same object
keeps the same URL for about an hour and the browser can cache it.
"""
import hashlib
import hmac
import os
import time
from urllib.parse import urlencode

LINK_LIFETIME_S = 3600


def link_secret(fallback_material: str) -> bytes:
    """OBJECT_LINK_SECRET when set, else derived from the storage secret --
    every service already has that, so nothing new has to be configured."""
    explicit = os.environ.get("OBJECT_LINK_SECRET")
    if explicit:
        return explicit.encode()
    return hashlib.sha256(f"voxellabel-object-links:{fallback_material}".encode()).digest()


def _signature(key: str, exp: int, secret: bytes) -> str:
    return hmac.new(secret, f"{key}\n{exp}".encode(), hashlib.sha256).hexdigest()


def sign_object_link(path: str, key: str, secret: bytes, now: float | None = None) -> str:
    """`path` (e.g. "/data/objects") with key, expiry and signature."""
    t = int(now if now is not None else time.time())
    exp = (t // LINK_LIFETIME_S + 2) * LINK_LIFETIME_S
    return f"{path}?{urlencode({'key': key, 'exp': exp, 'sig': _signature(key, exp, secret)})}"


def verify_object_link(key: str, exp: int, sig: str, secret: bytes, now: float | None = None) -> bool:
    t = now if now is not None else time.time()
    if exp < t:
        return False
    return hmac.compare_digest(_signature(key, exp, secret), sig or "")
