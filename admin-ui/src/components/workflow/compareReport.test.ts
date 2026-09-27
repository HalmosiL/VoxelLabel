import { describe, expect, it } from "vitest";

import { CompareResults } from "../../api/workflowApi";
import { compareCsv, diceTone } from "./compareReport";

const results: CompareResults = {
  computed_at: "2026-09-27T10:00:00Z",
  agree_dice: 0.7,
  inputs: [
    { card_id: "a", job_id: "a", title: "Reader 1", branch: "d:x:copy_0", assigned_user_id: null },
    { card_id: "b", job_id: "b", title: "Reader 2", branch: "d:x:copy_1", assigned_user_id: null },
  ],
  pairs: [{ a: 0, b: 1, images: 1, mean_dice: 0.5, objects: { both: 1, only_a: 0, only_b: 1 } }],
  images: [
    { case_id: "c", case_title: "Chest CT", series_id: "s", min_dice: 0.5, pairs: [{ a: 0, b: 1, dice: 0.5, by_label: { Nodule: 0.5 }, objects: { both: 1, only_a: 0, only_b: 1 }, voxels_a: 6, voxels_b: 8 }] },
  ],
  skipped: [],
  cases_agree: 0,
  cases_disagree: 1,
};

describe("compareReport", () => {
  it("colours a Dice by the card's threshold", () => {
    expect(diceTone(0.8, 0.7)).toContain("emerald");
    expect(diceTone(0.5, 0.7)).toContain("amber");
    expect(diceTone(null, 0.7)).toContain("gray");
  });
  it("writes a row per image and pair, a column per label", () => {
    const lines = compareCsv(results).replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("case,series_id,a,b,dice,dice_Nodule,findings_both,findings_only_a,findings_only_b,voxels_a,voxels_b");
    expect(lines[1]).toBe("Chest CT,s,Reader 1,Reader 2,0.5,0.5,1,0,1,6,8");
  });
});
