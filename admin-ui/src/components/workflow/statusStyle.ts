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
