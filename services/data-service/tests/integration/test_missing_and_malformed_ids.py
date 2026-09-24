"""An id that doesn't exist is a 404, a malformed one a 422 -- never a
500 (J-01, J-02). A viewer tab left open on a deleted series used to get
a generic server error."""
import pytest

NIL = "00000000-0000-0000-0000-000000000000"
PATHS = [
    "/data/cases/{id}",
    "/data/cases/{id}/series",
    "/data/cases/{id}/imaging-studies",
    "/data/imaging-studies/{id}/series",
    "/data/series/{id}/instances",
    "/data/instances/{id}/pixel-data-url",
    "/data/patients/{id}/cases",
    "/data/clinical-data-items/{id}/file-url",
]


@pytest.mark.parametrize("path", PATHS)
def test_a_missing_id_is_a_404(client, path):
    r = client.get(path.format(id=NIL))
    assert r.status_code == 404, (path, r.status_code, r.text)


@pytest.mark.parametrize("path", PATHS)
def test_a_malformed_id_is_a_422(client, path):
    r = client.get(path.format(id="not-a-uuid"))
    assert r.status_code == 422, (path, r.status_code, r.text)
