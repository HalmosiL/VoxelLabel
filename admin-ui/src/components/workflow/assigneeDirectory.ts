import { createContext, useContext } from "react";

/** Study member id -> display name, provided by WorkflowBoardPage so the
 * Annotation/Review nodes can show "dr-test" instead of a UUID prefix.
 * A context rather than node data, so every place that builds a node
 * (board load, drop, paste, undo) doesn't have to thread the lookup. */
export const AssigneeDirectoryContext = createContext<Record<string, string>>({});

export function useAssigneeLabel(userId: string | null): string | null {
  const directory = useContext(AssigneeDirectoryContext);
  if (!userId) return null;
  return directory[userId] ?? `${userId.slice(0, 8)}…`;
}
