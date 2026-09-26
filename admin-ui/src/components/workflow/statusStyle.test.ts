import { describe, expect, it } from "vitest";

import { jobCaseStyle, jobProgressText, sentBackCount } from "./statusStyle";

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

describe("sentBackCount", () => {
  const cases = [c("rejected"), c("done"), c("rejected"), c("pending")] as never[];
  it("counts what an annotator has to redo", () => {
    expect(sentBackCount("annotation", cases)).toBe(2);
  });
  it("a reviewer's rejections are decided work, not to redo", () => {
    expect(sentBackCount("review", cases)).toBe(0);
  });
});
