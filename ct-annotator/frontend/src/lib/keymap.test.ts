import { describe, expect, it } from "vitest";

import { isHelpKey, keymapFor } from "./keymap";

describe("keymap", () => {
  it("review leaves the drawing keys out", () => {
    const review = keymapFor("review").flatMap((g) => g.entries.flatMap((e) => e.keys));
    expect(review).toContain("Alt+click");
    expect(review).not.toContain("N");
    expect(keymapFor("review").map((g) => g.title)).not.toContain("Drawing");
    expect(keymapFor("annotate").flatMap((g) => g.entries.flatMap((e) => e.keys))).toContain("Ctrl+Z");
  });
  it("? opens the help, Ctrl+? does not", () => {
    expect(isHelpKey({ key: "?", ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
    expect(isHelpKey({ key: "?", ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
    expect(isHelpKey({ key: "/", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
  });
});
