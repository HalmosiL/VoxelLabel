"""The lung's vessels, for the 3D view: what is dense (blood, above
VESSEL_HU) inside the lungs.

The lung mask of main._segment_lungs is a threshold mask, so the vessels
are holes in it; with its small holes filled slice by slice it is
"everything the lung encloses" (not the mediastinum, a far larger hole),
and the dense part of that is the vessel tree. Two voxels in
from the lung's surface are left out -- the partial-volume rim at the
pleura, dense enough to count otherwise, would wrap the lungs in a shell --
and so are specks smaller than MIN_COMPONENT_MM3 (noise, calcifications).
Nodules are dense too and stay in: the annotation is drawn over them in
its own colour. Pure numpy/scipy, like airways.py.
"""
import numpy as np
from scipy import ndimage

from app.object_stats import fill_holes_by_slice

# Blood without contrast is ~40 HU; partial volume at a vessel's edge in a
# 3 mm slice brings small ones well below that, lung stays under -700.
VESSEL_HU = -400
RIM_VOXELS = 2
MIN_COMPONENT_MM3 = 20.0


def segment_vessels(volume: np.ndarray, lung: np.ndarray, spacing: tuple[float, float, float]) -> tuple[np.ndarray, dict]:
    """(mask, info): a 0/1 mask like the lung mask's (z, y, x), and
    {found, volume_ml, threshold_hu}. `volume` is in HU."""
    inside = fill_holes_by_slice(lung, spacing[1] * spacing[2])
    if not inside.any():
        return np.zeros(volume.shape, dtype=np.uint8), {"found": False, "volume_ml": 0.0, "threshold_hu": VESSEL_HU}
    # in-plane only: a slice's neighbours are millimetres away
    plane = np.zeros((3, 3, 3), dtype=bool)
    plane[1] = ndimage.generate_binary_structure(2, 1)
    core = ndimage.binary_erosion(inside, structure=plane, iterations=RIM_VOXELS)
    del inside
    dense = core & (volume > VESSEL_HU)
    del core
    labeled, count = ndimage.label(dense, structure=np.ones((3, 3, 3), dtype=bool))
    voxel_mm3 = float(np.prod(spacing))
    if count:
        sizes = np.bincount(labeled.ravel(), minlength=count + 1) * voxel_mm3
        keep = sizes >= MIN_COMPONENT_MM3
        keep[0] = False
        dense = keep[labeled]
    del labeled
    mask = dense.astype(np.uint8)
    return mask, {"found": bool(mask.any()), "volume_ml": round(float(mask.sum()) * voxel_mm3 / 1000, 1), "threshold_hu": VESSEL_HU}
