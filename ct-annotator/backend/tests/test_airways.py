"""Airway (bronchial tree) segmentation for the 3D view: find the trachea,
grow along the air with a threshold that rises until the tree would leak
into the lung, and stop just before."""
import numpy as np
from app.airways import find_trachea_seed, segment_airways


def _phantom():
    """A 60-slice 96x96 chest: body 40 HU, two lungs -860 HU (with noise
    that dips below -950 here and there, not connected to anything), a
    trachea (-1000) down the middle to slice 30, then two main bronchi
    running into the lungs."""
    rng = np.random.default_rng(0)
    vol = np.full((60, 96, 96), 40, dtype=np.int16)
    vol[:, :, :] = -1000  # the air around the body
    yy, xx = np.mgrid[:96, :96]
    body = (yy - 48) ** 2 / 40**2 + (xx - 48) ** 2 / 44**2 <= 1
    vol[:, body] = 40
    left = (yy - 50) ** 2 / 26**2 + (xx - 28) ** 2 / 14**2 <= 1
    right = (yy - 50) ** 2 / 26**2 + (xx - 68) ** 2 / 14**2 <= 1
    for z in range(10, 60):
        noise = rng.normal(0, 40, size=(96, 96))
        vol[z][left] = (-860 + noise[left]).astype(np.int16)
        vol[z][right] = (-860 + noise[right]).astype(np.int16)
    trachea = (yy - 48) ** 2 + (xx - 48) ** 2 <= 9
    for z in range(0, 31):
        vol[z][trachea] = -1000
    for z in range(30, 50):  # the bronchi go down and out
        k = (z - 30) * 1.0
        for cx in (48 - k, 48 + k):
            b = (yy - 48) ** 2 + (xx - cx) ** 2 <= 4
            vol[z][b] = -1000
    return vol


def test_the_trachea_is_found_near_the_middle():
    vol = _phantom()
    z, y, x = find_trachea_seed(vol)
    assert 40 <= x <= 56 and 40 <= y <= 56 and vol[z, y, x] < -950


def test_the_tree_grows_down_both_bronchi_and_not_into_the_lung():
    vol = _phantom()
    mask, info = segment_airways(vol, (3.0, 1.0, 1.0))
    assert mask.dtype == np.uint8
    assert mask[5, 48, 48] == 1  # trachea
    assert mask[45, 48, 48 - 15] == 1 and mask[45, 48, 48 + 15] == 1  # both bronchi
    lung_voxels = mask[20:, 58:72, 18:36].sum()  # deep in the left lung, below the bronchus (it runs at y 46-50)
    assert lung_voxels < 50, lung_voxels
    # stops below the lung's own -860 HU, before the flood (at -880 the volume doubles)
    assert info["threshold_hu"] < -870 and 0 < info["volume_ml"] < 20


def test_no_trachea_no_tree():
    vol = np.full((10, 32, 32), 40, dtype=np.int16)
    mask, info = segment_airways(vol, (1.0, 1.0, 1.0))
    assert mask.sum() == 0 and info["found"] is False
