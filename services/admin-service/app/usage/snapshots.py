"""Screen snapshots: a screen's HTML as someone saw it, drawn behind the
click heatmap and the session replay.

The tracker (captureSnapshot) already swaps every image, canvas, video
and iframe for a grey placeholder, drops scripts and typed values, and
sends the page's stylesheets once per content hash. This module does the
same cleaning again on the way in -- a snapshot is only ever rendered in
a sandboxed iframe with scripts off, but it is still not trusted -- and
assembles the stored parts into one HTML document for that iframe.

Pure functions plus small DB helpers; the endpoints are in api.py."""
import base64
import gzip
import re

from shared_models.models import UsageSnapshot, UsageSnapshotStyle
from sqlalchemy.orm import Session

MAX_HTML_BYTES = 4_000_000
MAX_CSS_BYTES = 3_000_000
# Newest snapshots kept per (app, screen); older ones go -- the heatmap
# only needs the latest, a replay falls back to the layout outline.
KEEP_PER_SCREEN = 50

_SCRIPT = re.compile(r"<(script|noscript|template)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
_MEDIA_PAIRED = re.compile(r"<(canvas|video|audio|iframe|object|picture)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
_MEDIA_VOID = re.compile(r"<(img|embed|source|link|meta|base)\b[^>]*/?>", re.IGNORECASE)
_EVENT_ATTR = re.compile(r"""\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)""", re.IGNORECASE)
_VALUE_ATTR = re.compile(r"""(<input\b[^>]*?)\svalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)""", re.IGNORECASE)
_TEXTAREA = re.compile(r"(<textarea\b[^>]*>).*?(</textarea\s*>)", re.IGNORECASE | re.DOTALL)
_CSS_URL = re.compile(r"url\(\s*(['\"]?)[^)]*\1\s*\)", re.IGNORECASE)
_CSS_IMPORT = re.compile(r"@import[^;]*;", re.IGNORECASE)
_STYLE_BG_URL = re.compile(r"url\(\s*(&quot;|['\"])?[^)]*?(&quot;|['\"])?\s*\)", re.IGNORECASE)

# Makes the frozen page sit still and never scroll inside its frame.
_FREEZE = "<style>html,body{overflow:hidden!important}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}</style>"


class SnapshotTooLarge(ValueError):
    pass


def decode(text: str | None, gz_b64: str | None, limit: int) -> str | None:
    """A snapshot part from the request: plain text, or gzip in base64."""
    if gz_b64:
        try:
            raw = gzip.decompress(base64.b64decode(gz_b64, validate=True))
        except (ValueError, OSError) as exc:
            raise ValueError("not valid gzip/base64") from exc
        if len(raw) > limit:
            raise SnapshotTooLarge(f"larger than {limit} bytes")
        return raw.decode("utf-8", errors="replace")
    if text is not None and len(text.encode("utf-8")) > limit:
        raise SnapshotTooLarge(f"larger than {limit} bytes")
    return text


def clean_html(html: str) -> str:
    """No scripts, no event handlers, no media, no typed values."""
    html = _SCRIPT.sub("", html)
    html = _MEDIA_PAIRED.sub('<span data-vl-image="">image</span>', html)
    html = _MEDIA_VOID.sub("", html)
    html = _EVENT_ATTR.sub("", html)
    html = _VALUE_ATTR.sub(r"\1", html)
    html = _TEXTAREA.sub(r"\1\2", html)
    html = _STYLE_BG_URL.sub("none", html)
    return html


def clean_css(css: str) -> str:
    """No background images, fonts or imports -- nothing fetched from anywhere."""
    return _CSS_URL.sub("none", _CSS_IMPORT.sub("", css))


def placeholder_css() -> str:
    """How the tracker's image placeholders look (it sizes them inline)."""
    return (
        "[data-vl-image]{display:inline-flex;align-items:center;justify-content:center;"
        "background:repeating-linear-gradient(45deg,#9ca3af33,#9ca3af33 6px,#9ca3af22 6px,#9ca3af22 12px);"
        "border:1px dashed #9ca3af;color:#6b7280;font:12px system-ui,sans-serif;box-sizing:border-box;overflow:hidden}"
    )


def document(html: str, css: str | None) -> str:
    """One self-contained HTML document for a sandboxed iframe's srcdoc."""
    styles = f"<style>{css or ''}</style><style>{placeholder_css()}</style>{_FREEZE}"
    head_end = re.search(r"</head\s*>", html, re.IGNORECASE)
    if head_end:
        return html[: head_end.start()] + styles + html[head_end.start() :]
    return f"<!doctype html><html><head><meta charset='utf-8'>{styles}</head><body>{html}</body></html>"


def gz(text: str) -> bytes:
    return gzip.compress(text.encode("utf-8"), compresslevel=6)


def ungz(blob: bytes | None) -> str | None:
    return gzip.decompress(blob).decode("utf-8", errors="replace") if blob else None


def store_style(db: Session, css_hash: str, css: str) -> None:
    if db.get(UsageSnapshotStyle, css_hash) is None:
        db.add(UsageSnapshotStyle(css_hash=css_hash, css_gz=gz(clean_css(css))))


def trim(db: Session, app: str, route: str) -> None:
    """Keep only the newest KEEP_PER_SCREEN snapshots of one screen."""
    old = (
        db.query(UsageSnapshot.id)
        .filter(UsageSnapshot.app == app, UsageSnapshot.route == route)
        .order_by(UsageSnapshot.occurred_at.desc())
        .offset(KEEP_PER_SCREEN)
        .all()
    )
    if old:
        db.query(UsageSnapshot).filter(UsageSnapshot.id.in_([r.id for r in old])).delete(synchronize_session=False)


def as_document(db: Session, snap: UsageSnapshot) -> str:
    style = db.get(UsageSnapshotStyle, snap.css_hash) if snap.css_hash else None
    return document(ungz(snap.html_gz) or "", ungz(style.css_gz) if style else None)


def meta(snap: UsageSnapshot) -> dict:
    return {
        "id": str(snap.id),
        "route": snap.route,
        "app": snap.app,
        "app_version": snap.app_version,
        "job_id": snap.job_id,
        "viewport": [snap.viewport_w, snap.viewport_h],
        "occurred_at": snap.occurred_at.isoformat() if snap.occurred_at else None,
        "study_id": snap.study_id,
        "structure_key": snap.structure_key,
    }
