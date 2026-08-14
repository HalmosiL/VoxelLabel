import { API } from "../config";
import { apiFetch } from "./client";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  deidentification_profile_id: string | null;
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
