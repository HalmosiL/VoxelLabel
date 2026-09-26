import { describe, expect, it } from "vitest";

import { fillLungHoles, flyStep, labelPalette, shrinkMask, windowToUnit } from "./volumeRender";

const info = { huOffset: -1024, huStep: 16 };

describe("volumeRender", () => {
  it("puts a window in texture units", () => {
    const [lo, hi] = windowToUnit(-600, 1500, info); // lung
    expect(lo).toBeCloseTo((-1350 + 1024) / 16 / 255);
    expect(hi).toBeCloseTo((150 + 1024) / 16 / 255);
  });

  it("colours each object by its label, hidden ones not at all", () => {
    const p = labelPalette(
      [
        { id: 1, label_id: 7, hidden: false },
        { id: 2, label_id: 7, hidden: true },
      ],
      [{ id: 7, color: "#ff8000" }],
    );
    expect([...p.slice(4, 8)]).toEqual([255, 128, 0, 255]);
    expect([...p.slice(8, 12)]).toEqual([0, 0, 0, 0]);
    expect([...p.slice(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it("shrinks the mask without losing a one-voxel object", () => {
    // 1 slice, 4x4, a lone voxel of object 3 at (3, 2)
    const m = new Uint8Array(16);
    m[2 * 4 + 3] = 3;
    const s = shrinkMask(m, 4, 4, 1, 2);
    expect([...s]).toEqual([0, 0, 0, 3]);
    expect(shrinkMask(m, 4, 4, 1, 1)).toBe(m);
  });

  it("flies where it looks", () => {
    const none = { forward: false, back: false, left: false, right: false, up: false, down: false };
    const [x, y, z] = flyStep({ ...none, forward: true }, 0, 0, 2, 0.5);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(-1);
    const [ux, uy] = flyStep({ ...none, up: true }, 1, 0.3, 1, 1);
    expect(ux).toBeCloseTo(0);
    expect(uy).toBeCloseTo(1);
    const [sx, , sz] = flyStep({ ...none, right: true }, 0, 0, 1, 1);
    expect(sx).toBeCloseTo(1);
    expect(sz).toBeCloseTo(0);
  });
});

describe("fillLungHoles", () => {
  it("fills a vessel the lung encloses, not what reaches the edge", () => {
    // 5x5, one slice: a ring of lung around a vessel at the centre, and a
    // gap in the ring's right side leading to the edge
    const m = new Uint8Array([
      0, 0, 0, 0, 0,
      0, 1, 1, 1, 0,
      0, 1, 0, 1, 0,
      0, 1, 1, 1, 0,
      0, 0, 0, 0, 0,
    ]);
    const f = fillLungHoles(m, 5, 5, 1);
    expect(f[2 * 5 + 2]).toBe(1);
    expect(f[0]).toBe(0);
    const open = m.slice();
    open[2 * 5 + 3] = 0; // the ring opens to the right
    expect(fillLungHoles(open, 5, 5, 1)[2 * 5 + 2]).toBe(0);
  });
});
