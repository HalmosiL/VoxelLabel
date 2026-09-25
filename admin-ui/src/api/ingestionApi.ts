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

export interface QuickImportResultCase {
  case_id: string;
  title: string;
  created: boolean;
  instance_count: number;
}

export interface QuickImportError {
  file: string;
  error: string;
}

export type QuickImportStatus =
  | { status: "pending" | "started" | "retry" }
  | { status: "progress"; current: number; total: number; filename: string }
  | { status: "failed"; error: string }
  | {
      status: "completed";
      cases: QuickImportResultCase[];
      instances_ingested: number;
      errors: QuickImportError[];
      // files skipped because they are already imported -- and where (B-17)
      already_imported?: { file: string; where: DuplicateWhere }[];
    };

/** Where an instance that is already imported lives: a DICOM instance
 * belongs to one study only. */
export type DuplicateWhere = "this_case" | "this_study" | "another_study";

/** Uploads a whole batch of loose DICOM files (any mix of patients/
 * studies) in one request -- the server groups them by (PatientID,
 * StudyInstanceUID) and creates/matches a Case for each group itself,
 * no manual case-creation step needed (see
 * services/ingestion-service/app/quick_import.py). Returns immediately
 * with an id to poll via getQuickImport.
 *
 * Uses XMLHttpRequest, not fetch, specifically for `upload.onprogress`
 * -- fetch has no equivalent event for tracking bytes actually sent, so
 * there'd be no way to show real upload progress for what can be a
 * multi-hundred-megabyte request otherwise. */
export function quickImport(
  studyId: string,
  files: File[],
  onUploadProgress?: (sentBytes: number, totalBytes: number) => void
): Promise<{ import_id: string; status: string; file_count: number }> {
  const formData = new FormData();
  for (const file of files) formData.append("files", file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API.ingestion}/ingestion/studies/${studyId}/quick-import`);
    xhr.setRequestHeader("Authorization", `Bearer ${keycloak.token}`);
    if (onUploadProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onUploadProgress(event.loaded, event.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new ApiError(xhr.status, xhr.responseText));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(formData);
  });
}

export function getQuickImport(importId: string): Promise<QuickImportStatus> {
  return apiFetch(API.ingestion, `/ingestion/quick-imports/${importId}`);
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

export type IngestionJobStatus =
  | { status: "completed"; instance_id?: string; job_id?: string }
  | { status: "duplicate"; where?: DuplicateWhere; instance_id?: string; job_id?: string }
  | { status: "failed"; error: string }
  | { status: string };

/** Polls one single-file DICOM upload (see uploadDicom) -- the worker
 * processes it asynchronously, and this is how the page learns whether
 * it landed, was a duplicate, or failed. */
export function getIngestionJob(jobId: string): Promise<IngestionJobStatus> {
  return apiFetch(API.ingestion, `/ingestion/jobs/${jobId}`);
}

/** The line shown for a file that is already imported (B-17, B-21). */
export function alreadyImportedMessage(fileName: string, where: DuplicateWhere | undefined): string {
  if (where === "another_study") return `${fileName} is already in another study, so it wasn't added -- a DICOM image can belong to one study only.`;
  if (where === "this_study") return `${fileName} is already in another case of this study (skipped).`;
  return `${fileName} was already in this case (skipped).`;
}
