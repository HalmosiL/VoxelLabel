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
issues the link has already checked the caller's role. It covers the
path, the key and the expiry, so a link only works on the endpoint that
issued it. Links expire; the expiry is rounded up to the next full hour
plus one, so the same object keeps the same URL for about an hour and
the browser can cache it -- and an expiry further out than that is
refused, so no "forever" link can be made even with the secret.
"""
import hashlib
import hmac
import logging
import os
import secrets
import time
from urllib.parse import urlencode

LINK_LIFETIME_S = 3600
# The latest expiry sign_object_link can produce is < 2 * LINK_LIFETIME_S
# away; anything beyond that (plus a little clock slack) was not signed here.
_MAX_EXP_AHEAD_S = 2 * LINK_LIFETIME_S + 300
# Storage passwords that are public knowledge (.env.example, MinIO's own
# default) -- a secret derived from one of them could be recomputed by anyone.
_PUBLIC_DEFAULTS = {"minioadmin", ""}
_log = logging.getLogger(__name__)
_process_secret: bytes | None = None


def link_secret(fallback_material: str) -> bytes:
    """OBJECT_LINK_SECRET when set; else derived from the storage secret
    (every service has it, and INSTALL.md has it set to a long random
    value); but never from a publicly known default password -- then a
    random secret for this process is used instead (links then stop
    working when the service restarts, and a warning says why)."""
    global _process_secret
    explicit = os.environ.get("OBJECT_LINK_SECRET")
    if explicit:
        return explicit.encode()
    if fallback_material in _PUBLIC_DEFAULTS:
        if _process_secret is None:
            _log.warning(
                "OBJECT_LINK_SECRET is not set and the storage password is a public default -- "
                "using a random per-process secret for signed object links. Set OBJECT_LINK_SECRET."
            )
            _process_secret = secrets.token_bytes(32)
        return _process_secret
    return hashlib.sha256(f"voxellabel-object-links:{fallback_material}".encode()).digest()


def _signature(path: str, key: str, exp: int, secret: bytes) -> str:
    return hmac.new(secret, f"{path}\n{key}\n{exp}".encode(), hashlib.sha256).hexdigest()


def sign_object_link(path: str, key: str, secret: bytes, now: float | None = None) -> str:
    """`path` (e.g. "/data/objects") with key, expiry and signature."""
    t = int(now if now is not None else time.time())
    exp = (t // LINK_LIFETIME_S + 2) * LINK_LIFETIME_S
    return f"{path}?{urlencode({'key': key, 'exp': exp, 'sig': _signature(path, key, exp, secret)})}"


def verify_object_link(path: str, key: str, exp: int, sig: str, secret: bytes, now: float | None = None) -> bool:
    """True only for a link this service signed for `path`, not yet expired
    and not claiming an expiry further out than it could ever have made."""
    t = now if now is not None else time.time()
    if exp < t or exp > t + _MAX_EXP_AHEAD_S:
        return False
    return hmac.compare_digest(_signature(path, key, exp, secret), sig or "")


# What a stored object may be shown as in the browser. Anything else --
# HTML, SVG (which can carry script), XML, unknown types -- is served as
# a download, so an uploaded document can never run in the API's origin.
INLINE_SAFE_TYPES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "text/plain",
}


def safe_download_headers(filename: str, content_type: str) -> tuple[str, dict]:
    """(content type to send, headers) for serving a stored object: inline
    only for INLINE_SAFE_TYPES, otherwise an attachment; never sniffed,
    and sandboxed even if a browser did render it. The filename is sent
    both ASCII-safe and RFC 5987-encoded (non-Latin-1 names used to fail)."""
    from urllib.parse import quote

    base_type = (content_type or "application/octet-stream").split(";")[0].strip().lower()
    inline = base_type in INLINE_SAFE_TYPES and not filename.lower().endswith(".dcm")
    ascii_name = "".join(c if 32 <= ord(c) < 127 and c not in '"\\' else "_" for c in filename) or "file"
    disposition = f"{'inline' if inline else 'attachment'}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"
    headers = {"Content-Disposition": disposition, "X-Content-Type-Options": "nosniff"}
    # A PDF or an image can't run script (and a sandbox would switch off
    # the browser's own PDF viewer); everything else is also sandboxed in
    # case a browser renders it anyway.
    if not inline or base_type == "text/plain":
        headers["Content-Security-Policy"] = "sandbox; default-src 'none'"
    return (content_type if inline else "application/octet-stream"), headers
