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
  | "review_surface"
  // The Clinical Trial module's three AI chat card types -- a real
  // small model driven over a real MCP server (see LlmNode.tsx and
  // LlmChatModal.tsx). "llm" is the original data-connected assistant;
  // "builder" is the Pipeline Builder (study-scoped, no connected
  // data); "criterion" is a per-eligibility-criterion sub-agent
  // (BuilderNode.tsx / CriterionNode.tsx).
  | "llm"
  | "builder"
  | "criterion";

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
  // Dataset card materialized for that decision. LLM: handle
  // ("created_1", "created_2", ...) -> id of a Dataset spawned by a
  // "create a dataset" chat request. Criterion: handle ("included" |
  // "excluded") -> id of the Dataset card materialized by its own
  // evaluate_criterion call.
  materialized_card_ids?: Record<string, string>;
  // Review/Criterion only: handle -> case count for each
  // materialized_card_ids entry, without a second round trip to fetch
  // each Dataset card.
  materialized_counts?: Record<string, number>;
  // Annotation only: id of the "materialize as dataset" child, if enabled.
  materialized_card_id?: string | null;
  // Dataset only: set when this card was auto-created by a Split/Annotation/Review Run.
  materialized_from?: { card_id: string; title: string } | null;
  // LLM/Criterion only: how many cases are currently wired into its
  // input, computed fresh on every read (neither card type is ever Run).
  llm_connected_case_count?: number;
  // LLM/Criterion only: titles of input cards not Run yet (their cases aren't counted).
  llm_unrun_sources?: string[];
}

/** One turn of an LLM card's chat transcript (config.messages). A
 * `tool_call` renders as its own distinct block in the chat UI --
 * imitating how Claude Code's own transcript shows a tool use -- rather
 * than folding into `content` as plain prose. */
export interface LlmChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  tool_call?: {
    name: string;
    args: Record<string, unknown>;
    result_summary: string;
  } | null;
  // The model's own reasoning trace for this turn, when the underlying
  // model supports Ollama's "think" mode -- rendered as a separate,
  // collapsed-by-default block above the reply. Absent/null for models
  // (or turns) with no such trace, not just an empty string.
  thinking?: string | null;
  // Every tool name that reasoning pass led to calling (may be more
  // than one), shown alongside the Thinking block itself so it's clear
  // at a glance what the reasoning resulted in without expanding it.
  // Only set on the message that also carries `thinking`.
  thinking_tools?: string[] | null;
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

export interface ConsortStage {
  criterion_card_id: string;
  title: string;
  criterion_text: string;
  input_count: number;
  included_count: number | null;
  excluded_count: number | null;
  evaluated: boolean;
}

export interface ConsortExport {
  root: { card_id: string; title: string; case_count: number };
  stages: ConsortStage[];
  final_count: number;
}

/** Walks the eligibility chain from `rootCardId` (a Dataset representing
 * the whole study population) through each chained Criterion's
 * "included" branch -- the real per-stage case counts a CONSORT flow
 * diagram needs, derived live from the board (see ConsortExportPage). */
