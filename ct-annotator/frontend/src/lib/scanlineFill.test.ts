import { describe, expect, it } from "vitest";

import { scanlineFill } from "./scanlineFill";

describe("scanlineFill (the Fill tool)", () => {
  it("fills a closed outline's interior from a seed and stops at the outline", () => {
    // 7x7 with a square ring of "wall" pixels from (1,1) to (5,5).
    const wall = (x: number, y: number) => (x === 1 || x === 5) && y >= 1 && y <= 5 ? true : (y === 1 || y === 5) && x >= 1 && x <= 5;
    const filled = scanlineFill(7, 7, 3, 3, (x, y) => !wall(x, y));
    let inside = 0, outside = 0;
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      if (x > 1 && x < 5 && y > 1 && y < 5) inside += filled[y * 7 + x];
      else outside += filled[y * 7 + x];
    }
    expect(inside).toBe(9);
    expect(outside).toBe(0);
  });

  it("leaks nowhere when seeded on an unfillable pixel", () => {
    const filled = scanlineFill(5, 5, 2, 2, () => false);
    expect(filled.every((v) => v === 0)).toBe(true);
  });

  it("fills the whole plane when nothing blocks it", () => {
    const filled = scanlineFill(4, 3, 0, 0, () => true);
    expect(filled.reduce((s, v) => s + v, 0)).toBe(12);
  });
});
