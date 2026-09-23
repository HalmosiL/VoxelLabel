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
