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
  | "milestone"
  // "surface" is the legacy, single generic type these two were split
  // from -- kept only so a stray pre-existing row of that type doesn't
  // crash the board; no new card is ever created with it.
  | "surface"
  | "annotation_surface"
  | "review_surface";

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
  // Split's parts are keyed by a stable positional handle ("part_0",
  // "part_1", ...), not a fixed train/val shape.
  output_case_ids: string[] | Record<string, string[]> | null;
  output_count: number | Record<string, number> | null;
  last_run_at: string | null;
  stale: boolean;
  annotation_progress?: { annotated: number; total: number };
  // Split: handle ("part_0", ...) -> id of the Dataset card materialized
  // for that part. Review: handle ("approved" | "rejected") -> id of the
  // Dataset card materialized for that decision.
  materialized_card_ids?: Record<string, string>;
  // Review only: handle -> case count for each materialized_card_ids
  // entry, without a second round trip to fetch each Dataset card.
  materialized_counts?: Record<string, number>;
  // Annotation only: id of the "materialize as dataset" child, if enabled.
  materialized_card_id?: string | null;
  // Dataset only: set when this card was auto-created by a Split/Annotation/Review Run.
  materialized_from?: { card_id: string; title: string } | null;
}

export interface SplitPart {
  name: string;
  ratio: number;
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

export interface SurfaceConfig {
  tools: string[];
  panes: string[];
  show_3d: boolean;
}

/** The Surface card's config connected to this Annotation/Review card,
 * or the permissive (everything enabled) default if none is connected.
 * Used by WorkflowPropertiesPanel to preview an Annotation/Review card's
 * effective restriction. */
export function getSurfaceConfig(cardId: string): Promise<SurfaceConfig> {
  return apiFetch(base, `/admin/workflow-cards/${cardId}/surface-config`);
}

export interface MyJob {
  study_id: string;
  study_name: string | null;
  card_id: string;
  card_title: string;
  card_type: WorkflowCardType;
  status: string;
  cases: { id: string; title: string | null; annotated: boolean }[];
}

/** Every Annotation/Review card assigned to the calling user, across
 * every Study -- backs the "My Jobs" page. */
export function listMyJobs(): Promise<MyJob[]> {
  return apiFetch(base, "/admin/my-jobs");
}

export interface WorkflowCardCase {
  id: string;
  title: string | null;
  annotated: boolean;
  // Review cards only: id of the latest Annotation record if it's still
  // awaiting a decision, null once approved/rejected or if nothing's
  // been submitted yet. Backs the Study page's per-case Approve/Reject
  // buttons.
  pending_annotation_id?: string | null;
}

/** Same per-case annotated/not-annotated breakdown listMyJobs already
 * carries per card, just reachable for any Annotation/Review card the
 * caller can see (not only their own assigned ones) -- backs the
 * expandable row on the Study page's Annotations/Reviews tables. */
export function getWorkflowCardCases(cardId: string): Promise<WorkflowCardCase[]> {
  return apiFetch(base, `/admin/workflow-cards/${cardId}/cases`);
}
