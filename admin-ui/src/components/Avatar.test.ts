import { describe, expect, it } from "vitest";

import { initialsOf } from "./Avatar";
import { memberLabel } from "../api/adminApi";

describe("initialsOf", () => {
  it("takes the first letters of the first two words", () => {
    expect(initialsOf("Anna Kovács")).toBe("AK");
    expect(initialsOf("dr-test")).toBe("DT");
    expect(initialsOf("Éva Ősz")).toBe("ÉŐ");
  });
  it("one word gives two letters", () => {
    expect(initialsOf("réka")).toBe("RÉ");
    expect(initialsOf("9f3c2a")).toBe("9F");
  });
});

describe("memberLabel", () => {
  it("prefers the real name, then the username, the email, a short id", () => {
    expect(memberLabel({ user_id: "u-123456789", name: "Anna Kovács", username: "akovacs" })).toBe("Anna Kovács");
    expect(memberLabel({ user_id: "u-123456789", name: null, username: "akovacs" })).toBe("akovacs");
    expect(memberLabel({ user_id: "u-123456789", email: "a@x" })).toBe("a@x");
    expect(memberLabel({ user_id: "u-123456789" })).toBe("u-123456…");
  });
});
