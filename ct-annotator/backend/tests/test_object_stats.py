"""Per-object measurements for the review card (UX-rev-1-03/-17,
UX-rev-2-06): slices, volume, longest in-plane diameter, HU."""
from types import SimpleNamespace

import numpy as np
import pytest
from app.object_stats import object_stats, series_spacing


def test_a_box_is_measured_in_millimetres_and_hu():
    mask = np.zeros((10, 20, 20), dtype=np.uint8)
    mask[2:5, 5:9, 5:11] = 1  # 3 slices, 4 rows x 6 columns
    mask[7, 0, 0] = 2
    hu = np.full(mask.shape, -800.0, dtype=np.float32)
    hu[2:5, 5:9, 5:11] = 40.0
    hu[2, 5, 5] = -900.0  # one voxel of air inside object 1
    stats = object_stats(mask, hu, (2.0, 0.5, 0.5))
    one = stats[1]
    assert (one["voxels"], one["first_slice"], one["last_slice"], one["slice_count"]) == (72, 3, 5, 3)
    assert one["volume_ml"] == pytest.approx(72 * 2.0 * 0.5 * 0.5 / 1000, abs=1e-4)
    # the diagonal of a 4x6 pixel box, pixel centres: sqrt(1.5^2 + 2.5^2) mm
    assert one["long_axis_mm"] == pytest.approx(np.hypot(3 * 0.5, 5 * 0.5), abs=0.01)
    assert one["hu_min"] == -900 and one["hu_max"] == 40
    assert one["below_minus_500"] == pytest.approx(1 / 72, abs=1e-3)
    assert stats[2]["voxels"] == 1 and stats[2]["long_axis_mm"] == 0


def test_without_spacing_or_hu_only_what_is_known():
    mask = np.zeros((3, 4, 4), dtype=np.uint8)
    mask[1, 1:3, 1] = 5
    stats = object_stats(mask, None, None)
    assert stats[5]["voxels"] == 2 and stats[5]["volume_ml"] is None and stats[5]["long_axis_mm"] is None and stats[5]["hu_mean"] is None


def test_the_slice_distance_comes_from_the_positions():
    a = SimpleNamespace(PixelSpacing=[0.7, 0.7], ImagePositionPatient=[0, 0, -100.0], SliceThickness=5.0)
    b = SimpleNamespace(PixelSpacing=[0.7, 0.7], ImagePositionPatient=[0, 0, -102.5], SliceThickness=5.0)
    assert series_spacing(a, b) == (2.5, 0.7, 0.7)
    assert series_spacing(SimpleNamespace(PixelSpacing=[0.8, 0.9], SliceThickness=1.25), None) == (1.25, 0.8, 0.9)
    assert series_spacing(SimpleNamespace(), None) is None


def test_distances_to_the_pleura_and_the_nearest_bronchus():
    from app.object_stats import object_distances

    lung = np.zeros((20, 40, 40), dtype=np.uint8)
    lung[:, 5:35, 5:35] = 1  # a block of lung, its surface 5 voxels in from the edge
    lung[10, 20, 20] = 0  # a vessel: a hole in the lung mask, not its surface
    airway = np.zeros_like(lung)
    airway[:, 20, 10] = 1  # a bronchus running down at x = 10
    mask = np.zeros_like(lung)
    mask[10, 20, 20] = 1  # object 1 in the middle (on the vessel hole)
    mask[10, 20, 4:7] = 2  # object 2 reaching out through the surface
    d = object_distances(mask, lung, airway, (1.0, 1.0, 1.0), shrink=1)
    one, two = d[1], d[2]
    assert one["touches_pleura"] is False and 13 <= one["pleura_mm"] <= 16  # ~15 voxels to the nearest surface
    assert 9 <= one["bronchus_mm"] <= 11  # 10 voxels from the bronchus
    assert two["touches_pleura"] is True and two["pleura_mm"] == 0
    none = object_distances(mask, lung, None, (1.0, 1.0, 1.0), shrink=1)
    assert none[1]["bronchus_mm"] is None


def test_a_one_voxel_object_survives_the_shrunk_grid():
    from app.object_stats import object_distances

    lung = np.ones((2, 3, 3), dtype=np.uint8)
    mask = np.zeros_like(lung)
    mask[1, 2, 2] = 7  # the last row and column, which a strided grid skips
    assert 7 in object_distances(mask, lung, None, (1.0, 1.0, 1.0), shrink=2)


def test_distances_stay_small_in_memory():
    """Two full distance maps of a real series were enough, with the cached
    volume, to get the backend killed: the gaps come from the surfaces'
    points instead, a few times the mask's own bytes at most."""
    import tracemalloc

    from app.object_stats import object_distances

    lung = np.zeros((60, 256, 256), dtype=np.uint8)
    lung[:, 20:236, 20:120] = 1
    lung[:, 20:236, 136:236] = 1
    airway = np.zeros_like(lung)
    airway[:, 128, 125:131] = 1
    mask = np.zeros_like(lung)
    mask[30, 100:104, 60:64] = 1
    tracemalloc.start()
    d = object_distances(mask, lung, airway, (2.5, 0.7, 0.7))
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    assert d[1]["touches_pleura"] is False
    assert peak < 3 * mask.nbytes, peak


def test_the_mediastinum_is_outside_the_lung():
    """A nodule on the mediastinal pleura touches it, although a slice where
    the lungs meet around the mediastinum has it as a hole in the mask."""
    from app.object_stats import object_distances

    lung = np.zeros((6, 120, 120), dtype=np.uint8)
    lung[:, 10:110, 10:110] = 1
    lung[:, 30:90, 30:90] = 0
    mask = np.zeros_like(lung)
    mask[3, 50:54, 26:31] = 1  # reaching into the mediastinum
    d = object_distances(mask, lung, None, (1.0, 1.0, 1.0), shrink=1)
    assert d[1]["touches_pleura"] is True
