import { describe, expect, it, vi } from "vitest";

import { guideImageSrc, placeCard } from "./GuideTour";

describe("GuideTour placement and pictures", () => {
  it("keeps a tall card with a picture whole on a tablet screen (G-21)", () => {
    const target = { left: 600, top: 600, right: 760, bottom: 640, width: 160, height: 40 } as DOMRect;
    const vp = { w: 1024, h: 768 };
    const { top } = placeCard(target, "bottom", vp, 444);
    expect(top + 444).toBeLessThanOrEqual(vp.h - 8);
    expect(top).toBeGreaterThanOrEqual(8);
  });

  it("loads tour pictures under the app's base path (G-13)", () => {
    vi.stubEnv("BASE_URL", "/viewer/");
    expect(guideImageSrc("viewer-toolbar.png")).toBe("/viewer/guide/viewer-toolbar.png");
    vi.unstubAllEnvs();
  });
});
