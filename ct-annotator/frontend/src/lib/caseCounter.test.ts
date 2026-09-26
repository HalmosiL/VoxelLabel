import { describe, expect, it } from "vitest";

import { caseCounterText } from "./caseCounter";

describe("caseCounterText (UX-annot-1-04, UX-rev-2-12)", () => {
  it("says the real position, not 'Case 1 of the ones left'", () => {
    // the second of two cases, the first already decided
    expect(caseCounterText({ index: 1, total: 2, openOthers: 0, currentDone: false, reviewMode: true })).toBe("Case 2 of 2 · last one open");
    expect(caseCounterText({ index: 0, total: 4, openOthers: 3, currentDone: false, reviewMode: false })).toBe("Case 1 of 4 · 3 more to do");
  });
  it("says when this one is done and what's left", () => {
    expect(caseCounterText({ index: 2, total: 4, openOthers: 1, currentDone: true, reviewMode: false })).toBe("Case 3 of 4 · handed in · 1 more to do");
    expect(caseCounterText({ index: 3, total: 4, openOthers: 0, currentDone: true, reviewMode: true })).toBe("Case 4 of 4 · decided · all done");
  });
});
