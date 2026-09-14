import { describe, expect, it } from "vitest";

import { formatAnswers, ObjectField, scaleBounds, usableFields } from "./ObjectForm";

const FIELDS: ObjectField[] = [
  { name: "Type", kind: "choice", options: ["solid", "sub-solid", "ground-glass"] },
  { name: "Calcified", kind: "check" },
  { name: "Confidence", kind: "scale", min: 1, max: 5 },
  { name: "", kind: "check" },
  { name: "Empty choice", kind: "choice", options: [" "] },
  { name: "Type", kind: "check" },
];

describe("usableFields", () => {
  it("drops unnamed fields, choices without options and repeated names", () => {
    expect(usableFields(FIELDS).map((f) => `${f.kind}:${f.name}`)).toEqual(["choice:Type", "check:Calcified", "scale:Confidence"]);
    expect(usableFields(undefined)).toEqual([]);
  });
});

describe("scaleBounds", () => {
  it("defaults to 1..5 by 1 and repairs an inverted range", () => {
    expect(scaleBounds({ name: "x", kind: "scale" })).toEqual({ min: 1, max: 5, step: 1 });
    expect(scaleBounds({ name: "x", kind: "scale", min: 0, max: 10, step: 2 })).toEqual({ min: 0, max: 10, step: 2 });
    expect(scaleBounds({ name: "x", kind: "scale", min: 5, max: 2 })).toEqual({ min: 5, max: 9, step: 1 });
  });
});

describe("formatAnswers", () => {
  it("lists ticks by name, choices and scales as name: value, skipping cleared ones", () => {
    expect(formatAnswers({ Type: "solid", Calcified: true, Confidence: 4, Other: false, Note: "" })).toBe("Type: solid · Calcified · Confidence: 4");
  });
  it("is empty without answers", () => {
    expect(formatAnswers(undefined)).toBe("");
    expect(formatAnswers({})).toBe("");
  });
});
