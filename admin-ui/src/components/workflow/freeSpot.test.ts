import { describe, expect, it } from "vitest";

import { freeSpot } from "./freeSpot";

describe("freeSpot (C-21)", () => {
  it("keeps the spot when nothing is there", () => {
    expect(freeSpot({ x: 100, y: 100 }, [])).toEqual({ x: 100, y: 100 });
  });

  it("steps past every card already on or near the spot", () => {
    const taken = [{ x: 100, y: 100 }, { x: 140, y: 140 }, { x: 185, y: 175 }];
    expect(freeSpot({ x: 100, y: 100 }, taken)).toEqual({ x: 220, y: 220 });
  });

  it("thirteen cards added in a row land thirteen places apart", () => {
    const placed: { x: number; y: number }[] = [];
    for (let i = 0; i < 13; i++) placed.push(freeSpot({ x: 481, y: 404 }, placed));
    const distinct = new Set(placed.map((p) => `${p.x},${p.y}`));
    expect(distinct.size).toBe(13);
  });
});
