"""Two annotators' segmentations of one image, compared (app/quality/compare.py)."""
import numpy as np
from app.quality.compare import compare_pair, dice, object_labels


def test_dice_is_overlap_over_the_sizes():
    a = np.array([1, 1, 1, 1, 0, 0], dtype=bool)
    b = np.array([0, 0, 1, 1, 1, 1], dtype=bool)
    assert dice(a, b) == 0.5
    assert dice(a, a) == 1.0
    assert dice(np.zeros(4, bool), np.zeros(4, bool)) is None  # nothing on either: nothing to agree on


def test_object_labels_map_each_object_to_its_labels_name():
    payload = {"labels": [{"id": 1, "name": "Nodule"}, {"id": 2, "name": "Vessel"}], "objects": [{"id": 3, "label_id": 1}, {"id": 4, "label_id": 2}, {"id": 5, "label_id": 9}]}
    assert object_labels(payload) == {3: "Nodule", 4: "Vessel", 5: "(no label)"}


def test_a_pair_is_compared_overall_by_label_and_by_object():
    # A: nodule 1 (voxels 0-3), nodule 2 (voxels 10-11); B: nodule 7 (voxels 2-5), vessel 8 (voxels 20-21)
    a = np.zeros(30, np.uint8)
    b = np.zeros(30, np.uint8)
    a[0:4] = 1
    a[10:12] = 2
    b[2:6] = 7
    b[20:22] = 8
    got = compare_pair(a, {1: "Nodule", 2: "Nodule"}, b, {7: "Nodule", 8: "Vessel"})
    assert got["dice"] == round(2 * 2 / (6 + 6), 3)  # any foreground: 2 shared voxels of 6 + 6
    assert got["by_label"]["Nodule"] == round(2 * 2 / (6 + 4), 3)
    assert got["by_label"]["Vessel"] == 0.0  # only B drew one
    # nodule 1 and nodule 7 overlap (IoU 2/6): found by both; A's nodule 2 and B's vessel alone
    assert got["objects"] == {"both": 1, "only_a": 1, "only_b": 1}
    assert (got["voxels_a"], got["voxels_b"]) == (6, 6)


def test_two_empty_masks_agree_on_nothing_rather_than_fail():
    got = compare_pair(np.zeros(8, np.uint8), {}, np.zeros(8, np.uint8), {})
    assert got["dice"] is None and got["objects"] == {"both": 0, "only_a": 0, "only_b": 0}


def test_a_barely_touching_pair_is_not_the_same_finding():
    a = np.zeros(100, np.uint8)
    b = np.zeros(100, np.uint8)
    a[0:40] = 1
    b[39:80] = 2  # one shared voxel of 80: IoU 1/80
    assert compare_pair(a, {1: "Nodule"}, b, {2: "Nodule"})["objects"] == {"both": 0, "only_a": 1, "only_b": 1}
