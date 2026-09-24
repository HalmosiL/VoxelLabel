"""/data/objects: a signed link streams the object; anything else is refused."""
import io
from urllib.parse import parse_qs, urlparse

from app import storage
from app.api import routes
from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)


class _Body(io.BytesIO):
    def iter_chunks(self, size):
        while chunk := self.read(size):
            yield chunk


def test_a_signed_link_streams_the_object_without_a_token(monkeypatch):
    monkeypatch.setattr(routes, "read_object", lambda key: (_Body(b"\x89PNG-bytes"), "image/png", 10))
    link = storage.object_link("thumbnails/abc.png")
    assert link.startswith("/data/objects?")
    r = client.get(link)
    assert r.status_code == 200 and r.content == b"\x89PNG-bytes" and r.headers["content-type"] == "image/png"
    assert r.headers["content-disposition"].startswith("inline")


def test_a_dicom_downloads_as_an_attachment(monkeypatch):
    monkeypatch.setattr(routes, "read_object", lambda key: (_Body(b"DICM"), "application/octet-stream", 4))
    r = client.get(storage.object_link("1.2/3.4/5.6.dcm"))
    assert r.status_code == 200 and r.headers["content-disposition"].startswith('attachment; filename="5.6.dcm"')


def test_a_tampered_or_foreign_link_is_refused(monkeypatch):
    monkeypatch.setattr(routes, "read_object", lambda key: (_Body(b"secret"), "application/pdf", 6))
    q = parse_qs(urlparse(storage.object_link("docs/a.pdf")).query)
    other = client.get("/data/objects", params={"key": "docs/b.pdf", "exp": q["exp"][0], "sig": q["sig"][0]})
    assert other.status_code == 403
    assert client.get("/data/objects", params={"key": "docs/a.pdf", "exp": 1, "sig": q["sig"][0]}).status_code == 403
    assert client.get("/data/objects", params={"key": "docs/a.pdf"}).status_code == 422


def test_an_uploaded_html_or_svg_document_is_a_download_never_active_content(monkeypatch):
    for key, ctype in (("docs/report.html", "text/html"), ("docs/x.svg", "image/svg+xml")):
        monkeypatch.setattr(routes, "read_object", lambda k, ct=ctype: (_Body(b"<script>alert(1)</script>"), ct, 25))
        r = client.get(storage.object_link(key))
        assert r.status_code == 200
        assert r.headers["content-disposition"].startswith("attachment")
        assert r.headers["content-type"] == "application/octet-stream"
        assert r.headers["x-content-type-options"] == "nosniff"
        assert "sandbox" in r.headers["content-security-policy"]
