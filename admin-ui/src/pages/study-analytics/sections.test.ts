import { describe, expect, it } from "vitest";

import { CaseStep } from "../../api/studyAnalyticsApi";
import { compressPath } from "./sections";

const step = (s: string, kind: CaseStep["kind"]): CaseStep => ({ card_id: s, step: s, kind, at: "2026-09-01T09:00:00Z", by: "x" });

describe("compressPath", () => {
  it("folds back-to-back repeats of the same round into one counted group", () => {
    const path = [step("A", "submitted"), step("R", "rejected"), step("A", "submitted"), step("R", "rejected"), step("A", "submitted"), step("R", "approved"), step("S", "approved")];
    const groups = compressPath(path);
    expect(groups.map((g) => [g.steps.map((p) => `${p.step}${p.kind[0]}`).join(">"), g.times])).toEqual([
      ["As>Rr", 2],
      ["As", 1],
      ["Ra", 1],
      ["Sa", 1],
    ]);
  });

  it("leaves a path without repeats as it is", () => {
    const path = [step("A", "submitted"), step("R", "approved")];
    expect(compressPath(path).map((g) => g.times)).toEqual([1, 1]);
  });
});
