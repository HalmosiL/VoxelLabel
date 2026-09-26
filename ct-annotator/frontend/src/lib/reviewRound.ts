import { formatAnswers } from "../components/ObjectForm";
import type { SegLabel, SegObject } from "../api/annotatorApi";

/** Why a reviewer rejects an object -- one tap after Reject, optional.
 * Fixed categories so the Usage page can count them; the free-text
 * comment still says the specifics. */
export const REJECT_REASONS: { key: string; label: string }[] = [
  { key: "boundary", label: "Boundary off" },
  { key: "missed", label: "Missed finding" },
  { key: "wrong_label", label: "Wrong label" },
  { key: "not_a_finding", label: "Not a finding" },
  { key: "form", label: "Form answers" },
  { key: "other", label: "Other" },
];

export function rejectReasonLabel(key: string | undefined): string | undefined {
  return REJECT_REASONS.find((r) => r.key === key)?.label;
}

/** The comment that travels with a review decision -- what the annotator
 * reads on My Jobs and the job page. Every rejected object is named, with
 * its reason, the reviewer's comment and the form answers; an accepted
 * object only when the reviewer wrote something about it. The annotator's
 * own note is never part of it (F-02), and a rejected object without a
 * reason or comment is still named (F-17). */
export function reviewCommentText(objects: SegObject[], labels: SegLabel[]): string {
  return objects
    .filter((o) => o.review_status === "rejected" || (o.review_comment && o.review_comment.trim()))
    .map((o) => {
      const name = `${labels.find((l) => l.id === o.label_id)?.name ?? "Object"} ${o.instance_number}`;
      const rejected = o.review_status === "rejected";
      const reason = rejected ? (rejectReasonLabel(o.reject_reason) ?? "rejected").toLowerCase() : undefined;
      const answers = rejected ? formatAnswers(o.attributes) : "";
      const text = (o.review_comment ?? "").trim();
      return `${name}${reason ? ` (${reason})` : ""}${answers ? ` [${answers}]` : ""}${text ? `: ${text}` : ""}`;
    })
    .join("; ");
}

/** The objects as the annotator hands the case in again: each one's
 * verdict from the round just finished moves to `previous_review`, and
 * the current decision fields start empty. Only the reviewer's words are
 * cleared -- the annotator's own note stays. Old verdicts and comments
 * were either wiped (F-06) or re-sent as if current (F-05). */
export function handInObjects(objects: SegObject[]): SegObject[] {
  return objects.map((o) => {
    const decided = o.review_status === "accepted" || o.review_status === "rejected";
    const next: SegObject = { ...o, review_status: undefined, reject_reason: undefined, review_comment: undefined, reply: undefined };
    if (decided) {
      next.previous_review = {
        status: o.review_status as "accepted" | "rejected",
        ...(o.reject_reason ? { reject_reason: o.reject_reason } : {}),
        ...(o.review_comment && o.review_comment.trim() ? { review_comment: o.review_comment.trim() } : {}),
        ...(o.reply && o.reply.trim() ? { reply: o.reply.trim() } : {}),
      };
    }
    return next;
  });
}

/** An object added since the last review round: the case has been
 * reviewed before (some object carries a previous verdict) and this one
 * doesn't (F-06). */
export function isNewThisRound(obj: SegObject, objects: SegObject[]): boolean {
  return !obj.previous_review && objects.some((o) => o.previous_review);
}

/** One line describing an earlier verdict, e.g. "rejected (boundary off): too wide". */
export function previousReviewText(obj: SegObject): string | null {
  const prev = obj.previous_review;
  if (!prev) return null;
  const reason = prev.status === "rejected" ? rejectReasonLabel(prev.reject_reason)?.toLowerCase() : undefined;
  return `${prev.status}${reason ? ` (${reason})` : ""}${prev.review_comment ? `: ${prev.review_comment}` : ""}${prev.reply ? ` · annotator's reply: ${prev.reply}` : ""}`;
}

/** What the reviewer sent back, for the annotator's rework banner: each
 * rejected object with its reason and comment, and the case-level comment
 * when no object carries one (a case sent back as a missed finding). */
export function sentBackItems(objects: SegObject[], labels: SegLabel[], caseComment?: string | null): { id: number | null; name: string; text: string }[] {
  const items = objects
    .filter((o) => o.review_status === "rejected")
    .map((o) => {
      const label = labels.find((l) => l.id === o.label_id);
      const reason = rejectReasonLabel(o.reject_reason);
      const text = [reason, o.review_comment?.trim()].filter(Boolean).join(": ");
      return { id: o.id, name: label ? `${label.name} ${o.instance_number}` : `Object ${o.instance_number}`, text: text || "rejected" };
    });
  if (items.length === 0 && caseComment?.trim()) return [{ id: null, name: "The case", text: caseComment.trim() }];
  return items;
}
