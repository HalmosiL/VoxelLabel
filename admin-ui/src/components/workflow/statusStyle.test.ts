import { describe, expect, it } from "vitest";

import { jobCaseStyle, jobProgressText } from "./statusStyle";

const c = (status: "done" | "rejected" | "pending", pending_annotation_id: string | null = null) => ({ status, pending_annotation_id });

describe("job page wording (D-09)", () => {
  it("a Review job counts decided cases and says approved / sent back", () => {
    const cases = [c("done"), c("rejected"), c("pending", "a1"), c("pending")];
    expect(jobProgressText("review", cases)).toBe("2 of 4 cases decided");
    expect(cases.map((x) => jobCaseStyle("review", x).label)).toEqual(["Approved", "Sent back", "Awaiting review", "Not handed in yet"]);
  });

  it("an Annotation job keeps its annotation wording", () => {
    const cases = [c("done"), c("rejected"), c("pending")];
    expect(jobProgressText("annotation", cases)).toBe("1 of 3 cases annotated");
    expect(cases.map((x) => jobCaseStyle("annotation", x).label)).toEqual(["Annotated", "Rejected", "Not annotated"]);
    expect(jobProgressText("annotation", [c("done")])).toBe("1 of 1 case annotated");
  });
});
