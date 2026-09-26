import { describe, expect, it } from "vitest";

import type { ObjectStats } from "../api/annotatorApi";
import { airWarning, measurementParts, objectSlices } from "./objectMeasure";

const base: ObjectStats = { voxels: 10, first_slice: 29, last_slice: 34, slice_count: 6, volume_ml: 1.2, long_axis_mm: 18.44, long_axis_slice: 31, hu_mean: -120.4, hu_min: -760, hu_max: 92, below_minus_500: 0.1 };

describe("objectMeasure", () => {
  it("says the numbers a reviewer checks", () => {
    expect(measurementParts(base)).toEqual(["slices 29–34", "1.20 mL", "long axis 18.4 mm (slice 31)", "mean -120 HU (-760 … 92)"]);
    expect(measurementParts({ ...base, last_slice: 29, volume_ml: null, long_axis_mm: null, hu_mean: null })).toEqual(["slice 29"]);
  });
  it("warns when much of it is air", () => {
    expect(airWarning(base)).toBeNull();
    expect(airWarning({ ...base, below_minus_500: 0.38 })).toMatch(/^38% of it is below −500 HU: expected for ground glass, not for a solid nodule/);
  });
  it("lists the slices an object is on", () => {
    // 3 slices of 2 voxels
    expect(objectSlices(new Uint8Array([0, 1, 0, 0, 1, 1]), 2, 1)).toEqual([0, 2]);
    expect(objectSlices(null, 2, 1)).toEqual([]);
  });
});
