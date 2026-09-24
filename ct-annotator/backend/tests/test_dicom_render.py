"""Unit tests for the pure DICOM decode/render helpers -- no live DICOM
file server or network access needed, since dicom_render.py takes an
already-parsed pydicom Dataset and has no I/O of its own. Datasets here
are small synthetic ones built directly in-memory (uncompressed,
ExplicitVRLittleEndian), not read from a file."""
import numpy as np
import pydicom
from app.dicom_render import _first, extract_metadata, render_plane, render_png, rescaled_pixels
from pydicom.dataset import FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _make_dataset(pixel_array, window_center=None, window_width=None, rescale_slope=None, rescale_intercept=None):
    file_meta = FileMetaDataset()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = pydicom.Dataset()
    ds.file_meta = file_meta

    rows, cols = pixel_array.shape
    ds.Rows = rows
    ds.Columns = cols
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.PixelData = pixel_array.astype(np.uint16).tobytes()

    if window_center is not None:
        ds.WindowCenter = window_center
    if window_width is not None:
        ds.WindowWidth = window_width
    if rescale_slope is not None:
        ds.RescaleSlope = rescale_slope
    if rescale_intercept is not None:
        ds.RescaleIntercept = rescale_intercept

    return ds


def test_first_handles_none():
    assert _first(None) is None


def test_first_handles_scalar():
    assert _first(40.0) == 40.0


def test_first_handles_multivalue_list():
    assert _first([40.0, 80.0]) == 40.0


def test_extract_metadata_reads_tags():
    ds = _make_dataset(
        np.zeros((4, 4)), window_center=40, window_width=400, rescale_slope=1, rescale_intercept=-1024
    )
    assert extract_metadata(ds) == {
        "rows": 4,
        "columns": 4,
        "window_center": 40.0,
        "window_width": 400.0,
        "rescale_slope": 1.0,
        "rescale_intercept": -1024.0,
    }


def test_extract_metadata_defaults_when_tags_absent():
    meta = extract_metadata(_make_dataset(np.zeros((4, 4))))
    assert meta["window_center"] is None
    assert meta["window_width"] is None
    assert meta["rescale_slope"] == 1.0
    assert meta["rescale_intercept"] == 0.0


def test_render_png_produces_a_valid_png_with_explicit_window():
    pixel_array = np.array([[0, 100], [200, 300]], dtype=np.uint16)
    ds = _make_dataset(pixel_array)
    png_bytes = render_png(ds, window_center=150, window_width=300)
    assert png_bytes[:8] == _PNG_MAGIC


def test_render_png_falls_back_to_min_max_when_no_window_anywhere():
    pixel_array = np.array([[0, 100], [200, 300]], dtype=np.uint16)
    ds = _make_dataset(pixel_array)
    png_bytes = render_png(ds, window_center=None, window_width=None)
    assert png_bytes[:8] == _PNG_MAGIC


def test_render_png_uses_dataset_window_when_none_given_explicitly():
    pixel_array = np.array([[0, 100], [200, 300]], dtype=np.uint16)
    ds = _make_dataset(pixel_array, window_center=150, window_width=300)
    explicit = render_png(ds, window_center=150, window_width=300)
    from_tags = render_png(ds, window_center=None, window_width=None)
    assert explicit == from_tags


def test_render_png_applies_rescale_slope_and_intercept():
    # Same raw pixel values, different rescale parameters -- windowing on
    # the rescaled (Hounsfield-like) domain should produce a different image.
    pixel_array = np.array([[0, 500], [1000, 1500]], dtype=np.uint16)
    ds_no_rescale = _make_dataset(pixel_array, rescale_slope=1, rescale_intercept=0)
    ds_rescaled = _make_dataset(pixel_array, rescale_slope=1, rescale_intercept=-1000)

    png_a = render_png(ds_no_rescale, window_center=500, window_width=1000)
    png_b = render_png(ds_rescaled, window_center=500, window_width=1000)
    assert png_a != png_b


def test_rescaled_pixels_applies_slope_and_intercept():
    pixel_array = np.array([[0, 500], [1000, 1500]], dtype=np.uint16)
    ds = _make_dataset(pixel_array, rescale_slope=2, rescale_intercept=-1000)
    result = rescaled_pixels(ds)
    expected = pixel_array.astype(np.float32) * 2 - 1000
    assert np.array_equal(result, expected)


def test_rescaled_pixels_defaults_to_identity_when_tags_absent():
    pixel_array = np.array([[10, 20], [30, 40]], dtype=np.uint16)
    ds = _make_dataset(pixel_array)
    result = rescaled_pixels(ds)
    assert np.array_equal(result, pixel_array.astype(np.float32))


def test_render_plane_produces_a_valid_png():
    # A "plane" is a plain rescaled 2D array cut from a volume -- no
    # pydicom Dataset needed, unlike render_png.
    plane = np.array([[0, 500], [1000, 1500]], dtype=np.float32)
    png_bytes = render_plane(plane, window_center=500, window_width=1000)
    assert png_bytes[:8] == _PNG_MAGIC


def test_render_plane_falls_back_to_min_max_when_no_window_given():
    plane = np.array([[0, 500], [1000, 1500]], dtype=np.float32)
    png_bytes = render_plane(plane, window_center=None, window_width=None)
    assert png_bytes[:8] == _PNG_MAGIC


def _ramp_volume():
    # value = 100*z + 10*y + x, so every projection is easy to predict
    z, y, x = np.meshgrid(np.arange(5), np.arange(4), np.arange(3), indexing="ij")
    return (100 * z + 10 * y + x).astype(np.float32)


def test_slab_of_thickness_one_is_the_plane_itself():
    from app.dicom_render import slab_plane

    vol = _ramp_volume()
    assert np.array_equal(slab_plane(vol, "axial", 2, 1, "avg"), vol[2])
    assert np.array_equal(slab_plane(vol, "coronal", 1, 1, "mip"), vol[:, 1, :])
    assert np.array_equal(slab_plane(vol, "sagittal", 0, 1, "minip"), vol[:, :, 0])


def test_slab_projects_neighbouring_slices_by_mode():
    from app.dicom_render import slab_plane

    vol = _ramp_volume()
    # axial slices 1..3 around 2
    assert np.allclose(slab_plane(vol, "axial", 2, 3, "avg"), vol[2])
    assert np.array_equal(slab_plane(vol, "axial", 2, 3, "mip"), vol[3])
    assert np.array_equal(slab_plane(vol, "axial", 2, 3, "minip"), vol[1])
    # an even thickness rounds up to stay centred: 4 -> slices 0..4
    assert np.array_equal(slab_plane(vol, "axial", 2, 4, "mip"), vol[4])
    # sagittal/coronal cut across x / y
    assert np.array_equal(slab_plane(vol, "sagittal", 1, 3, "mip"), vol[:, :, 2])
    assert np.array_equal(slab_plane(vol, "coronal", 1, 3, "minip"), vol[:, 0, :])


def test_slab_is_clipped_at_the_volume_edge_and_rejects_nonsense():
    import pytest
    from app.dicom_render import slab_plane

    vol = _ramp_volume()
    # slice 0 with thickness 5 -> only slices 0..2 exist on that side
    assert np.allclose(slab_plane(vol, "axial", 0, 5, "avg"), vol[1])
    assert np.array_equal(slab_plane(vol, "axial", 99, 3, "mip"), vol[4])
    with pytest.raises(ValueError):
        slab_plane(vol, "oblique", 0, 3, "avg")
    with pytest.raises(ValueError):
        slab_plane(vol, "axial", 0, 3, "median")