export function getConsortExport(studyId: string, rootCardId: string): Promise<ConsortExport> {
  return apiFetch(base, `/admin/studies/${studyId}/consort-export?root_card_id=${rootCardId}`);
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

/** Sends one chat message to an LLM/Builder/Criterion card's real chat
 * session -- backs LlmChatModal. `board_changed` tells the caller
 * whether to do a full board refresh (a card and/or edge was created or
 * a materialized child's contents changed) versus just merging the
 * returned card's updated `config.messages`. */
export function sendLlmChatMessage(cardId: string, message: string): Promise<{ board_changed: boolean } & WorkflowCard> {
  return apiFetch(base, `/admin/workflow-cards/${cardId}/llm-chat`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export interface SurfaceConfig {
  tools: string[];
  panes: string[];
  show_3d: boolean;
  // Each label may carry a per-object form -- see AnnotationSurfaceFields.
  labels?: { name: string; color: string; fields?: { name: string; kind: "check" | "choice" | "scale"; options?: string[]; min?: number; max?: number }[] }[];
}

/** The Surface card's config connected to this Annotation/Review card,
 * or the permissive (everything enabled) default if none is connected.
 * Used by WorkflowPropertiesPanel to preview an Annotation/Review card's
 * effective restriction. */
export function getSurfaceConfig(cardId: string): Promise<SurfaceConfig> {
  return apiFetch(base, `/admin/workflow-cards/${cardId}/surface-config`);
}

// A case's real status within a job's scope -- "done" (submitted-or-
// approved for Annotation, approved for Review), "rejected" (needs
// rework, kept distinct from "pending" so it doesn't read as untouched),
// or "pending" (nothing submitted yet, or awaiting a review decision).
export type CaseStatus = "done" | "rejected" | "pending";

export interface MyJob {
  study_id: string;
  study_name: string | null;
  card_id: string;
  card_title: string;
  card_type: WorkflowCardType;
  status: string;
  cases: WorkflowCardCase[];
}

/** Every Annotation/Review card assigned to the calling user, across
 * every Study -- backs the "My Jobs" page. */
export function listMyJobs(): Promise<MyJob[]> {
  return apiFetch(base, "/admin/my-jobs");
}

export interface AllJobsEntry {
  study_id: string;
  study_name: string | null;
  card_id: string;
  card_title: string;
  card_type: WorkflowCardType;
  assigned_user_id: string | null;
  status: string;
  progress: { annotated: number; total: number };
}

/** Every Annotation/Review card on the whole platform, across every
 * Study, with who it's assigned to -- backs the admin-only "Jobs" page.
 * Global admin only. */
export function listAllJobs(): Promise<AllJobsEntry[]> {
  return apiFetch(base, "/admin/jobs");
}

export interface WorkflowCardCase {
  id: string;
  title: string | null;
  status: CaseStatus;
  // Id of the case's single most recent Annotation record regardless of
  // status, null if it has none at all. Backs the Study page's "Delete
  // annotation" action.
  latest_annotation_id?: string | null;
  // Review cards only: id of the latest Annotation record if it's still
  // awaiting a decision, null once approved/rejected or if nothing's
  // been submitted yet. Backs the Study page's per-case Approve/Reject
  // buttons.
  pending_annotation_id?: string | null;
  // The reviewer's comment on the case's latest decision (approve/reject),
  // null if there was none -- lets the annotator see *why* a case came
  // back rejected without opening the viewer.
  latest_review_comment?: string | null;
}

/** Same per-case annotated/not-annotated breakdown listMyJobs already
 * carries per card, just reachable for any Annotation/Review card the
 * caller can see (not only their own assigned ones) -- backs the
 * expandable row on the Study page's Annotations/Reviews tables. */
export function getWorkflowCardCases(cardId: string): Promise<WorkflowCardCase[]> {
  return apiFetch(base, `/admin/workflow-cards/${cardId}/cases`);
}

/** One card in a saved (or built-in) pipeline template -- `key` is a
 * local, template-scoped reference (not a real card id), same shape as
 * admin-ui's own PIPELINE_TEMPLATES so a custom template fetched from
 * the API and a built-in one insert through the exact same code. */
export interface PipelineTemplateCardDTO {
  key: string;
  type: WorkflowCardType;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  config: WorkflowCardConfig;
}

export interface PipelineTemplateEdgeDTO {
  source_key: string;
  source_handle: string;
  target_key: string;
  target_handle: string;
}

export interface PipelineTemplateDTO {
  id: string;
  title: string;
  description: string;
  cards: PipelineTemplateCardDTO[];
  edges: PipelineTemplateEdgeDTO[];
  created_by: string | null;
  created_at: string;
}

export function listPipelineTemplates(): Promise<PipelineTemplateDTO[]> {
  return apiFetch(base, "/admin/pipeline-templates");
}

export function createPipelineTemplate(input: {
  title: string;
  description: string;
  cards: PipelineTemplateCardDTO[];
  edges: PipelineTemplateEdgeDTO[];
}): Promise<PipelineTemplateDTO> {
  return apiFetch(base, "/admin/pipeline-templates", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deletePipelineTemplate(templateId: string): Promise<void> {
  return apiFetch(base, `/admin/pipeline-templates/${templateId}`, { method: "DELETE" });
}
