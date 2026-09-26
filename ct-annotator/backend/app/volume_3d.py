"""The CT volume as the viewer's 3D view needs it (components/VolumeView):
small enough for a GPU 3D texture on a laptop or tablet, one byte per
voxel. In-plane it is averaged down to at most MAX_EDGE pixels (the slice
axis is kept -- a CT has far fewer slices than pixels); HU is stored in
HU_STEP steps from HU_OFFSET, which is plenty for a rendering (lung,
soft tissue and bone windows all stay apart)."""
import numpy as np

MAX_EDGE = 256
HU_OFFSET = -1024.0
HU_STEP = 16.0


def downsample_for_3d(volume: np.ndarray, max_edge: int = MAX_EDGE) -> tuple[np.ndarray, int]:
    """(uint8 volume z, y, x, the in-plane factor it was shrunk by)."""
    z, y, x = volume.shape
    factor = 1
    while max(y, x) / factor > max_edge:
        factor *= 2
    v = volume  # int16 from the cache: no full-size float copy
    if factor > 1:
        yy, xx = (y // factor) * factor, (x // factor) * factor
        v = v[:, :yy, :xx].reshape(z, yy // factor, factor, xx // factor, factor).mean(axis=(2, 4))
    q = np.rint((v.astype(np.float32) - HU_OFFSET) / HU_STEP)  # the small one only
    return np.clip(q, 0, 255).astype(np.uint8), factor
