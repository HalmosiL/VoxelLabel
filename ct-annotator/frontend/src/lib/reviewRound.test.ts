import { describe, expect, it } from "vitest";

import type { SegLabel, SegObject } from "../api/annotatorApi";
import { handInObjects, isNewThisRound, previousReviewText, reviewCommentText, sentBackItems } from "./reviewRound";

const labels: SegLabel[] = [{ id: 1, name: "Nodule", color: "#f00" }, { id: 2, name: "Cyst", color: "#0f0" }];
const obj = (id: number, label_id: number, n: number, extra: Partial<SegObject> = {}): SegObject => ({ id, label_id, instance_number: n, locked: false, hidden: false, ...extra });

describe("reviewCommentText", () => {
  it("never sends the annotator's own note back as the reviewer's (F-02)", () => {
    const text = reviewCommentText([obj(1, 1, 1, { comment: "annotator note", review_status: "rejected", reject_reason: "missed" })], labels);
    expect(text).toBe("Nodule 1 (missed finding)");
  });
  it("names every rejected object, even without a reason or comment (F-17)", () => {
    const text = reviewCommentText([
      obj(1, 1, 1, { review_status: "rejected", reject_reason: "form" }),
      obj(2, 1, 2, { review_status: "accepted" }),
      obj(3, 2, 1, { review_status: "rejected" }),
    ], labels);
    expect(text).toBe("Nodule 1 (form answers); Cyst 1 (rejected)");
  });
  it("keeps an accepted object's comment when the reviewer wrote one", () => {
    expect(reviewCommentText([obj(1, 1, 1, { review_status: "accepted", review_comment: "nice" })], labels)).toBe("Nodule 1: nice");
  });
});

describe("handInObjects", () => {
  it("moves the verdict to previous_review and starts the next round empty (F-05, F-06)", () => {
    const [next] = handInObjects([obj(1, 2, 1, { comment: "mine", review_status: "rejected", reject_reason: "boundary", review_comment: "too wide" })]);
    expect(next.review_status).toBeUndefined();
    expect(next.review_comment).toBeUndefined();
    expect(next.comment).toBe("mine");
    expect(next.previous_review).toEqual({ status: "rejected", reject_reason: "boundary", review_comment: "too wide" });
    expect(previousReviewText(next)).toBe("rejected (boundary off): too wide");
  });
  it("marks objects added since the last round as new", () => {
    const objects = handInObjects([obj(1, 1, 1, { review_status: "accepted" })]).concat(obj(2, 1, 2));
    expect(isNewThisRound(objects[1], objects)).toBe(true);
    expect(isNewThisRound(objects[0], objects)).toBe(false);
  });
});

describe("sentBackItems", () => {
  const base = { label_id: 1, locked: false, hidden: false };
  it("lists each rejected object with its reason and comment", () => {
    const items = sentBackItems(
      [
        { ...base, id: 1, instance_number: 1, review_status: "rejected", reject_reason: "boundary", review_comment: " tighten the edge " },
        { ...base, id: 2, instance_number: 2, review_status: "accepted" },
        { ...base, id: 3, instance_number: 3, review_status: "rejected" },
      ],
      labels,
    );
    expect(items).toEqual([
      { id: 1, name: "Nodule 1", text: "Boundary off: tighten the edge" },
      { id: 3, name: "Nodule 3", text: "rejected" },
    ]);
  });

  it("falls back to the case's comment when no object was rejected", () => {
    expect(sentBackItems([], labels, "No objects: missed finding")).toEqual([{ id: null, name: "The case", text: "No objects: missed finding" }]);
    expect(sentBackItems([], labels, null)).toEqual([]);
  });
});

describe("the annotator's reply", () => {
  it("travels with the verdict at the hand-in, and the reviewer reads it", () => {
    const [next] = handInObjects([obj(1, 1, 1, { review_status: "rejected", reject_reason: "missed", review_comment: "add slice 55", reply: " crossing vessel " })]);
    expect(next.reply).toBeUndefined();
    expect(next.previous_review).toEqual({ status: "rejected", reject_reason: "missed", review_comment: "add slice 55", reply: "crossing vessel" });
    expect(previousReviewText(next)).toBe("rejected (missed finding): add slice 55 · annotator's reply: crossing vessel");
  });
});
