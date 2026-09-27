import { describe, expect, it } from "vitest";
import { crosshairPoint, displayToScreen, grabsCrosshair } from "./crosshair";

const dims = { columns: 100, rows: 50, numSlices: 20 };
const index = { axial: 4, sagittal: 9, coronal: 24 };

describe("crosshair", () => {
  it("sits where the other two planes cut each pane", () => {
    expect(crosshairPoint("axial", index, dims, 200)).toEqual({ x: 19, y: 98 }); // sagittal 9 of 100, coronal 24 of 50
    expect(crosshairPoint("sagittal", index, dims, 200)).toEqual({ x: 98, y: 45 }); // coronal across, axial down
    expect(crosshairPoint("coronal", index, dims, 200)).toEqual({ x: 19, y: 45 });
    expect(crosshairPoint("axial", { axial: 0, sagittal: null, coronal: null }, dims, 200)).toEqual({ x: 1, y: 2 });
  });

  it("maps a display point to the screen through the pane's zoom and pan", () => {
    expect(displayToScreen(100, 150, 1, 0, 200)).toBe(150); // the middle stays in the middle
    expect(displayToScreen(150, 150, 2, 10, 200)).toBe(260); // 50 right of the middle, doubled, then panned
  });

  it("a finger grabs it from further away than a mouse", () => {
    const middle = { x: 100, y: 100 };
    expect(grabsCrosshair({ x: 120, y: 110 }, middle, "touch")).toBe(true);
    expect(grabsCrosshair({ x: 120, y: 110 }, middle, "mouse")).toBe(false);
    expect(grabsCrosshair({ x: 106, y: 106 }, middle, "mouse")).toBe(true);
    expect(grabsCrosshair({ x: 140, y: 100 }, middle, "touch")).toBe(false);
  });
});
