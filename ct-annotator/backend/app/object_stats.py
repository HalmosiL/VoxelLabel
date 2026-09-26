"""Measurements of each painted object, for the reviewer (UX-rev-1-03/-17,
UX-rev-2-06: "no mm scale, ruler, or per-object numbers although DICOM
pixel spacing is known -- mean HU would have flagged the over-segmentation
at once").

Works on the viewer's own mask (one byte per voxel: the object id, 0 =
nothing; z, y, x like the HU volume) so it measures what is on screen,
saved or not. Pure numpy/scipy -- main.py feeds it the volume and spacing.
"""
import numpy as np
from scipy import ndimage
from scipy.spatial import ConvexHull, QhullError, cKDTree

# The share of an object's voxels this far below 0 HU is air -- a "solid"
# nodule holding many of them was painted over lung.
AIR_HU = -500


def _first(value):
    if value is None:
        return None
    try:
        return value[0] if hasattr(value, "__len__") and not isinstance(value, str) else value
    except (TypeError, IndexError):
        return value


def series_spacing(first, second) -> tuple[float, float, float] | None:
    """(slice, row, column) spacing in mm from the first two instances of
    the series: the distance between their positions, else the declared
    slice spacing or thickness. None when the pixel spacing is unknown."""
    pixel = getattr(first, "PixelSpacing", None)
    if not pixel or len(pixel) < 2:
        return None
    dy, dx = float(pixel[0]), float(pixel[1])
    dz = None
    a, b = getattr(first, "ImagePositionPatient", None), getattr(second, "ImagePositionPatient", None) if second is not None else None
    if a is not None and b is not None and len(a) >= 3 and len(b) >= 3:
        dz = float(np.linalg.norm(np.asarray(b, dtype=float) - np.asarray(a, dtype=float))) or None
    if dz is None:
        for attr in ("SpacingBetweenSlices", "SliceThickness"):
            value = _first(getattr(first, attr, None))
            if value:
                dz = float(value)
                break
    if dz is None:
        return None
    return (round(dz, 4), dy, dx)


def _longest_in_plane(points_mm: np.ndarray) -> float:
    """The longest distance between two points of one slice's pixels (the
    radiologist's long axis): between two corners of their convex hull.
    Points on one line have no hull; their two ends are the answer."""
    if len(points_mm) < 2:
        return 0.0
    try:
        candidates = points_mm[ConvexHull(points_mm).vertices] if len(points_mm) > 3 else points_mm
    except QhullError:
        order = np.lexsort((points_mm[:, 1], points_mm[:, 0]))
        candidates = points_mm[[order[0], order[-1]]]
    diff = candidates[:, None, :] - candidates[None, :, :]
    return float(np.sqrt((diff**2).sum(axis=-1)).max())


def object_stats(mask: np.ndarray, hu: np.ndarray | None, spacing: tuple[float, float, float] | None) -> dict[int, dict]:
    """Per object id: voxels, slices (1-based first/last, count), volume in
    mL, long axis in mm (the longest in-plane diameter on any slice), HU
    mean/min/max and the share below AIR_HU. What can't be known without
    the spacing or the HU volume is None."""
    flat = mask.ravel()
    nz = np.flatnonzero(flat)
    out: dict[int, dict] = {}
    if nz.size == 0:
        return out
    ids = flat[nz]
    order = np.argsort(ids, kind="stable")
    nz, ids = nz[order], ids[order]
    bounds = np.flatnonzero(np.diff(ids)) + 1
    hu_flat = hu.ravel() if hu is not None and hu.shape == mask.shape else None
    for chunk_idx, chunk_ids in zip(np.split(nz, bounds), np.split(ids, bounds)):
        oid = int(chunk_ids[0])
        z, y, x = np.unravel_index(chunk_idx, mask.shape)
        slices = np.unique(z)
        stats = {
            "voxels": int(chunk_idx.size),
            "first_slice": int(slices[0]) + 1,
            "last_slice": int(slices[-1]) + 1,
            "slice_count": int(slices.size),
            "volume_ml": None,
            "long_axis_mm": None,
            "long_axis_slice": None,
            "hu_mean": None,
            "hu_min": None,
            "hu_max": None,
            "below_minus_500": None,
        }
        if spacing is not None:
            dz, dy, dx = spacing
            stats["volume_ml"] = round(chunk_idx.size * dz * dy * dx / 1000.0, 4)
            best, best_slice = 0.0, int(slices[0])
            for s in slices:
                on = z == s
                length = _longest_in_plane(np.column_stack((y[on] * dy, x[on] * dx)).astype(float))
                if length > best:
                    best, best_slice = length, int(s)
            stats["long_axis_mm"] = round(best, 2)
            stats["long_axis_slice"] = best_slice + 1
        if hu_flat is not None:
            values = hu_flat[chunk_idx]
            stats["hu_mean"] = round(float(values.mean()), 1)
            stats["hu_min"] = round(float(values.min()), 1)
            stats["hu_max"] = round(float(values.max()), 1)
            stats["below_minus_500"] = round(float((values < AIR_HU).mean()), 4)
        out[oid] = stats
    return out


