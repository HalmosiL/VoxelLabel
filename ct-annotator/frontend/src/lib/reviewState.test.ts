import { describe, expect, it } from "vitest";

import { reviewBlockedMessage, reviewStateOf } from "./reviewState";

describe("reviewStateOf", () => {
  it("a handed-in version is reviewed as itself", () => {
    expect(reviewStateOf("v1", "submitted", null)).toEqual({ kind: "reviewable", handedInId: "v1" });
  });
  it("a reviewer's draft keeps pointing at the version it reviews", () => {
    expect(reviewStateOf("v2", "draft", "v1")).toEqual({ kind: "reviewable", handedInId: "v1" });
  });
  it("an annotator's draft or an empty series is not handed in (F-09)", () => {
    expect(reviewStateOf("v3", "draft", null).kind).toBe("not_handed_in");
    expect(reviewStateOf(null, null, null).kind).toBe("not_handed_in");
  });
  it("a decided case stays decided (F-07)", () => {
    expect(reviewStateOf("v4", "approved", null)).toEqual({ kind: "decided", status: "approved" });
    expect(reviewBlockedMessage(reviewStateOf("v4", "rejected", null))).toMatch(/already rejected/);
  });
  it("says nothing when the case can be reviewed", () => {
    expect(reviewBlockedMessage(reviewStateOf("v1", "submitted", null))).toBeNull();
  });
});
