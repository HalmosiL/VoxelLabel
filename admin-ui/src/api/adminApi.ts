import { API } from "../config";
import { apiFetch } from "./client";

export interface Study {
  id: string;
  name: string;
  description: string | null;
  deidentification_profile_id: string | null;
  cover_image_url: string | null;
}

export interface StudyMember {
  user_id: string;
  role: string;
}

export interface DeidentificationRule {
  id: string;
  dicom_tag: string;
  action: "keep" | "remove" | "replace_fixed" | "hash";
  replacement_value: string | null;
}

export interface DeidentificationProfile {
  id: string;
  name: string;
  is_default: boolean;
  rules: DeidentificationRule[];
}

export interface KeycloakUser {
  id: string;
  username: string | null;
  email: string | null;
}

export interface AnnotationType {
  id: string;
  name: string;
  json_schema: Record<string, unknown>;
}

const base = API.admin;

export function listStudies(): Promise<Study[]> {
  return apiFetch(base, "/admin/studies");
}

export function createStudy(name: string, description: string): Promise<{ id: string; name: string }> {
  const qs = new URLSearchParams({ name, ...(description ? { description } : {}) });
  return apiFetch(base, `/admin/studies?${qs}`, { method: "POST" });
}

export function updateStudy(
  studyId: string,
  name: string,
  description: string
): Promise<{ id: string; name: string; description: string | null }> {
  const qs = new URLSearchParams({ name, ...(description ? { description } : {}) });
  return apiFetch(base, `/admin/studies/${studyId}?${qs}`, { method: "PATCH" });
}

export function deleteStudy(studyId: string): Promise<void> {
  return apiFetch(base, `/admin/studies/${studyId}`, { method: "DELETE" });
}

export function uploadStudyCoverImage(studyId: string, file: File): Promise<{ id: string; cover_image_url: string }> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch(base, `/admin/studies/${studyId}/cover-image`, { method: "POST", body: formData });
}

export function listStudyMembers(studyId: string): Promise<StudyMember[]> {
  return apiFetch(base, `/admin/studies/${studyId}/members`);
}

export function addStudyMember(studyId: string, userId: string, role: string): Promise<StudyMember> {
  const qs = new URLSearchParams({ user_id: userId, role });
  return apiFetch(base, `/admin/studies/${studyId}/members?${qs}`, { method: "POST" });
}

export function listDeidentificationProfiles(): Promise<DeidentificationProfile[]> {
  return apiFetch(base, "/admin/deidentification-profiles");
}

export function createDeidentificationProfile(name: string, isDefault: boolean): Promise<{ id: string; name: string }> {
  const qs = new URLSearchParams({ name, is_default: String(isDefault) });
  return apiFetch(base, `/admin/deidentification-profiles?${qs}`, { method: "POST" });
}

export function addDeidentificationRule(
  profileId: string,
  dicomTag: string,
  action: string,
  replacementValue: string
): Promise<DeidentificationRule> {
  const qs = new URLSearchParams({
    dicom_tag: dicomTag,
    action,
    ...(replacementValue ? { replacement_value: replacementValue } : {}),
  });
  return apiFetch(base, `/admin/deidentification-profiles/${profileId}/rules?${qs}`, { method: "POST" });
}

export interface CaseFormFields {
  accessionNumber?: string;
  date?: string;
  type?: string;
  title?: string;
  comment?: string;
}

export function createCase(
  studyId: string,
  externalPatientId: string,
  fields: CaseFormFields
): Promise<{ id: string; patient_id: string; accession_number: string | null }> {
  const qs = new URLSearchParams({
    external_patient_id: externalPatientId,
    ...(fields.accessionNumber ? { accession_number: fields.accessionNumber } : {}),
    ...(fields.date ? { case_date: fields.date } : {}),
    ...(fields.type ? { type: fields.type } : {}),
    ...(fields.title ? { title: fields.title } : {}),
    ...(fields.comment ? { comment: fields.comment } : {}),
  });
  return apiFetch(base, `/admin/studies/${studyId}/cases?${qs}`, { method: "POST" });
}

