import { WorkflowCardType } from "../../api/workflowApi";

/** Single source of truth for which handles each card type exposes --
 * used both by the node components (to render the right <Handle/>s) and
 * by the board's client-side connection check, so the two can't drift
 * apart. Mirrors the validation admin-service's create_workflow_edge
 * enforces server-side. */
export interface HandleRule {
  inputHandles: string[];
  outputHandles: string[];
}

export const HANDLE_RULES: Record<WorkflowCardType, HandleRule> = {
  // A Dataset can optionally take one incoming edge: connecting something
  // into it and running it snapshots that upstream result as this card's
  // own manual case list (a user-placed, general version of Split/
  // Annotation/Review's automatic materialize).
  dataset: { inputHandles: ["input"], outputHandles: ["output"] },
  // Split has no graph output of its own: its result is expressed as
  // materialized Dataset cards (auto-created/updated on Run), not an edge.
  split: { inputHandles: ["input"], outputHandles: [] },
  filter: { inputHandles: ["input"], outputHandles: ["output"] },
  union: { inputHandles: ["input"], outputHandles: ["output"] },
  // "surface_config" is a second, independent input -- a Surface card's
  // mandatory tool/pane/3D restriction for this job. It's unrelated to
  // the ordinary data "input" handle (source flowing in) and the two
  // never mix: a "surface_config" edge can only pair with another
  // "surface_config" handle, never with "output"/"input".
  annotation: { inputHandles: ["input", "surface_config"], outputHandles: ["output"] },
  review: { inputHandles: ["input", "surface_config"], outputHandles: ["output"] },
  note: { inputHandles: [], outputHandles: [] },
  milestone: { inputHandles: [], outputHandles: [] },
  // Pure configuration, never part of the case-flow graph -- no data
  // input of its own, and its only output is the "surface_config"
  // channel into an Annotation/Review card.
  surface: { inputHandles: [], outputHandles: ["surface_config"] },
};

export function isValidConnection(
  sourceType: WorkflowCardType,
  sourceHandle: string | null | undefined,
  targetType: WorkflowCardType,
  targetHandle: string | null | undefined
): boolean {
  const sourceRule = HANDLE_RULES[sourceType];
  const targetRule = HANDLE_RULES[targetType];
  const resolvedSourceHandle = sourceHandle ?? "output";
  const resolvedTargetHandle = targetHandle ?? "input";
  // A handle only ever pairs with a same-named handle on the other end
  // ("output" <-> "input", "surface_config" <-> "surface_config") --
  // there's no cross-channel connection today.
  if (resolvedSourceHandle !== resolvedTargetHandle) return false;
  if (!sourceRule.outputHandles.includes(resolvedSourceHandle)) return false;
  if (!targetRule.inputHandles.includes(resolvedTargetHandle)) return false;
  return true;
}

export const RUNNABLE_TYPES: WorkflowCardType[] = ["dataset", "split", "filter", "union", "annotation", "review"];
