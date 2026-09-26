import { beforeEach, describe, expect, it } from "vitest";

import { clampPosition, MAX_POSITIONS, rememberedLayout, rememberedPosition, rememberLayout, rememberPosition } from "./viewState";

describe("viewState", () => {
  beforeEach(() => localStorage.clear());

  it("remembers the layout", () => {
    expect(rememberedLayout()).toBeNull();
    rememberLayout({ visible: { sagittal: false, coronal: true, axial: true, three_d: false }, maximized: "axial" });
    expect(rememberedLayout()).toEqual({ visible: { sagittal: false, coronal: true, axial: true, three_d: false }, maximized: "axial" });
  });

  it("an unusable layout is no layout", () => {
    rememberLayout({ visible: { sagittal: false, coronal: false, axial: false, three_d: false }, maximized: null });
    expect(rememberedLayout()).toBeNull();
    localStorage.setItem("vl.view.layout", "not json");
    expect(rememberedLayout()).toBeNull();
  });

  it("remembers where each case was left, the newest ones", () => {
    rememberPosition("s1", { axial: 40, coronal: 200, sagittal: null }, 1);
    expect(rememberedPosition("s1")).toEqual({ axial: 40, coronal: 200, sagittal: null });
    expect(rememberedPosition("s2")).toBeNull();
    for (let i = 0; i < MAX_POSITIONS; i++) rememberPosition(`n${i}`, { axial: i, coronal: null, sagittal: null }, 10 + i);
    expect(rememberedPosition("s1")).toBeNull(); // the oldest went
    expect(rememberedPosition(`n${MAX_POSITIONS - 1}`)?.axial).toBe(MAX_POSITIONS - 1);
  });

  it("a remembered slice is kept inside the series", () => {
    expect(clampPosition({ axial: 300, coronal: -2, sagittal: 10 }, { slices: 120, rows: 512, columns: 512 })).toEqual({ axial: 119, coronal: 0, sagittal: 10 });
  });
});
