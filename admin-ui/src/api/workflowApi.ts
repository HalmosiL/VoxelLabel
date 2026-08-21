import { API } from "../config";
import { apiFetch } from "./client";

export type WorkflowCardType =
  | "dataset"
  | "split"
  | "filter"
  | "annotation"
  | "review"
  | "union"
  | "note"
  | "milestone";

export type WorkflowCardConfig = Record<string, unknown>;

export interface WorkflowCard {
  id: string;
  type: WorkflowCardType;
  title: string;
  position_x: number;
  position_y: number;
  width: number | null;
  height: number | null;
  config: WorkflowCardConfig;
  output_case_ids: string[] | { train: string[]; val: string[] } | null;
  output_count: number | { train: number; val: number } | null;
  last_run_at: string | null;
  stale: boolean;
  annotation_progress?: { annotated: number; total: number };
}

export interface WorkflowEdge {
  id: string;
  source_card_id: string;
  source_handle: string;
  target_card_id: string;
  target_handle: string;
}

export interface WorkflowBoard {
  cards: WorkflowCard[];
  edges: WorkflowEdge[];
}

export interface WorkflowCardInput {
  // Normally omitted (the server assigns one) -- passed by undo/redo to
  // recreate a deleted card under its original id, so edges referencing
  // it stay valid.
  id?: string;
  type: WorkflowCardType;
  title: string;
  position_x: number;
  position_y: number;
  width?: number | null;
  height?: number | null;
  config?: WorkflowCardConfig;
}

export interface WorkflowCardPatchInput {
  title?: string;
  position_x?: number;
  position_y?: number;
  width?: number | null;
  height?: number | null;
  config?: WorkflowCardConfig;
}

export interface WorkflowEdgeInput {
  id?: string; // same reasoning as WorkflowCardInput.id
  source_card_id: string;
  source_handle?: string;
  target_card_id: string;
  target_handle?: string;
}

const base = API.admin;

export function getWorkflowBoard(studyId: string): Promise<WorkflowBoard> {
  return apiFetch(base, `/admin/studies/${studyId}/workflow`);
}

export function createWorkflowCard(studyId: string, input: WorkflowCardInput): Promise<WorkflowCard> {
  return apiFetch(base, `/admin/studies/${studyId}/workflow/cards`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateWorkflowCard(cardId: string, patch: WorkflowCardPatchInput): Promise<WorkflowCard> {
  return apiFetch(base, `/admin/workflow-cards/${cardId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteWorkflowCard(cardId: string): Promise<void> {
  return apiFetch(base, `/admin/workflow-cards/${cardId}`, { method: "DELETE" });
}

export function createWorkflowEdge(studyId: string, input: WorkflowEdgeInput): Promise<WorkflowEdge> {
  return apiFetch(base, `/admin/studies/${studyId}/workflow/edges`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteWorkflowEdge(edgeId: string): Promise<void> {
  return apiFetch(base, `/admin/workflow-edges/${edgeId}`, { method: "DELETE" });
}

export function runWorkflowCard(cardId: string): Promise<WorkflowCard> {
  return apiFetch(base, `/admin/workflow-cards/${cardId}/run`, { method: "POST" });
}
