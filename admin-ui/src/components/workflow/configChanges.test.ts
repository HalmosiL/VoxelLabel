import { describe, expect, it } from "vitest";

import { configChanges } from "./configChanges";

describe("configChanges", () => {
  it("sends only what this edit changed (C-13)", () => {
    const stale = { assigned_user_id: "dr-test", materialize_dataset: true, status: "done" };
    expect(configChanges(stale, { ...stale, materialize_dataset: false })).toEqual({ materialize_dataset: false });
  });
  it("compares lists and objects by value", () => {
    const before = { parts: [{ name: "a", ratio: 1 }], tools: ["paint"] };
    expect(configChanges(before, { ...before, parts: [{ name: "a", ratio: 1 }] })).toEqual({});
    expect(configChanges(before, { ...before, tools: ["paint", "erase"] })).toEqual({ tools: ["paint", "erase"] });
  });
  it("includes a newly set key, even to null", () => {
    expect(configChanges({ a: 1 }, { a: 1, assigned_user_id: null })).toEqual({ assigned_user_id: null });
  });
});
