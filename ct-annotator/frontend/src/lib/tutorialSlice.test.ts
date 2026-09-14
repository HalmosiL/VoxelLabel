import { describe, expect, it } from "vitest";

import {
  axialMaskView,
  coronalMaskView,
  floodFillMask,
  paneDims,
  regionHistogram,
  sagittalMaskView,
  TUTORIAL_SIZE,
  TUTORIAL_SLICES,
  windowToGrey,
  writeCoronalMaskView,
  writeSagittalMaskView,
} from "./tutorialSlice";

function grid(width: number, height: number, fill: (x: number, y: number) => number): Int16Array {
  const hu = new Int16Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) hu[y * width + x] = fill(x, y);
  return hu;
}

describe("floodFillMask (the Auto tool's region grow)", () => {
  it("fills the connected region within tolerance and nothing else", () => {
    // 8x8: a 4x4 blob of 100 HU in a -1000 HU background, plus a
    // disconnected 100 HU pixel that must NOT be reached.
    const hu = grid(8, 8, (x, y) => (x >= 2 && x < 6 && y >= 2 && y < 6) || (x === 7 && y === 7) ? 100 : -1000);
    const mask = new Uint8Array(64);
    const painted = floodFillMask(hu, mask, 8, 8, 3, 3, 1, 50);
    expect(painted).toBe(16);
    expect(mask[3 * 8 + 3]).toBe(1);
    expect(mask[7 * 8 + 7]).toBe(0);
    expect(mask[0]).toBe(0);
  });

  it("respects the drag box bounds", () => {
    const hu = grid(8, 8, () => 0);
    const mask = new Uint8Array(64);
    const painted = floodFillMask(hu, mask, 8, 8, 1, 1, 2, 10, { x0: 0, y0: 0, x1: 3, y1: 3 });
    expect(painted).toBe(16);
    expect(mask[5 * 8 + 5]).toBe(0);
  });

  it("does nothing for a seed outside the plane", () => {
    const hu = grid(4, 4, () => 0);
    expect(floodFillMask(hu, new Uint8Array(16), 4, 4, -1, 0, 1, 10)).toBe(0);
    expect(floodFillMask(hu, new Uint8Array(16), 4, 4, 4, 0, 1, 10)).toBe(0);
  });
});

describe("regionHistogram (the Histogram tool)", () => {
  it("reports min/max/mean of the box, clamped to the plane, in either drag direction", () => {
    const hu = grid(10, 10, (x) => x * 10);
    const a = regionHistogram(hu, 10, 10, 2, 0, 4, 9);
    const b = regionHistogram(hu, 10, 10, 4, 9, 2, 0);
    expect(a.min).toBe(20);
    expect(a.max).toBe(40);
    expect(a.mean).toBe(30);
    expect(b).toEqual(a);
    const clamped = regionHistogram(hu, 10, 10, -5, -5, 50, 50);
    expect(clamped.min).toBe(0);
    expect(clamped.max).toBe(90);
    expect(clamped.buckets.reduce((s, n) => s + n, 0)).toBe(100);
  });
});

describe("plane views of the 3D mask", () => {
  it("axial/sagittal/coronal views read and write the same voxels", () => {
    const S = TUTORIAL_SIZE, Z = TUTORIAL_SLICES;
    const mask = new Uint8Array(S * S * Z);
    const x = 10, y = 20, z = 30;
    mask[z * S * S + y * S + x] = 7;
    expect(axialMaskView(mask, z)[y * S + x]).toBe(7);
    const sag = sagittalMaskView(mask, x);
    const { width: sw } = paneDims("sagittal");
    expect(sag.includes(7)).toBe(true);
    // round-trip a write through the sagittal view
    sag.fill(0);
    sag[0] = 3;
    writeSagittalMaskView(mask, x, sag);
    expect(mask[y * S + x]).toBe(0); // (0,y,x) untouched; only the sagittal plane at x wrote index 0 of its own layout
    expect(sw).toBeGreaterThan(0);
    const cor = coronalMaskView(mask, y);
    cor.fill(9);
    writeCoronalMaskView(mask, y, cor);
    expect(mask[z * S * S + y * S + x]).toBe(9);
    expect(mask[z * S * S + (y + 1) * S + x]).toBe(0);
  });
});

describe("windowToGrey", () => {
  it("maps center-width/2 .. center+width/2 onto 0..255 and clamps", () => {
    expect(windowToGrey(-1000, 40, 400)).toBe(0);
    expect(windowToGrey(40, 40, 400)).toBeGreaterThan(120);
    expect(windowToGrey(40, 40, 400)).toBeLessThan(135);
    expect(windowToGrey(3000, 40, 400)).toBe(255);
  });
});
