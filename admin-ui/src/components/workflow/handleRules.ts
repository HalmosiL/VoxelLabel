import { WorkflowCardType } from "../../api/workflowApi";

/** Single source of truth for which handles each card type exposes --
 * used both by the node components (to render the right <Handle/>s) and
 * by the board's client-side connection check, so the two can't drift
 * apart. Mirrors the validation admin-service's create_workflow_edge
 * enforces server-side. */
export interface HandleRule {
  hasInput: boolean;
  outputHandles: string[];
}

export const HANDLE_RULES: Record<WorkflowCardType, HandleRule> = {
  dataset: { hasInput: false, outputHandles: ["output"] },
  // Split has no graph output of its own: its result is expressed as
  // materialized Dataset cards (auto-created/updated on Run), not an edge.
  split: { hasInput: true, outputHandles: [] },
  filter: { hasInput: true, outputHandles: ["output"] },
  union: { hasInput: true, outputHandles: ["output"] },
  annotation: { hasInput: true, outputHandles: ["output"] },
  review: { hasInput: true, outputHandles: ["output"] },
  note: { hasInput: false, outputHandles: [] },
  milestone: { hasInput: false, outputHandles: [] },
};

export function isValidConnection(
  sourceType: WorkflowCardType,
  sourceHandle: string | null | undefined,
  targetType: WorkflowCardType
): boolean {
  const sourceRule = HANDLE_RULES[sourceType];
  const targetRule = HANDLE_RULES[targetType];
  if (!targetRule.hasInput) return false;
  if (!sourceHandle || !sourceRule.outputHandles.includes(sourceHandle)) return false;
  return true;
}

export const RUNNABLE_TYPES: WorkflowCardType[] = ["split", "filter", "union", "annotation", "review"];
