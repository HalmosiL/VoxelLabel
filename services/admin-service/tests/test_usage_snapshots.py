"""Unit tests for app/usage/snapshots.py: a snapshot is cleaned of
scripts, event handlers, media, typed values and fetched URLs before it
is stored, and assembled into one self-contained document."""
import base64
import gzip

import pytest
from app.usage import snapshots as s


def test_html_loses_scripts_handlers_media_and_typed_values():
    html = (
        "<html><head><script>alert(1)</script><link rel='stylesheet' href='/x.css'></head><body>"
        '<button onclick="steal()">Save</button>'
        '<img src="/patient.png"><canvas width="512"></canvas><video src="v.mp4"></video>'
        '<input type="text" value="typed secret"><textarea>more secret</textarea>'
        '<div style="background-image: url(&quot;/scan.png&quot;)">panel</div>'
        "<noscript>x</noscript></body></html>"
    )
    out = s.clean_html(html)
    for gone in ("<script", "alert(1)", "onclick", "steal()", "<img", "patient.png", "<video", "<link", "typed secret", "more secret", "scan.png", "<noscript"):
        assert gone not in out, gone
    assert "<button>Save</button>" in out and out.count('data-vl-image=""') == 2  # canvas and video became placeholders
    assert 'background-image: none' in out


def test_css_loses_urls_and_imports():
    css = "@import url(/other.css); .a{background:url('/bg.png') no-repeat} @font-face{src:url(f.woff2)} .b{color:red}"
    out = s.clean_css(css)
    assert "url(" not in out and "@import" not in out and ".b{color:red}" in out


def test_document_is_self_contained_and_frozen():
    doc = s.document("<html><head><title>t</title></head><body><p>hi</p></body></html>", ".p{color:red}")
    assert doc.index(".p{color:red}") < doc.index("</head>") and "overflow:hidden" in doc and "[data-vl-image]" in doc
    assert s.document("<p>bare</p>", None).startswith("<!doctype html>")


def test_decode_accepts_plain_or_gzip_and_enforces_the_limit():
    text = "<p>" + "x" * 100 + "</p>"
    packed = base64.b64encode(gzip.compress(text.encode())).decode()
    assert s.decode(None, packed, 10_000) == text and s.decode(text, None, 10_000) == text
    with pytest.raises(s.SnapshotTooLarge):
        s.decode(None, packed, 10)
    with pytest.raises(ValueError):
        s.decode(None, "not base64!!", 10_000)


SHOT = '<img data-vl-shot="" class="pane" src="data:image/webp;base64,UklGRg==" style="position:absolute;left:0px;top:0px;width:800px;height:600px;object-fit:fill;">'


def test_case_images_are_kept_only_when_allowed_and_only_in_the_trackers_own_shape():
    html = f"<html><body><div>{SHOT}</div><img src='/scan.png'></body></html>"
    # off (the default): no picture at all
    off = s.clean_html(html)
    assert "data-vl-shot" not in off and "<img" not in off and not s.has_images(off)
    # on: exactly the tracker's picture survives, every other <img> goes
    on = s.clean_html(html, keep_images=True)
    assert SHOT in on and "scan.png" not in on and on.count("<img") == 1 and s.has_images(on)


def test_a_look_alike_image_that_could_fetch_something_is_still_dropped():
    fetching = [
        # a remote src
        '<img data-vl-shot="" src="https://evil.example/x.png" style="width:1px;">',
        # an inline picture whose style loads a URL
        '<img data-vl-shot="" src="data:image/png;base64,AAAA" style="background:url(https://evil.example/)">',
        # an SVG data URI (could carry script)
        '<img data-vl-shot="" src="data:image/svg+xml;base64,AAAA" style="width:1px;">',
        # an extra handler attribute
        '<img data-vl-shot="" src="data:image/png;base64,AAAA" style="width:1px;" onerror="x()">',
    ]
    for tag in fetching:
        out = s.clean_html(f"<body>{tag}</body>", keep_images=True)
        assert "<img" not in out and "evil" not in out and "onerror" not in out, tag


def test_a_smuggled_placeholder_token_cannot_bring_back_a_dropped_tag():
    html = f"<body>\x00shot0\x00<script>x()</script>{SHOT}</body>"
    out = s.clean_html(html, keep_images=True)
    assert out.count("<img") == 1 and "<script" not in out and "\x00" not in out
