import { API } from "../config";
import { apiFetch } from "./client";

const base = API.annotation;

/** Records a reviewer's approve/reject decision on a specific Annotation
 * record -- backs the Study page's per-case Approve/Reject buttons
 * (Reviews table), so a decision can be made without opening
 * ct-annotator. Called directly from the browser (annotation-service's
 * CORS already allows admin-ui's origin, same as every other service
 * admin-ui talks to), not proxied through admin-service. */
export function reviewAnnotation(annotationId: string, decision: "approve" | "reject"): Promise<{ id: string; status: string }> {
  const qs = new URLSearchParams({ decision });
  return apiFetch(base, `/annotations/${annotationId}/review?${qs}`, { method: "POST" });
}
