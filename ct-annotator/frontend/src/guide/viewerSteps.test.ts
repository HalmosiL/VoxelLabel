import { describe, expect, it } from "vitest";

import { ANNOTATE_STEPS, REVIEW_STEPS, tutorialSteps } from "./viewerSteps";

describe("the tutorial's tour (G-17)", () => {
  it("says Back leaves for My Jobs, not the case page", () => {
    const back = tutorialSteps(ANNOTATE_STEPS).find((s) => s.target === "back")!;
    expect(String(back.body)).toMatch(/My Jobs/);
    expect(String(back.body)).not.toMatch(/case page/);
  });

  it("is the viewer's tour otherwise, step for step -- without what only the viewer has (its 3D view)", () => {
    for (const steps of [ANNOTATE_STEPS, REVIEW_STEPS]) {
      const tut = tutorialSteps(steps);
      const shared = steps.filter((s) => !s.viewerOnly);
      expect(tut.map((s) => s.target)).toEqual(shared.map((s) => s.target));
      expect(tut.filter((s) => s.target !== "back")).toEqual(shared.filter((s) => s.target !== "back"));
      expect(steps.some((s) => s.viewerOnly && s.target === "pane-toggles")).toBe(true);
    }
  });
});
