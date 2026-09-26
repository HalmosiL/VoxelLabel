import { describe, expect, it } from "vitest";

import { initialChoice, MY_STUDIES, myStudyIds, scopeOf } from "./studyScope";

describe("Usage study filter", () => {
  const studies = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("my studies are the member studies still listed", () => {
    expect(myStudyIds([{ study_id: "c" }, { study_id: "a" }, { study_id: "gone" }, { study_id: "a" }], studies)).toEqual(["a", "c"]);
  });
  it("... and the studies I created", () => {
    expect(myStudyIds([], studies, ["b"])).toEqual(["b"]);
  });
  it("My studies goes to the API as a list", () => {
    expect(scopeOf(MY_STUDIES, ["a", "c"])).toBe("a,c");
    expect(scopeOf("b", ["a"])).toBe("b");
    expect(scopeOf("", ["a"])).toBe("");
  });
  it("opens on My studies, or on what was chosen last", () => {
    expect(initialChoice(null, ["a"], ["a", "b"])).toBe(MY_STUDIES);
    expect(initialChoice(null, [], ["a", "b"])).toBe("");
    expect(initialChoice("", ["a"], ["a", "b"])).toBe("");
    expect(initialChoice("b", ["a"], ["a", "b"])).toBe("b");
    expect(initialChoice("deleted", ["a"], ["a", "b"])).toBe(MY_STUDIES);
    expect(initialChoice(MY_STUDIES, [], ["a"])).toBe("");
  });
});
