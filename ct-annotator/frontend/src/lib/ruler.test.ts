import { describe, expect, it } from "vitest";

import { rulerLabel, rulerLengthMm } from "./ruler";

describe("ruler", () => {
  const spacing: [number, number, number] = [3, 0.5, 0.6];
  it("measures in mm on the axial pane with the pixel spacing", () => {
    expect(rulerLengthMm({ pane: "axial", index: 0, a: { x: 0, y: 0 }, b: { x: 30, y: 40 } }, spacing)).toBeCloseTo(Math.hypot(30 * 0.6, 40 * 0.5));
  });
  it("counts slices vertically on the sagittal and coronal panes", () => {
    expect(rulerLengthMm({ pane: "sagittal", index: 0, a: { x: 0, y: 0 }, b: { x: 0, y: 4 } }, spacing)).toBeCloseTo(12);
    expect(rulerLengthMm({ pane: "coronal", index: 0, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }, spacing)).toBeCloseTo(6);
  });
  it("says pixels when the spacing is unknown", () => {
    expect(rulerLabel({ pane: "axial", index: 0, a: { x: 0, y: 0 }, b: { x: 3, y: 4 } }, null)).toBe("5 px (no spacing in the files)");
    expect(rulerLabel({ pane: "axial", index: 0, a: { x: 0, y: 0 }, b: { x: 30, y: 40 } }, [1, 0.5, 0.5])).toBe("25.0 mm");
  });
});
