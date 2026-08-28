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

/** Kicks off an async PyTorch-ready export of a dataset (see
 * services/ingestion-service/app/pytorch_export.py) -- returns
 * immediately with an id to poll via getPytorchExport. Pass `cardId` to
 * name a Dataset card directly (the case list is resolved server-side,
 * from whatever that card's Manual pick/All cases mode currently holds
 * in the database -- the source of truth, not whatever the client last
 * happened to render); pass `caseIds` only when the caller already has
 * an explicit list with no corresponding card. */
export function createPytorchExport(
  studyId: string,
  target: { cardId: string } | { caseIds: string[] }
): Promise<{ export_id: string; status: string }> {
  return apiFetch(API.ingestion, "/ingestion/exports", {
    method: "POST",
    body: JSON.stringify({
      study_id: studyId,
      card_id: "cardId" in target ? target.cardId : undefined,
      case_ids: "caseIds" in target ? target.caseIds : undefined,
    }),
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
