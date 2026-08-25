/** Shared styling for an Annotation/Review card's manual status, reused
 * by both node components and the properties panel. */
export const TASK_STATUS_STYLE: Record<string, { badge: string; dot: string; label: string }> = {
  todo: { badge: "badge-red", dot: "bg-red-500", label: "To do" },
  in_progress: { badge: "badge-blue", dot: "bg-blue-500", label: "In progress" },
  done: { badge: "badge-green", dot: "bg-emerald-500", label: "Done" },
};

/** A single case's real annotated/not-annotated status within an
 * Annotation/Review job's scope -- distinct from TASK_STATUS_STYLE
 * above (the *job card's* manual todo/in_progress/done), reused by
 * JobDetailPage and TaskCardsPanel's expandable rows. */
export const CASE_STATUS_STYLE: Record<"annotated" | "not_annotated", { badge: string; dot: string; label: string }> = {
  annotated: { badge: "badge-green", dot: "bg-emerald-500", label: "Annotated" },
  not_annotated: { badge: "badge-gray", dot: "bg-gray-400", label: "Not annotated" },
};
