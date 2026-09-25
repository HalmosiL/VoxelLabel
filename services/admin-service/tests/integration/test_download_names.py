"""H-07: the admin-ui runs on another origin, so it can read a download's
dated file name (Content-Disposition) only if the API exposes that header;
events.csv was always saved as usage-events.csv."""
from app.core.config import settings


def test_the_file_name_of_a_download_is_readable_across_origins(client):
    origin = settings.cors_allowed_origins[0]
    r = client.get("/admin/usage/export/events.csv", headers={"Origin": origin})
    assert r.status_code == 200 and "filename=" in r.headers["content-disposition"]
    assert "content-disposition" in r.headers.get("access-control-expose-headers", "").lower()