export function updateCase(caseId: string, fields: CaseFormFields): Promise<void> {
  const qs = new URLSearchParams({
    ...(fields.accessionNumber !== undefined ? { accession_number: fields.accessionNumber } : {}),
    ...(fields.date !== undefined ? { case_date: fields.date } : {}),
    ...(fields.type !== undefined ? { type: fields.type } : {}),
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.comment !== undefined ? { comment: fields.comment } : {}),
  });
  return apiFetch(base, `/admin/cases/${caseId}?${qs}`, { method: "PATCH" });
}

export function createClinicalDataItem(
  caseId: string,
  type: string,
  title: string,
  itemDate: string,
  file: File | null
): Promise<{ id: string; title: string }> {
  const qs = new URLSearchParams({ type, title, ...(itemDate ? { item_date: itemDate } : {}) });
  const formData = new FormData();
  if (file) formData.append("file", file);
  return apiFetch(base, `/admin/cases/${caseId}/clinical-data-items?${qs}`, {
    method: "POST",
    body: formData,
  });
}

export interface DocumentFormFields {
  type?: string;
  title?: string;
  itemDate?: string;
}

export function updateClinicalDataItem(
  itemId: string,
  fields: DocumentFormFields
): Promise<{ id: string; type: string; title: string; date: string | null }> {
  const qs = new URLSearchParams({
    ...(fields.type ? { type: fields.type } : {}),
    ...(fields.title ? { title: fields.title } : {}),
    ...(fields.itemDate !== undefined ? { item_date: fields.itemDate } : {}),
  });
  return apiFetch(base, `/admin/clinical-data-items/${itemId}?${qs}`, { method: "PATCH" });
}

export function deleteClinicalDataItem(itemId: string): Promise<void> {
  return apiFetch(base, `/admin/clinical-data-items/${itemId}`, { method: "DELETE" });
}

export interface ImagingStudyFormFields {
  description?: string;
  modality?: string;
}

export function updateImagingStudy(
  imagingStudyId: string,
  fields: ImagingStudyFormFields
): Promise<{ id: string; description: string | null; modality: string | null }> {
  const qs = new URLSearchParams({
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.modality !== undefined ? { modality: fields.modality } : {}),
  });
  return apiFetch(base, `/admin/imaging-studies/${imagingStudyId}?${qs}`, { method: "PATCH" });
}

export function deleteImagingStudy(imagingStudyId: string): Promise<void> {
  return apiFetch(base, `/admin/imaging-studies/${imagingStudyId}`, { method: "DELETE" });
}

export interface SeriesFormFields {
  seriesDescription?: string;
  bodyPart?: string;
}

export function updateSeries(
  seriesId: string,
  fields: SeriesFormFields
): Promise<{ id: string; series_description: string | null; body_part: string | null }> {
  const qs = new URLSearchParams({
    ...(fields.seriesDescription !== undefined ? { series_description: fields.seriesDescription } : {}),
    ...(fields.bodyPart !== undefined ? { body_part: fields.bodyPart } : {}),
  });
  return apiFetch(base, `/admin/series/${seriesId}?${qs}`, { method: "PATCH" });
}

export function deleteSeries(seriesId: string): Promise<void> {
  return apiFetch(base, `/admin/series/${seriesId}`, { method: "DELETE" });
}

export function addClinicalDataTag(itemId: string, label: string): Promise<{ id: string; label: string }> {
  const qs = new URLSearchParams({ label });
  return apiFetch(base, `/admin/clinical-data-items/${itemId}/tags?${qs}`, { method: "POST" });
}

export function addClinicalDataConsent(
  itemId: string,
  consentType: string,
  status: "granted" | "revoked"
): Promise<{ id: string; consent_type: string; status: string }> {
  const qs = new URLSearchParams({ consent_type: consentType, status });
  return apiFetch(base, `/admin/clinical-data-items/${itemId}/consents?${qs}`, { method: "POST" });
}

export function listKeycloakUsers(): Promise<KeycloakUser[]> {
  return apiFetch(base, "/admin/keycloak-users");
}

export function listAnnotationTypes(): Promise<AnnotationType[]> {
  return apiFetch(base, "/admin/annotation-types");
}

export function createAnnotationType(name: string, jsonSchema: Record<string, unknown>): Promise<{ id: string; name: string }> {
  const qs = new URLSearchParams({ name });
  return apiFetch(base, `/admin/annotation-types?${qs}`, {
    method: "POST",
    body: JSON.stringify(jsonSchema),
  });
}
