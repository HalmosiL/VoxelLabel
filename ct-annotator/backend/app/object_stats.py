"""Measurements of each painted object, for the reviewer (UX-rev-1-03/-17,
UX-rev-2-06: "no mm scale, ruler, or per-object numbers although DICOM
pixel spacing is known -- mean HU would have flagged the over-segmentation
at once").

Works on the viewer's own mask (one byte per voxel: the object id, 0 =
nothing; z, y, x like the HU volume) so it measures what is on screen,
saved or not. Pure numpy/scipy -- main.py feeds it the volume and spacing.
"""
import numpy as np
from scipy.spatial import ConvexHull, QhullError

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
