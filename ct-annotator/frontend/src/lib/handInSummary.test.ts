import { describe, expect, it } from "vitest";

import type { SegLabel, SegObject } from "../api/annotatorApi";
import { handInSummary, sliceSpanText } from "./handInSummary";

const labels: SegLabel[] = [
  { id: 1, name: "Nodule", color: "#f00", fields: [{ name: "Type", kind: "choice", options: ["solid", "ground glass"] }, { name: "Calcified", kind: "check" }] },
  { id: 2, name: "Vessel", color: "#00f" },
];
const obj = (id: number, label_id: number, instance_number: number, attributes?: SegObject["attributes"]): SegObject => ({ id, label_id, instance_number, locked: false, hidden: false, attributes });

describe("handInSummary", () => {
  // 3 slices of 2x2
  const volume = new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 3, 0]);

  it("finds each object's slices and flags the empty one", () => {
    const s = handInSummary(volume, 4, [obj(1, 1, 1, { Type: "solid" }), obj(2, 1, 2, { Type: "solid" }), obj(3, 2, 1)], labels);
    expect(s.rows.map((r) => [r.name, r.voxels, r.firstSlice, r.lastSlice, r.sliceCount])).toEqual([
      ["Nodule 1", 3, 1, 3, 2],
      ["Nodule 2", 0, null, null, 0],
      ["Vessel 1", 1, 3, 3, 1],
    ]);
    expect(s.empty.map((r) => r.name)).toEqual(["Nodule 2"]);
  });

  it("an unticked box is an answer; an unpicked choice is not", () => {
    const s = handInSummary(volume, 4, [obj(1, 1, 1), obj(3, 2, 1)], labels);
    expect(s.unanswered.map((r) => [r.name, r.unanswered])).toEqual([["Nodule 1", ["Type"]]]);
  });

  it("names what the reviewer sent back last round", () => {
    const s = handInSummary(volume, 4, [{ ...obj(1, 1, 1, { Type: "solid" }), review_status: "rejected" }, obj(3, 2, 1)], labels);
    expect(s.sentBack.map((r) => r.name)).toEqual(["Nodule 1"]);
  });

  it("works with no mask loaded", () => {
    expect(handInSummary(null, 4, [obj(1, 1, 1)], labels).empty).toHaveLength(1);
  });
});

describe("sliceSpanText", () => {
  const row = { id: 1, name: "", color: "", voxels: 1, unanswered: [], sentBack: false };
  it("names the span and the gaps in it", () => {
    expect(sliceSpanText({ ...row, firstSlice: 4, lastSlice: 4, sliceCount: 1 })).toBe("slice 4");
    expect(sliceSpanText({ ...row, firstSlice: 4, lastSlice: 8, sliceCount: 5 })).toBe("slices 4–8 (5)");
    expect(sliceSpanText({ ...row, firstSlice: 4, lastSlice: 8, sliceCount: 2 })).toBe("slices 4–8 (5, painted on 2)");
    expect(sliceSpanText({ ...row, voxels: 0, firstSlice: null, lastSlice: null, sliceCount: 0 })).toBe("not painted");
  });
});
