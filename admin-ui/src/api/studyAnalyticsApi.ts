import { API } from "../config";
import { apiFetch } from "./client";

/** A study's workflow analytics -- see admin-service's app/study_analytics. */

/** done: nothing left after its last step (approved by the last review, or
 * submitted in an annotation-only workflow). awaiting_next: passed a step,
 * the next one (another annotation step) hasn't picked it up yet. */
export type CaseState = "sent_back" | "awaiting_review" | "awaiting_next" | "in_progress" | "not_started" | "done";

/** One step a case went through: a submission or a review decision, at a job card. */
export interface CaseStep {
  card_id: string | null;
  step: string | null;
  kind: "submitted" | "approved" | "rejected";
  at: string;
  by: string;
}

export interface StudyCaseRow {
  case_id: string;
  case_title: string | null;
  state: CaseState;
  /** The job card it is waiting at (id and title), when not done. */
  waiting_at: string | null;
  waiting_at_title: string | null;
  path: CaseStep[];
  /** Times it was sent for review. */
  rounds: number;
  reviews: number;
  sent_back: number;
  /** Got through every review without a rejection; null before any review. */
  first_pass: boolean | null;
  entered_at: string | null;
  done_at: string | null;
  /** Entered the workflow -> finished. */
  lead_time_ms: number | null;
  annotate_ms: number;
  review_ms: number;
  annotators: string[];
  reviewers: string[];
  /** Images in its largest series. */
  slices: number | null;
  /** Objects in the first submission, and in the final version. */
  objects_first: number | null;
  objects: number;
  /** Objects per label in the final version. */
  labels: Record<string, number>;
  rejected_objects: { review: number; label: string; instance: number | null; reason: string | null; comment: string | null }[];
  review_comments: { by: string; at: string; text: string }[];
}

export interface StudyCardMetrics {
  entered: number;
  /** Cases this step has submitted (annotation) or decided on (review). */
  finished: number;
  /** Cases waiting at this step right now. */
  open: number;
  wait_median_ms: number | null;
  work_median_ms: number | null;
  hands_on_median_ms: number | null;
  hands_on_total_ms: number;
  assignee: string | null;
  /** Annotation: share approved at the next review first time; review: share it approved at its first look. */
  first_pass_rate: number | null;
  /** Annotation cards. */
  submissions?: number;
  sent_back?: number;
  /** Review cards. */
  approved?: number;
  rejected?: number;
}

export interface StudyLabelRow {
  label: string;
  objects_first: number;
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
    problem_cases: number;
    objects: number;
    slices: number;
    steps: number;
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
