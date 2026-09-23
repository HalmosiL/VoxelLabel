import { API } from "../config";
import { apiFetch } from "./client";

/** A study's workflow analytics -- see admin-service's app/study_analytics. */

export type CaseState = "approved" | "awaiting_review" | "in_progress" | "sent_back" | "not_started";

export interface StudyCaseRow {
  case_id: string;
  case_title: string | null;
  state: CaseState;
  /** Times it was sent for review. */
  rounds: number;
  sent_back: number;
  /** Did the first review approve it? null before any review. */
  first_pass: boolean | null;
  entered_at: string | null;
  approved_at: string | null;
  /** Entered the workflow -> first approval. */
  lead_time_ms: number | null;
  annotate_ms: number;
  review_ms: number;
  annotators: string[];
  reviewers: string[];
  objects: number;
  /** Objects per label in the latest submission. */
  labels: Record<string, number>;
}

export interface StudyCardMetrics {
  entered: number;
  finished: number;
  open: number;
  wait_median_ms: number | null;
  work_median_ms: number | null;
  hands_on_median_ms: number | null;
  hands_on_total_ms: number;
  assignee: string | null;
  /** Annotation cards. */
  first_pass_rate?: number | null;
  sent_back?: number;
  /** Review cards. */
  approved?: number;
  rejected?: number;
}

export interface StudyLabelRow {
  label: string;
  objects: number;
  cases: number;
  reviewed: number;
  rejected: number;
  rejection_rate: number | null;
  reasons: { reason: string; count: number }[];
}

export interface StudyPersonRow {
  user_id: string;
  username: string;
  annotated_cases: number;
  submissions: number;
  first_pass_rate: number | null;
  sent_back: number;
  objects: number;
  annotate_total_ms: number;
  annotate_per_case_ms: number | null;
  annotate_per_object_ms: number | null;
  reviews: number;
  approved: number;
  rejected: number;
  review_total_ms: number;
  review_per_case_ms: number | null;
  review_turnaround_ms: number | null;
  open_now: number;
}

export interface StudyAnalytics {
  generated_at: string;
  headline: {
    cases: number;
    states: Record<CaseState, number>;
    lead_time_median_ms: number | null;
    first_pass_rate: number | null;
    rounds_median: number | null;
    objects: number;
    hands_on_total_ms: number;
    annotate_per_case_median_ms: number | null;
    review_per_case_median_ms: number | null;
  };
  cards: Record<string, StudyCardMetrics>;
  cases: StudyCaseRow[];
  labels: StudyLabelRow[];
  people: StudyPersonRow[];
  weekly: { week: string; submitted: number; approved: number; rejected: number }[];
}

export function getStudyAnalytics(studyId: string): Promise<StudyAnalytics> {
  return apiFetch(API.admin, `/admin/studies/${studyId}/analytics`);
}
