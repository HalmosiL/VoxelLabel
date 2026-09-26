import { describe, expect, it } from "vitest";

import { initialWindow, WINDOW_PRESETS } from "./windowPreset";

const LUNG = { center: -600, width: 1500 };

describe("initialWindow (K8)", () => {
  it("opens in the Surface's preset, whatever the image says", () => {
    expect(initialWindow({ surfacePreset: "Lung", rememberedPreset: "Bone", dicom: { center: 40, width: 400 } })).toEqual({ ...LUNG, source: "surface" });
  });
  it("else the preset this person last chose in this job", () => {
    expect(initialWindow({ surfacePreset: null, rememberedPreset: "Lung", dicom: { center: 40, width: 400 } })).toEqual({ ...LUNG, source: "remembered" });
  });
  it("else the image's own window, else soft tissue", () => {
    expect(initialWindow({ surfacePreset: null, rememberedPreset: null, dicom: { center: -500, width: 2000 } })).toEqual({ center: -500, width: 2000, source: "image" });
    expect(initialWindow({ surfacePreset: null, rememberedPreset: null, dicom: null })).toEqual({ center: 40, width: 400, source: "default" });
  });
  it("ignores names it doesn't know", () => {
    expect(initialWindow({ surfacePreset: "Plasma", rememberedPreset: "??", dicom: null }).source).toBe("default");
    expect(WINDOW_PRESETS.map((p) => p.label)).toEqual(["Soft tissue", "Lung", "Bone", "Brain"]);
  });
});
