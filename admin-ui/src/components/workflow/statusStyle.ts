/** Shared styling for an Annotation/Review card's manual status, reused
 * by both node components and the properties panel. */
export const TASK_STATUS_STYLE: Record<string, { badge: string; dot: string; label: string }> = {
  todo: { badge: "badge-red", dot: "bg-red-500", label: "To do" },
  in_progress: { badge: "badge-blue", dot: "bg-blue-500", label: "In progress" },
  done: { badge: "badge-green", dot: "bg-emerald-500", label: "Done" },
};
