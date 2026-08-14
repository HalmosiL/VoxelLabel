import { API } from "../config";
import { apiFetch } from "./client";

export interface Annotation {
  id: string;
  target_type: string;
  target_id: string;
  type_id: string;
  payload: Record<string, unknown>;
  status: "draft" | "submitted" | "approved" | "rejected";
  annotator_id: string;
}

const base = API.annotation;

export function listAnnotationsForProject(projectId: string, status?: string): Promise<Annotation[]> {
  const qs = status ? `?${new URLSearchParams({ status })}` : "";
  return apiFetch(base, `/annotations/projects/${projectId}${qs}`);
}

export function reviewAnnotation(
  annotationId: string,
  decision: "approve" | "reject",
  comment: string
): Promise<{ id: string; status: string }> {
  const qs = new URLSearchParams({ decision, ...(comment ? { comment } : {}) });
  return apiFetch(base, `/annotations/${annotationId}/review?${qs}`, { method: "POST" });
}
