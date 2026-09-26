"""Lung vessel segmentation for the 3D view: what is dense inside the
lungs, minus the pleura's partial-volume rim and specks of noise."""
import numpy as np
from app.vessels import segment_vessels


def _phantom():
    """40 slices of 80x80: chest wall 40 HU, one lung -850 HU with a
    -300 HU rim (the partial-volume voxels at its surface), a vessel
    (40 HU) running down through it, and a two-voxel speck."""
    vol = np.full((40, 80, 80), 40, dtype=np.int16)
    lung = np.zeros(vol.shape, dtype=np.uint8)
    lung[:, 10:70, 10:70] = 1
    vol[lung > 0] = -850
    rim = lung.copy()
    rim[:, 11:69, 11:69] = 0
    vol[rim > 0] = -300
    vol[:, 38:42, 38:42] = 40  # the vessel: a hole in the threshold lung mask
    lung[:, 38:42, 38:42] = 0
    vol[20, 25, 25:27] = 40  # a speck
    lung[20, 25, 25:27] = 0
    return vol, lung


def test_it_finds_the_vessel_and_nothing_else():
    vol, lung = _phantom()
    mask, info = segment_vessels(vol, lung, (1.0, 1.0, 1.0))
    assert info["found"] is True
    assert mask[:, 38:42, 38:42].all()  # the vessel, although the lung mask has it as a hole
    assert not mask[20, 25, 25:27].any()  # the speck is gone
    assert not mask[:, 10, :].any() and not mask[:, :, 69].any()  # not the rim
    assert not mask[:, :10, :].any()  # not the chest wall
    assert info["volume_ml"] == round(40 * 16 / 1000, 1)


def test_no_lung_no_vessels():
    vol, lung = _phantom()
    mask, info = segment_vessels(vol, np.zeros_like(lung), (1.0, 1.0, 1.0))
    assert info["found"] is False and not mask.any()


def test_the_heart_between_the_lungs_is_not_a_vessel():
    """Where the two lungs meet in front of and behind the mediastinum, a
    slice has it as one big hole in the lung mask -- the heart, not lung."""
    vol = np.full((10, 120, 120), 40, dtype=np.int16)
    lung = np.zeros(vol.shape, dtype=np.uint8)
    lung[:, 10:110, 10:110] = 1
    lung[:, 30:90, 30:90] = 0  # the mediastinum: 60 x 60 mm, all of it 40 HU
    vol[lung > 0] = -850
    vol[:, 50:54, 15:19] = 40  # a vessel in the lung
    lung[:, 50:54, 15:19] = 0
    mask, _ = segment_vessels(vol, lung, (1.0, 1.0, 1.0))
    assert mask[:, 50:54, 15:19].all()
    assert not mask[:, 30:90, 30:90].any()
