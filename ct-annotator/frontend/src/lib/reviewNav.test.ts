import { describe, expect, it } from "vitest";

import { nextUndecidedIndex } from "./reviewNav";

describe("nextUndecidedIndex", () => {
  it("skips objects already decided (G-06)", () => {
    // object 2 accepted first, then object 1 decided: go to 3, not 2
    expect(nextUndecidedIndex(["accepted", "accepted", undefined], 0)).toBe(2);
  });
  it("wraps round to an earlier undecided object", () => {
    expect(nextUndecidedIndex(["pending", "accepted", "rejected"], 2)).toBe(0);
  });
  it("is null once every other object is decided", () => {
    expect(nextUndecidedIndex(["accepted", "rejected"], 0)).toBeNull();
  });
});
