/** Whether the case open in review mode can be reviewed, from the version
 * the viewer loaded (F-01, F-07, F-09). annotation-service enforces the
 * same rules; this lets the viewer say so up front instead of failing on
 * Submit review.
 *
 * - reviewable: the latest version is handed-in work -- SUBMITTED, or a
 *   reviewer's draft of it (review_of_id). `handedInId` is what every
 *   review save refers to, so it stays handed in.
 * - decided: already approved or rejected; only a platform admin can
 *   change a decision.
 * - not_handed_in: nothing saved, or the annotator's own draft. */
export type ReviewState =
  | { kind: "reviewable"; handedInId: string }
  | { kind: "decided"; status: "approved" | "rejected" }
  | { kind: "not_handed_in" };

export function reviewStateOf(versionId: string | null, versionStatus: string | null, reviewOfId: string | null): ReviewState {
  if (versionId && versionStatus === "submitted") return { kind: "reviewable", handedInId: versionId };
  if (versionId && versionStatus === "draft" && reviewOfId) return { kind: "reviewable", handedInId: reviewOfId };
  if (versionStatus === "approved" || versionStatus === "rejected") return { kind: "decided", status: versionStatus };
  return { kind: "not_handed_in" };
}

/** The line review mode shows when the case can't be reviewed, or null. */
export function reviewBlockedMessage(state: ReviewState | null): string | null {
  if (!state || state.kind === "reviewable") return null;
  if (state.kind === "decided") return `This case was already ${state.status}. A decision can only be changed by a platform admin.`;
  return "This case hasn't been handed in for review yet -- the annotator still has to mark it as annotated.";
}
