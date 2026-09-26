import { beforeEach, describe, expect, it } from "vitest";

import { isEdge, outlineMask, rememberedOverlayStyle, rememberOverlayStyle } from "./overlayStyle";

describe("overlayStyle", () => {
  beforeEach(() => localStorage.clear());
  it("a pixel with a different neighbour is on the outline", () => {
    expect(isEdge(3, [3, 3, 3, 3])).toBe(false);
    expect(isEdge(3, [3, 0, 3, 3])).toBe(true);
    expect(isEdge(3, [3, 3, 5, 3])).toBe(true);
    expect(isEdge(3, [3, 3, 3, undefined])).toBe(true); // the image's edge
    expect(isEdge(0, [1, 1, 1, 1])).toBe(false);
  });
  it("an outline mask keeps the edge of a filled square", () => {
    // 4x4 with a 3x3 block of 2 in the corner: its middle pixel (1,1) is inside
    const m = new Uint8Array([2, 2, 2, 0, 2, 2, 2, 0, 2, 2, 2, 0, 0, 0, 0, 0]);
    const o = outlineMask(m, 4, 4)!;
    expect(o[1 * 4 + 1]).toBe(0);
    expect([o[0], o[2], o[8], o[10]]).toEqual([2, 2, 2, 2]);
    expect(outlineMask(null, 4, 4)).toBeNull();
  });
  it("remembers the choice", () => {
    expect(rememberedOverlayStyle()).toBe("fill");
    rememberOverlayStyle("outline");
    expect(rememberedOverlayStyle()).toBe("outline");
  });
});
