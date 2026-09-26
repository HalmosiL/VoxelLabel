import { describe, expect, it } from "vitest";

import { describeKey } from "./tracker";

describe("describeKey (K1)", () => {
  it("never records which character was typed, only that one was", () => {
    // A note typed while focus missed the comment box was stored letter by letter.
    for (const key of ["a", "Z", "7", ";", "é"]) {
      expect(describeKey(new KeyboardEvent("keydown", { key }))).toBe("char");
      expect(describeKey(new KeyboardEvent("keydown", { key, shiftKey: true }))).toBe("char");
    }
    expect(describeKey(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }))).toBe("Ctrl+z");
    expect(describeKey(new KeyboardEvent("keydown", { key: " " }))).toBe("Space");
    expect(describeKey(new KeyboardEvent("keydown", { key: "Escape" }))).toBe("Escape");
    expect(describeKey(new KeyboardEvent("keydown", { key: "Shift" }))).toBeNull();
  });
});
