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
import hashlib
import re

from shared_models.models import UsageSnapshot, UsageSnapshotStyle
from sqlalchemy.orm import Session

# Room for the case images when they are recorded (the tracker caps its
# inline pictures at ~2.5 MB of text per snapshot).
MAX_HTML_BYTES = 6_000_000
MAX_CSS_BYTES = 3_000_000
# Newest snapshots kept per (app, screen); older ones go -- the heatmap
# only needs the latest, a replay falls back to the layout outline.
KEEP_PER_SCREEN = 300
KEEP_PER_USER_SCREEN = 50

_SCRIPT = re.compile(r"<(script|noscript|template|style)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
# An opening tag with no closing one (<script src=...> cut short) -- the
# element's content can't be trusted either, so the tag goes on its own.
_SCRIPT_OPEN = re.compile(r"</?(script|noscript|template|style)\b[^>]*>", re.IGNORECASE)
# SVG elements that fetch what they reference.
_SVG_FETCH = re.compile(r"</?(image|use|feimage)\b[^>]*>", re.IGNORECASE)
# Every attribute that makes a browser load or send something.
_FETCH_ATTR = re.compile(
    r"""[\s/](?:href|xlink:href|src|srcset|poster|background|action|formaction|data|ping|lowsrc|dynsrc|longdesc|manifest|codebase|archive|cite|srcdoc)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)""",
    re.IGNORECASE,
)
# CSS functions besides url() that load images.
_CSS_FETCH_FUNC = re.compile(r"(?:-webkit-)?(?:image-set|cross-fade|element)\s*\((?:[^()]|\([^()]*\))*\)", re.IGNORECASE)
_STYLE_BREAKOUT = re.compile(r"</?\s*style", re.IGNORECASE)
_MEDIA_PAIRED = re.compile(r"<(canvas|video|audio|iframe|object|picture)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
_MEDIA_VOID = re.compile(r"<(img|embed|source|link|meta|base)\b[^>]*/?>", re.IGNORECASE)
# `[\s/]`: in HTML "<img/src=x>" is an attribute just as "<img src=x>" is.
_EVENT_ATTR = re.compile(r"""[\s/]on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)""", re.IGNORECASE)
_VALUE_ATTR = re.compile(r"""(<input\b[^>]*?)\svalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)""", re.IGNORECASE)
_TEXTAREA = re.compile(r"(<textarea\b[^>]*>).*?(</textarea\s*>)", re.IGNORECASE | re.DOTALL)
_CSS_URL = re.compile(r"url\(\s*(['\"]?)[^)]*\1\s*\)", re.IGNORECASE)
_CSS_IMPORT = re.compile(r"@import[^;]*;", re.IGNORECASE)
_STYLE_BG_URL = re.compile(r"url\(\s*(&quot;|['\"])?[^)]*?(&quot;|['\"])?\s*\)", re.IGNORECASE)
# A case image exactly as the tracker writes it (captureSnapshot): an
# inline WebP/PNG/JPEG and nothing that could fetch anything -- the only
# <img> ever kept, and only while track_screen_images is on.
SHOT_MARK = "data-vl-shot"
_SHOT = re.compile(
    r'<img data-vl-shot="" (?:class="[^"<>]*" )?src="data:image/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+" style="[^"<>()]*">'
)

# First thing in every snapshot document: nothing in it may load anything
# from anywhere (images only as data: URIs, styles only inline), whatever
# slipped past the cleaning below -- and old snapshots are covered too,
# since the document is assembled on every read.
_CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:\">"
_MAX_CLEAN_PASSES = 10

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


def clean_html(html: str, *, keep_images: bool = False) -> str:
    """No scripts, no event handlers, no media, no typed values. With
    keep_images, the tracker's inline case images survive (their style
    may hold no parentheses, so no url()); every other <img> still goes."""
    kept: list[str] = []
    if keep_images:

        def park(m: re.Match) -> str:
            kept.append(m.group(0))
            return f"\x00shot{len(kept) - 1}\x00"

        html = _SHOT.sub(park, html.replace("\x00", ""))
    # Repeated until nothing changes: removing one tag can join the text
    # around it into a new one (J-10), which the next pass then removes.
    for _ in range(_MAX_CLEAN_PASSES):
        before = html
        html = _SCRIPT.sub("", html)
        html = _SCRIPT_OPEN.sub("", html)
        html = _MEDIA_PAIRED.sub('<span data-vl-image="">image</span>', html)
        html = _MEDIA_VOID.sub("", html)
        html = _SVG_FETCH.sub("", html)
        html = _EVENT_ATTR.sub("", html)
        html = _FETCH_ATTR.sub("", html)
        html = _VALUE_ATTR.sub(r"\1", html)
        html = _TEXTAREA.sub(r"\1\2", html)
        html = _STYLE_BG_URL.sub("none", html)
        html = _CSS_FETCH_FUNC.sub("none", html)
        if html == before:
            break
    for i, tag in enumerate(kept):
        html = html.replace(f"\x00shot{i}\x00", tag)
    return html.replace("\x00", "")


def has_images(cleaned_html: str) -> bool:
    """Whether a cleaned snapshot still carries a case image -- only a
    kept tracker picture can start with this after clean_html."""
    return f"<img {SHOT_MARK}" in cleaned_html


def clean_css(css: str) -> str:
    """No background images, fonts or imports -- nothing fetched from anywhere."""
    css = _CSS_URL.sub("none", _CSS_IMPORT.sub("", css))
    css = _CSS_FETCH_FUNC.sub("none", css)
    # It goes inside a <style> element: it must not be able to close it or
    # form a tag there ("<" is escaped the CSS way, which keeps its meaning
    # inside a CSS string).
    return _STYLE_BREAKOUT.sub("", css).replace("<", "\\3c ")


def placeholder_css() -> str:
    """How the tracker's image placeholders look (it sizes them inline)."""
    return (
        "[data-vl-image]{display:inline-flex;align-items:center;justify-content:center;"
        "background:repeating-linear-gradient(45deg,#9ca3af33,#9ca3af33 6px,#9ca3af22 6px,#9ca3af22 12px);"
        "border:1px dashed #9ca3af;color:#6b7280;font:12px system-ui,sans-serif;box-sizing:border-box;overflow:hidden}"
    )


_BODY = re.compile(r"<body\b([^>]*)>(.*?)(?:</body\s*>|\Z)", re.IGNORECASE | re.DOTALL)
_HEAD = re.compile(r"<head\b.*?(?:</head\s*>|\Z)", re.IGNORECASE | re.DOTALL)
_HTML_TAG = re.compile(r"</?html\b[^>]*>|<!doctype[^>]*>", re.IGNORECASE)
_HTML_OPEN = re.compile(r"<html\b([^>]*)>", re.IGNORECASE)
_CLASS_ATTR = re.compile(r"""\sclass\s*=\s*("[^"<>]*"|'[^'<>]*')""", re.IGNORECASE)


def _class_of(attrs: str | None) -> str:
    m = _CLASS_ATTR.search(attrs or "")
    return f" class={m.group(1)}" if m else ""


def document(html: str, css: str | None) -> str:
    """One self-contained HTML document for a sandboxed iframe's srcdoc.
    Its head is always ours -- the no-fetch CSP first, then the styles --
    and only the snapshot's <body> content (and the html/body classes the
    page's CSS may hang off) comes from the stored snapshot."""
    body_match = _BODY.search(html)
    if body_match:
        body_class, body = _class_of(body_match.group(1)), body_match.group(2)
    else:
        body_class, body = "", _HTML_TAG.sub("", _HEAD.sub("", html))
    html_match = _HTML_OPEN.search(html)
    html_class = _class_of(html_match.group(1)) if html_match else ""
    styles = f"<style>{clean_css(css or '')}</style><style>{placeholder_css()}</style>{_FREEZE}"
    return f"<!doctype html><html{html_class}><head><meta charset='utf-8'>{_CSP}{styles}</head><body{body_class}>{body}</body></html>"


def gz(text: str) -> bytes:
    return gzip.compress(text.encode("utf-8"), compresslevel=6)


def ungz(blob: bytes | None) -> str | None:
    return gzip.decompress(blob).decode("utf-8", errors="replace") if blob else None


def style_key(uploader: str, client_hash: str) -> str:
    """Where one uploader's stylesheet is kept: the client's own hash,
    scoped to who sent it. The client picks the hash, and the first upload
    of a hash was kept for everyone -- one account could restyle anybody's
    snapshots (H-09). Scoped, a person only ever supplies the styles of
    their own pictures; the client still sends each stylesheet once."""
    return hashlib.sha256(f"{uploader}:{client_hash}".encode()).hexdigest()


def store_style(db: Session, css_hash: str, css: str) -> None:
    if db.get(UsageSnapshotStyle, css_hash) is None:
        db.add(UsageSnapshotStyle(css_hash=css_hash, css_gz=gz(clean_css(css))))


def trim(db: Session, app: str, route: str, user_id: str | None = None) -> None:
    """Keep only the newest KEEP_PER_USER_SCREEN snapshots of one screen
    per person, and KEEP_PER_SCREEN in all. The per-person cap means one
    account can't push everybody else's pictures out -- 300 junk uploads
    did (H-09)."""
    if user_id is not None:
        mine = (
            db.query(UsageSnapshot.id)
            .filter(UsageSnapshot.app == app, UsageSnapshot.route == route, UsageSnapshot.user_id == user_id)
            .order_by(UsageSnapshot.occurred_at.desc())
            .offset(KEEP_PER_USER_SCREEN)
            .all()
        )
        if mine:
            db.query(UsageSnapshot).filter(UsageSnapshot.id.in_([r.id for r in mine])).delete(synchronize_session=False)
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
        "has_images": bool(snap.has_images),
    }
