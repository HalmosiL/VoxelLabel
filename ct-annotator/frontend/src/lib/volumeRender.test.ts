import { describe, expect, it } from "vitest";

import { fillLungHoles, flyStep, labelPalette, objectBounds, pickAlongRay, PickScene, rayBox, shrinkMask, softMask, stickVector, windowToUnit } from "./volumeRender";

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

  it("an on-screen stick moves as far as it is pushed, with the keys", () => {
    const none = { forward: false, back: false, left: false, right: false, up: false, down: false };
    const [, , z] = flyStep(none, 0, 0, 2, 0.5, { forward: 0.5, right: 0, up: 0 });
    expect(z).toBeCloseTo(-0.5);
    // a key and the stick the same way: never faster than full speed
    const [, , zz] = flyStep({ ...none, forward: true }, 0, 0, 1, 1, { forward: 1, right: 0, up: 0 });
    expect(zz).toBeCloseTo(-1);
    const [, uy] = flyStep(none, 0, 0, 1, 1, { forward: 0, right: 0, up: -1 });
    expect(uy).toBeCloseTo(-1);
  });

  it("reads a stick's push from the finger's offset", () => {
    expect(stickVector(0, -40, 40)).toEqual({ forward: 1, right: 0 }); // up the screen is forward
    expect(stickVector(20, 0, 40)).toEqual({ forward: 0, right: 0.5 });
    const far = stickVector(300, -300, 40); // past the rim: full push, same direction
    expect(Math.hypot(far.forward, far.right)).toBeCloseTo(1);
    expect(far.forward).toBeCloseTo(far.right);
    expect(stickVector(2, 1, 40)).toEqual({ forward: 0, right: 0 }); // a resting thumb doesn't drift
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

describe("softMask", () => {
  it("turns a 0/1 edge into a ramp and keeps the inside full", () => {
    // 1 row of 5, 1 slice: 0 0 1 1 1
    const f = softMask(new Uint8Array([0, 0, 1, 1, 1]), 5, 1, 1);
    expect(f[0]).toBe(0);
    expect(f[1]).toBeGreaterThan(0);
    expect(f[1]).toBeLessThan(f[2]);
    expect(f[4]).toBe(255);
  });
});

describe("picking in 3D", () => {
  // a 4x4x4 volume: empty, with a bright block at x=2, and object 5 at (1,1,1)
  const dims: [number, number, number] = [4, 4, 4];
  const data = new Uint8Array(64);
  const at = (i: number, j: number, k: number) => (k * 4 + j) * 4 + i;
  for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) data[at(2, j, k)] = 255;
  const scene = (extra: Partial<PickScene> = {}): PickScene => ({
    dims, data, window: [0, 1], opacity: 1, mode: "volume", mask: null, lung: null, surfaces: [], nearCut: 0, clipLo: [0, 0, 0], clipHi: [1, 1, 1], ...extra,
  });

  it("finds where a ray enters and leaves the box", () => {
    expect(rayBox([-1, 0.5, 0.5], [1, 0, 0])).toEqual([1, 2]);
    expect(rayBox([-1, 2, 0.5], [1, 0, 0])).toBeNull();
  });

  it("lands where the volume turns opaque", () => {
    const hit = pickAlongRay([-0.5, 0.6, 0.6], [1, 0, 0], scene());
    expect(hit?.objectId).toBeNull();
    expect(hit!.point[0]).toBeGreaterThanOrEqual(0.5);
    expect(hit!.point[0]).toBeLessThan(0.75);
  });

  it("an annotated object in the way is what is picked", () => {
    const mask = new Uint8Array(64);
    mask[at(1, 1, 1)] = 5;
    expect(pickAlongRay([-0.5, 0.3, 0.3], [1, 0, 0], scene({ mask }))?.objectId).toBe(5);
  });

  it("a drawn tree (airways, vessels) in the way is picked as a point, not an object", () => {
    const vessel = new Uint8Array(64);
    vessel[at(1, 1, 1)] = 255;
    const hit = pickAlongRay([-0.5, 0.3, 0.3], [1, 0, 0], scene({ surfaces: [new Uint8Array(64), vessel] }));
    expect(hit?.objectId).toBeNull();
    expect(hit!.point[0]).toBeLessThan(0.5); // in front of the bright block
  });

  it("a clipped-away part can't be picked", () => {
    expect(pickAlongRay([-0.5, 0.6, 0.6], [1, 0, 0], scene({ clipHi: [0.4, 1, 1] }))).toBeNull();
  });

  it("an object's middle and size", () => {
    const mask = new Uint8Array(64);
    mask[at(1, 1, 1)] = 5;
    mask[at(2, 1, 1)] = 5;
    const b = objectBounds(mask, dims, 5)!;
    expect(b.center).toEqual([0.5, 0.375, 0.375]);
    expect(b.size).toEqual([0.5, 0.25, 0.25]);
    expect(objectBounds(mask, dims, 9)).toBeNull();
  });
});
