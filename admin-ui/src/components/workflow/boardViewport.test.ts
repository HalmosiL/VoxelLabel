import { beforeEach, describe, expect, it } from "vitest";

import { rememberedViewport, rememberViewport } from "./boardViewport";

describe("boardViewport", () => {
  beforeEach(() => localStorage.clear());
  it("remembers each study's own place", () => {
    rememberViewport("s1", { x: -120, y: 40, zoom: 0.6 });
    expect(rememberedViewport("s1")).toEqual({ x: -120, y: 40, zoom: 0.6 });
    expect(rememberedViewport("s2")).toBeNull();
  });
  it("ignores something unusable", () => {
    localStorage.setItem("vl.board.viewport.s1", JSON.stringify({ x: 1, y: 2, zoom: 0 }));
    expect(rememberedViewport("s1")).toBeNull();
    localStorage.setItem("vl.board.viewport.s1", "{");
    expect(rememberedViewport("s1")).toBeNull();
  });
});
