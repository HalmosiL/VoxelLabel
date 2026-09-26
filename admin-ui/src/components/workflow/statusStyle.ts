/** Shared styling for an Annotation/Review card's manual status, reused
 * by both node components and the properties panel. */
export const TASK_STATUS_STYLE: Record<string, { badge: string; dot: string; label: string }> = {
  todo: { badge: "badge-red", dot: "bg-red-500", label: "To do" },
  in_progress: { badge: "badge-blue", dot: "bg-blue-500", label: "In progress" },
  done: { badge: "badge-green", dot: "bg-emerald-500", label: "Done" },
};

/** A single case's real status within an Annotation/Review job's scope
 * -- distinct from TASK_STATUS_STYLE above (the *job card's* manual
 * todo/in_progress/done), reused by JobDetailPage and TaskCardsPanel's
 * expandable rows. "rejected" is kept separate from "pending" so a case
 * sent back for rework doesn't read as "nothing has happened here yet". */
export const CASE_STATUS_STYLE: Record<"done" | "rejected" | "pending", { badge: string; dot: string; label: string }> = {
  done: { badge: "badge-green", dot: "bg-emerald-500", label: "Annotated" },
  rejected: { badge: "badge-red", dot: "bg-red-500", label: "Rejected" },
  pending: { badge: "badge-gray", dot: "bg-gray-400", label: "Not annotated" },
};

/** On a Review card specifically, "pending" is ambiguous: it covers both
 * a case that genuinely has nothing submitted yet, and one that's been
 * submitted and is sitting in the queue waiting on a decision -- the
 * latter showing the same gray "Not annotated" badge as the former
 * reads as if the annotation never arrived. Use this instead of
 * CASE_STATUS_STYLE.pending whenever a case's `pending_annotation_id`
 * is set (i.e. there's a real submitted annotation awaiting review). */
export const AWAITING_REVIEW_STYLE = { badge: "badge-blue", dot: "bg-blue-500", label: "Awaiting review" };

type JobCase = { status: "done" | "rejected" | "pending"; pending_annotation_id?: string | null };

/** A Review job's cases in review words: approved / sent back / awaiting
 * a decision / nothing handed in yet. The page used the annotation words
 * ("Annotated", "Not annotated") for both job types (D-09). */
const REVIEW_CASE_STYLE = {
  done: { badge: "badge-green", dot: "bg-emerald-500", label: "Approved" },
  rejected: { badge: "badge-red", dot: "bg-red-500", label: "Sent back" },
  pending: { badge: "badge-gray", dot: "bg-gray-400", label: "Not handed in yet" },
};

export function jobCaseStyle(cardType: string, c: JobCase): { badge: string; dot: string; label: string } {
  if (cardType !== "review") return CASE_STATUS_STYLE[c.status];
  if (c.status === "pending" && c.pending_annotation_id) return AWAITING_REVIEW_STYLE;
  return REVIEW_CASE_STYLE[c.status];
}

/** "2 of 4 cases decided" for a Review job -- a sent-back case is decided
 * too, the old count was approved-only -- "1 of 3 cases annotated" for an
 * Annotation job. */
export function jobProgressText(cardType: string, cases: JobCase[]): string {
  const n = finishedCount(cardType, cases);
  return `${n} of ${cases.length} case${cases.length === 1 ? "" : "s"} ${cardType === "review" ? "decided" : "annotated"}`;
}

/** Cases this job is finished with: annotated, or for a Review job decided
 * either way. */
export function finishedCount(cardType: string, cases: JobCase[]): number {
  return cases.filter((c) => c.status === "done" || (cardType === "review" && c.status === "rejected")).length;
}

/** Cases the reviewer sent back that are the annotator's to redo -- an
 * Annotation job only (on a Review job they are decided work). */
export function sentBackCount(cardType: string, cases: JobCase[]): number {
  return cardType === "review" ? 0 : cases.filter((c) => c.status === "rejected").length;
}
