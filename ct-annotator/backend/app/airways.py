"""The bronchial tree for the 3D view (components/VolumeView), segmented
from the CT alone: no training, no seed from the user.

1. The trachea: among the air (below SEED_HU) that doesn't touch the
   scan's edge (the room), the component that runs through the most slices
   near the image's midline -- a tube down the middle of the chest.
2. The tree: everything connected to it below a threshold that starts at
   SEED_HU and rises in STEP_HU steps. Airway walls hold the air in, so the
   tree grows a little at each step -- until the threshold reaches the
   lung itself and the region floods into it: the volume jumps. The last
   threshold before that jump is kept.

Good enough for a picture of the tree; small peripheral bronchi, below
the scan's resolution or with partial-volume walls, are missed."""
import numpy as np
from scipy import ndimage

SEED_HU = -950
MAX_HU = -800
STEP_HU = 10
# a step that multiplies the volume by this much has leaked into the lung
LEAK_GROWTH = 1.6
# ... as has any tree larger than this (a whole airway tree is ~100 mL)
MAX_TREE_ML = 400.0


def find_trachea_seed(volume: np.ndarray) -> tuple[int, int, int] | None:
    """(z, y, x) of a voxel of the trachea, or None."""
    z, y, x = volume.shape
    air = volume < SEED_HU
    labeled, count = ndimage.label(air)
    if count == 0:
        return None
    border = set(np.unique(np.concatenate([labeled[:, 0, :].ravel(), labeled[:, -1, :].ravel(), labeled[:, :, 0].ravel(), labeled[:, :, -1].ravel()]))) - {0}
    best, best_extent = None, 0
    for index, sl in enumerate(ndimage.find_objects(labeled), start=1):
        if sl is None or index in border:
            continue
        extent = sl[0].stop - sl[0].start
        cy = (sl[1].start + sl[1].stop) / 2
        cx = (sl[2].start + sl[2].stop) / 2
        # near the midline and not a whole lung's width
        if abs(cx - x / 2) > x * 0.2 or abs(cy - y / 2) > y * 0.3 or (sl[2].stop - sl[2].start) > x * 0.5:
            continue
        if extent > best_extent:
            best, best_extent = index, extent
    if best is None or best_extent < 3:
        return None
    zz, yy, xx = np.nonzero(labeled == best)
    top = np.argmin(zz)  # its first slice: the trachea's own end, far from the lungs
    return int(zz[top]), int(yy[top]), int(xx[top])


def _grown(volume: np.ndarray, seed: tuple[int, int, int], threshold: int) -> np.ndarray:
    labeled, _ = ndimage.label(volume < threshold)
    label = labeled[seed]
    return labeled == label if label else np.zeros(volume.shape, dtype=bool)


def segment_airways(volume: np.ndarray, spacing: tuple[float, float, float]) -> tuple[np.ndarray, dict]:
    """(uint8 mask z, y, x -- 1 for airway, the facts behind it)."""
    voxel_ml = float(np.prod(spacing)) / 1000.0
    seed = find_trachea_seed(volume)
    if seed is None:
        return np.zeros(volume.shape, dtype=np.uint8), {"found": False, "threshold_hu": None, "volume_ml": 0.0, "seed": None}
    kept = _grown(volume, seed, SEED_HU)
    kept_threshold = SEED_HU
    for threshold in range(SEED_HU + STEP_HU, MAX_HU + 1, STEP_HU):
        grown = _grown(volume, seed, threshold)
        size, before = int(grown.sum()), int(kept.sum())
        if size * voxel_ml > MAX_TREE_ML or (before > 0 and size > before * LEAK_GROWTH):
            break
        kept, kept_threshold = grown, threshold
    return kept.astype(np.uint8), {
        "found": True,
        "threshold_hu": kept_threshold,
        "volume_ml": round(float(kept.sum()) * voxel_ml, 1),
        "seed": list(seed),
    }
