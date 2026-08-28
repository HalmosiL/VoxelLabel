import keycloak from "../keycloak";
import { API } from "../config";
import { apiFetch, ApiError } from "./client";

export interface PytorchExportSeries {
  series_id: string;
  modality: string | null;
  body_part: string | null;
  image_url: string;
  shape: number[];
  spacing: number[];
}

export interface PytorchExportAnnotation {
  target_type: string;
  target_id: string;
  type_name: string | null;
  type_schema: Record<string, unknown> | null;
  status: string;
  payload: Record<string, unknown>;
  asset_urls: Record<string, string>;
}

export interface PytorchExportCase {
  case_id: string;
  tags: string[];
  series: PytorchExportSeries[];
  annotations: PytorchExportAnnotation[];
}

export interface PytorchExportManifest {
  export_id: string;
  created_at: string;
  case_count: number;
  cases: PytorchExportCase[];
}

export type PytorchExportStatus =
  | { status: "pending" | "started" | "retry" }
  | { status: "failed"; error: string }
  | { status: "completed"; manifest: PytorchExportManifest };

/** Kicks off an async PyTorch-ready export of the given cases (see
 * services/ingestion-service/app/pytorch_export.py) -- returns
 * immediately with an id to poll via getPytorchExport. */
export function createPytorchExport(studyId: string, caseIds: string[]): Promise<{ export_id: string; status: string }> {
  return apiFetch(API.ingestion, "/ingestion/exports", {
    method: "POST",
    body: JSON.stringify({ study_id: studyId, case_ids: caseIds }),
  });
}

export function getPytorchExport(exportId: string): Promise<PytorchExportStatus> {
  return apiFetch(API.ingestion, `/ingestion/exports/${exportId}`);
}

export async function uploadDicom(caseId: string, file: File): Promise<{ job_id: string; status: string }> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${API.ingestion}/ingestion/cases/${caseId}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keycloak.token}` },
    body: formData,
  });

  if (!response.ok) {
    throw new ApiError(response.status, await response.text());
  }
  return response.json();
}
