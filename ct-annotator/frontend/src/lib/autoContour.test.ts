import { describe, expect, it } from "vitest";

import { fillHoles, growRegion, HU_MAX, nearestSeed, otsuThreshold, suggestRange } from "./autoContour";
import { scanlineFill } from "./scanlineFill";

/** A 40x40 box of lung (-850 HU) with a round nodule (30 HU, r=10) whose
 * core (r=4) is calcified (600 HU) -- the case the old ±tolerance grow
 * couldn't do. */
function calcifiedNodule() {
  const width = 40;
  const height = 40;
  const data = new Int16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - 20, y - 20);
      data[y * width + x] = d <= 4 ? 600 : d <= 10 ? 30 : -850;
    }
  }
  return { data, width, height };
}

const count = (m: Uint8Array) => m.reduce((n, v) => n + v, 0);
const discArea = (r: number) => {
  let n = 0;
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (Math.hypot(x - 20, y - 20) <= r) n++;
  return n;
};

describe("auto contour", () => {
  it("the old centre ± tolerance grow stays inside the calcification", () => {
    const p = calcifiedNodule();
    const seed = p.data[20 * 40 + 20];
    const old = scanlineFill(40, 40, 20, 20, (x, y) => Math.abs(p.data[y * 40 + x] - seed) <= 300);
    expect(count(old)).toBe(discArea(4));
  });

  it("suggests 'denser than the lung', open at the top, from the box itself", () => {
    const p = calcifiedNodule();
    const t = otsuThreshold(p.data);
    expect(t).toBeGreaterThan(-850);
    expect(t).toBeLessThanOrEqual(30);
    expect(suggestRange(p)).toEqual({ low: t, high: HU_MAX });
  });

  it("grows the whole nodule, calcified core included", () => {
    const p = calcifiedNodule();
    const region = growRegion(p, suggestRange(p));
    expect(count(region)).toBe(discArea(10));
  });

  it("with an upper bound below the calcification, fill holes still takes the core", () => {
    const p = calcifiedNodule();
    const range = { low: -400, high: 200 };
    // the core isn't in range: without fill holes the region is a ring...
    expect(count(growRegion(p, range))).toBe(discArea(10) - discArea(4));
    // ...and the core is a hole the ring encloses
    expect(count(growRegion(p, range, { fillHoles: true }))).toBe(discArea(10));
  });

  it("seeds from the in-range pixel nearest the centre when the centre itself is out of range", () => {
    const p = calcifiedNodule();
    const seed = nearestSeed(p, (v) => v >= -400 && v <= 200);
    expect(seed).not.toBeNull();
    expect(Math.hypot(seed!.x - 20, seed!.y - 20)).toBeGreaterThan(4);
    expect(Math.hypot(seed!.x - 20, seed!.y - 20)).toBeLessThanOrEqual(6);
    expect(nearestSeed(p, (v) => v > 5000)).toBeNull();
  });

  it("fillHoles leaves a region open to the border alone", () => {
    // a C shape: its gap reaches the border, so the inside isn't a hole
    const w = 7;
    const h = 7;
    const m = new Uint8Array(w * h);
    for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) if (x === 1 || y === 1 || y === 5) m[y * w + x] = 1;
    expect(count(fillHoles(m, w, h))).toBe(count(m));
    // closed ring -> its inside is filled
    for (let y = 1; y < 6; y++) m[y * w + 5] = 1;
    expect(count(fillHoles(m, w, h))).toBe(25);
  });

  it("is empty when nothing is in range", () => {
    const p = calcifiedNodule();
    expect(count(growRegion(p, { low: 2000, high: 2500 }))).toBe(0);
  });
});
