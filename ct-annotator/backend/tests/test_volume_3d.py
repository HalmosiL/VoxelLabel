"""The CT volume for the 3D view: downsampled for the GPU (at most
MAX_EDGE in-plane), 8-bit in 16 HU steps from -1024, gzipped, with its
real spacing so the view keeps the patient's proportions."""
import numpy as np
from app.volume_3d import HU_OFFSET, HU_STEP, downsample_for_3d


def test_a_big_volume_is_averaged_down_in_plane_only():
    vol = np.zeros((10, 512, 512), dtype=np.float32)
    vol[:, :256, :] = 1000.0
    small, factor = downsample_for_3d(vol, max_edge=256)
    assert small.shape == (10, 256, 256) and factor == 2
    # 1000 HU -> (1000 + 1024) / 16, rounded
    assert small[0, 0, 0] == round((1000 - HU_OFFSET) / HU_STEP) and small[0, 255, 0] == 64  # 0 HU


def test_hu_is_clipped_to_the_byte_range():
    vol = np.array([[[-3000.0, 5000.0]]], dtype=np.float32)
    small, factor = downsample_for_3d(vol, max_edge=256)
    assert factor == 1 and small.dtype == np.uint8 and list(small.ravel()) == [0, 255]
