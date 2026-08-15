import { API } from "../config";
import { apiFetch } from "./client";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  deidentification_profile_id: string | null;
  cover_image_url: string | null;
}

export interface ProjectMember {
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

export function listProjects(): Promise<Project[]> {
  return apiFetch(base, "/admin/projects");
}

export function createProject(name: string, description: string): Promise<{ id: string; name: string }> {
  const qs = new URLSearchParams({ name, ...(description ? { description } : {}) });
  return apiFetch(base, `/admin/projects?${qs}`, { method: "POST" });
}

export function updateProject(
  projectId: string,
  name: string,
  description: string
): Promise<{ id: string; name: string; description: string | null }> {
  const qs = new URLSearchParams({ name, ...(description ? { description } : {}) });
  return apiFetch(base, `/admin/projects/${projectId}?${qs}`, { method: "PATCH" });
}

export function deleteProject(projectId: string): Promise<void> {
  return apiFetch(base, `/admin/projects/${projectId}`, { method: "DELETE" });
}

export function uploadProjectCoverImage(projectId: string, file: File): Promise<{ id: string; cover_image_url: string }> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch(base, `/admin/projects/${projectId}/cover-image`, { method: "POST", body: formData });
}

export function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  return apiFetch(base, `/admin/projects/${projectId}/members`);
}

export function addProjectMember(projectId: string, userId: string, role: string): Promise<ProjectMember> {
  const qs = new URLSearchParams({ user_id: userId, role });
  return apiFetch(base, `/admin/projects/${projectId}/members?${qs}`, { method: "POST" });
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
  projectId: string,
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
  return apiFetch(base, `/admin/projects/${projectId}/cases?${qs}`, { method: "POST" });
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