def _fill_holes_by_slice(mask: np.ndarray) -> np.ndarray:
    """What the lung encloses, slice by slice: vessels and nodules are holes
    in a threshold lung mask, and must count as inside, not as its surface."""
    out = np.empty(mask.shape, dtype=bool)
    for z in range(mask.shape[0]):
        out[z] = ndimage.binary_fill_holes(mask[z] > 0)
    return out


def _block_max(mask: np.ndarray, k: int) -> np.ndarray:
    """In-plane k x k blocks of `mask`, each its largest value -- the same
    ceil(n / k) grid as mask[:, ::k, ::k]."""
    z, y, x = mask.shape
    py, px = (-y) % k, (-x) % k
    padded = np.pad(mask, ((0, 0), (0, py), (0, px)))
    return padded.reshape(z, (y + py) // k, k, (x + px) // k, k).max(axis=(2, 4))


def _nearest_mm(points: np.ndarray, at: np.ndarray, grid: tuple[float, float, float]) -> float | None:
    """The shortest gap, in mm, from any voxel of `at` to any of `points`
    (voxel indices on the same grid); None without points."""
    if len(points) == 0:
        return None
    scale = np.asarray(grid)
    gap, _ = cKDTree(points * scale).query(np.argwhere(at) * scale, k=1)
    return float(gap.min())


def _edge_outside(solid: np.ndarray) -> np.ndarray:
    """The voxels just outside `solid` (face neighbours): the nearest of
    them is exactly what a distance transform of `solid` measures to."""
    return np.argwhere(ndimage.binary_dilation(solid) & ~solid)


def object_distances(
    mask: np.ndarray,
    lung: np.ndarray,
    airway: np.ndarray | None,
    spacing: tuple[float, float, float],
    shrink: int = 2,
) -> dict[int, dict]:
    """Per object id, the gaps that decide how a nodule is read: to the
    pleura (the lung's surface -- 0 when the object reaches out of the
    lung: juxtapleural) and to the nearest *segmented* bronchus (None
    without an airway tree). Measured on a grid shrunk `shrink` times
    in-plane -- about one voxel's accuracy, which the answer is rounded to.

    Nearest-point queries against the surfaces' voxels, not distance maps
    over the whole grid: those were two float volumes (plus scipy's index
    arrays) next to the cached series, and got the backend killed."""
    dz, dy, dx = spacing
    sub = (slice(None), slice(None, None, shrink), slice(None, None, shrink))
    grid = (dz, dy * shrink, dx * shrink)
    inside = _fill_holes_by_slice(lung[sub])
    surface = _edge_outside(inside)
    tube = airway[sub] > 0 if airway is not None else None
    bronchi = np.argwhere(tube) if tube is not None and tube.any() else None
    # every object's voxels, kept even when smaller than the shrunk grid:
    # each shrink x shrink block keeps its largest id
    small = _block_max(mask, shrink) if shrink > 1 else mask
    out: dict[int, dict] = {}
    for oid in np.unique(small):
        if oid == 0:
            continue
        at = small == oid
        outside = bool((~inside[at]).any())
        pleura = 0.0 if outside else _nearest_mm(surface, at, grid)
        if bronchi is None:
            bronchus = None
        elif tube[at].any():
            bronchus = 0.0
        else:
            bronchus = _nearest_mm(bronchi, at, grid)
        out[int(oid)] = {
            "pleura_mm": None if pleura is None else round(pleura, 1),
            "touches_pleura": outside,
            "bronchus_mm": None if bronchus is None else round(bronchus, 1),
        }
    return out
