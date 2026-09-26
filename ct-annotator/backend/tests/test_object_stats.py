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
