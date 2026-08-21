/** Shared styling for an Annotation/Review card's manual status, reused by
 * both node components and the properties panel -- the same
 * badge/colored-dot convention ReviewQueuePanel.STATUS_STYLE already uses
 * for annotation review statuses, just a different 3-value set. */
export const TASK_STATUS_STYLE: Record<string, { badge: string; dot: string; label: string }> = {
  todo: { badge: "badge-gray", dot: "bg-gray-400", label: "To do" },
  in_progress: { badge: "badge-blue", dot: "bg-blue-500", label: "In progress" },
  done: { badge: "badge-green", dot: "bg-emerald-500", label: "Done" },
};
