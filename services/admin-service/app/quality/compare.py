"""Two annotators' segmentations of one image, compared -- pure numpy.

A mask is ct-annotator's volume: one byte per voxel, the object id there
(0 = nothing), flat in the series' own voxel order -- two masks of one
series line up voxel for voxel, so no shape is needed. Each object belongs
to a label ("Nodule", ...) through the annotation's payload.

- Dice (2|A∩B| / (|A|+|B|)) over any foreground, and per label name.
- Findings: an object of one matched to the other's best-overlapping one
  when their IoU reaches MATCH_IOU -- "found by both", else found by only
  one of them. A voxel or two of contact isn't the same finding.
"""
import numpy as np

MATCH_IOU = 0.1


def dice(a: np.ndarray, b: np.ndarray) -> float | None:
    """Dice of two boolean masks; None when both are empty -- there is
    nothing to agree or disagree on."""
    total = int(a.sum()) + int(b.sum())
    if total == 0:
        return None
    return round(2 * int(np.logical_and(a, b).sum()) / total, 3)


def object_labels(payload: dict) -> dict[int, str]:
    """Each object id's label name, from a segmentation's payload."""
    names = {label.get("id"): label.get("name") or "(no label)" for label in payload.get("labels", [])}
    return {obj["id"]: names.get(obj.get("label_id"), "(no label)") for obj in payload.get("objects", []) if "id" in obj}


def _matched_findings(pairs: np.ndarray, counts: np.ndarray, size_a: dict, size_b: dict) -> int:
    """How many objects pair up one to one, best IoU first."""
    candidates = []
    for (ia, ib), shared in zip(pairs, counts, strict=True):
        if ia and ib:
            iou = shared / (size_a[ia] + size_b[ib] - shared)
            if iou >= MATCH_IOU:
                candidates.append((iou, ia, ib))
    used_a, used_b = set(), set()
    for _, ia, ib in sorted(candidates, reverse=True):
        if ia not in used_a and ib not in used_b:
            used_a.add(ia)
            used_b.add(ib)
    return len(used_a)


def compare_pair(mask_a: np.ndarray, labels_a: dict[int, str], mask_b: np.ndarray, labels_b: dict[int, str]) -> dict:
    """{dice, by_label: {name: dice}, objects: {both, only_a, only_b},
    voxels_a, voxels_b} for two masks of the same image."""
    fg_a, fg_b = mask_a > 0, mask_b > 0
    by_label = {}
    for name in sorted(set(labels_a.values()) | set(labels_b.values())):
        in_a = np.isin(mask_a, [i for i, n in labels_a.items() if n == name])
        in_b = np.isin(mask_b, [i for i, n in labels_b.items() if n == name])
        value = dice(in_a, in_b)
        if value is not None:
            by_label[name] = value
    # every (object of A, object of B) meeting on some voxel, and how much
    union = fg_a | fg_b
    codes = mask_a[union].astype(np.uint16) * 256 + mask_b[union]
    uniq, counts = np.unique(codes, return_counts=True)
    pairs = np.stack([uniq // 256, uniq % 256], axis=1)
    ids_a, sizes_a = np.unique(mask_a[fg_a], return_counts=True)
    ids_b, sizes_b = np.unique(mask_b[fg_b], return_counts=True)
    size_a = dict(zip(ids_a.tolist(), sizes_a.tolist(), strict=True))
    size_b = dict(zip(ids_b.tolist(), sizes_b.tolist(), strict=True))
    both = _matched_findings(pairs.tolist(), counts.tolist(), size_a, size_b)
    return {
        "dice": dice(fg_a, fg_b),
        "by_label": by_label,
        "objects": {"both": both, "only_a": len(size_a) - both, "only_b": len(size_b) - both},
        "voxels_a": int(fg_a.sum()),
        "voxels_b": int(fg_b.sum()),
    }
