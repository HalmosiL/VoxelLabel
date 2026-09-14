import { API } from "../config";
import { ApiError, apiFetch } from "./client";
import keycloak from "../keycloak";

/** Read-only reuse of the main platform's admin-service/data-service --
 * just enough to let the user pick Study -> Case -> ImagingStudy ->
 * Series -> Instance. Nothing here writes to either service.
 *
 * Routed through this repo's own backend (not called directly from the
 * browser) because admin-service/data-service's CORS allowlists are
 * locked to admin-ui's origin -- proxying avoids touching that config in
 * the main platform's repo at all. */

export interface Study {
  id: string;
  name: string;
  description: string | null;
}

export interface CaseSummary {
  id: string;
  study_id: string;
  title: string | null;
  accession_number: string | null;
}

export interface ImagingStudySummary {
  id: string;
  study_instance_uid: string;
  description: string | null;
  thumbnail_url: string | null;
}

export interface SeriesSummary {
  id: string;
  series_instance_uid: string;
  series_description: string | null;
  thumbnail_url: string | null;
}

export interface InstanceSummary {
  id: string;
  sop_instance_uid: string;
  instance_number: number | null;
  thumbnail_url: string | null;
}

export interface CaseDocument {
  id: string;
  date: string | null;
  type: string;
  title: string;
  has_file: boolean;
}

export function listStudies(): Promise<Study[]> {
  return apiFetch(API.annotator, "/studies");
}

export function listCases(studyId: string): Promise<CaseSummary[]> {
  return apiFetch(API.annotator, `/studies/${studyId}/cases`);
}

export function listImagingStudies(caseId: string): Promise<ImagingStudySummary[]> {
  return apiFetch(API.annotator, `/cases/${caseId}/imaging-studies`);
}

export function listSeries(imagingStudyId: string): Promise<SeriesSummary[]> {
  return apiFetch(API.annotator, `/imaging-studies/${imagingStudyId}/series`);
}

export function listInstances(seriesId: string): Promise<InstanceSummary[]> {
  return apiFetch(API.annotator, `/series/${seriesId}/instances`);
}

/** The case's clinical documents (reports, notes, etc.) -- same data
 * admin-ui's own Documents section lists, so an annotator can check
 * them from the viewer's Documents tab without switching apps. */
export function listCaseDocuments(caseId: string): Promise<CaseDocument[]> {
  return apiFetch(API.annotator, `/cases/${caseId}/documents`);
}

/** A presigned, one-time URL for a single document's file -- for
 * opening it in a new browser tab. */
export function getDocumentFileUrl(itemId: string): Promise<{ url: string }> {
  return apiFetch(API.annotator, `/documents/${itemId}/file-url`);
}

/** The document's file itself, for the in-page preview (see
 * components/DocumentPanel.tsx): the bytes plus the content type the
 * backend served them with, which decides how they're shown. */
export async function getDocumentFile(itemId: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const response = await fetch(`${API.annotator}/documents/${itemId}/file`, {
    headers: { Authorization: `Bearer ${keycloak.token}` },
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  return { bytes: await response.arrayBuffer(), contentType: response.headers.get("content-type") ?? "" };
}
