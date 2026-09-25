import keycloak from "../keycloak";
import { API } from "../config";
import { apiFetch, ApiError } from "./client";

export interface Study {
  id: string;
  name: string;
  description: string | null;
  deidentification_profile_id: string | null;
  cover_image_url: string | null;
  // The caller's own role in this study ("admin" for a global admin),
  // null when they hold none -- what admin-ui gates edit actions on.
  my_role?: string | null;
}

export interface StudyMember {
  user_id: string;
  role: string;
  // Resolved from Keycloak server-side (null if the directory lookup
  // failed) -- the members list is readable by every member, so names
  // no longer depend on the admin-only user directory.
  username?: string | null;
  email?: string | null;
}

export interface DeidentificationRule {
  id: string;
  dicom_tag: string;
  action: "keep" | "remove" | "replace_fixed" | "hash";
  replacement_value: string | null;
  // Why a rule saved before the checks existed can't be applied (it fails every import), or null.
  problem: string | null;
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
  is_admin: boolean;
  first_name?: string | null;
  last_name?: string | null;
  enabled?: boolean;
  email_verified?: boolean;
  required_actions?: string[];
  created_at?: string | null;
  memberships?: { study_id: string; study_name: string | null; role: string }[];
}

export interface CreateUserInput {
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  password: string;
  is_admin: boolean;
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

export function getStudy(studyId: string): Promise<Study> {
  return apiFetch(base, `/admin/studies/${studyId}`);
}

export function createStudy(name: string, description: string): Promise<{ id: string; name: string }> {
  const qs = new URLSearchParams({ name, ...(description ? { description } : {}) });
  return apiFetch(base, `/admin/studies?${qs}`, { method: "POST" });
}

/** Registers a patient from a real-world identifier (e.g. an MRN) with
 * no case yet -- for pre-registering someone before their first study/
 * case exists. The same identifier used later at case-creation time
 * resolves back to this same pseudonymized patient, not a duplicate. */
export function createPatient(externalPatientId: string): Promise<{ id: string; pseudonym_id: string }> {
  const qs = new URLSearchParams({ external_patient_id: externalPatientId });
  return apiFetch(base, `/admin/patients?${qs}`, { method: "POST" });
}

/** `deidentificationProfileId`: leave out to keep it, null to clear it
 * (the platform default profile applies), an id to assign one. */
export function updateStudy(
  studyId: string,
  name: string,
  description: string,
  deidentificationProfileId?: string | null
): Promise<{ id: string; name: string; description: string | null; deidentification_profile_id: string | null }> {
  const qs = new URLSearchParams({ name, ...(description ? { description } : {}) });
  if (deidentificationProfileId !== undefined) qs.set("deidentification_profile_id", deidentificationProfileId ?? "");
  return apiFetch(base, `/admin/studies/${studyId}?${qs}`, { method: "PATCH" });
}

/** Refused with a 409 (case count in the message) if the study still
 * has cases, unless `force` -- which cascades the exact same delete
 * each case's own "Delete case" action does (imaging data, clinical
 * documents, everything) across all of them, then the study itself. */
export function deleteStudy(studyId: string, force = false): Promise<void> {
  return apiFetch(base, `/admin/studies/${studyId}${force ? "?force=true" : ""}`, { method: "DELETE" });
}

/** Creates a fully independent copy of a study: new case/imaging/document
 * rows with fresh DICOM UIDs, and a real byte-for-byte copy of every file
 * under new storage keys -- behaves exactly as if it had all been freshly
 * re-uploaded, not a reference to the source's data. With `includeWorkflow`
 * (default true), the workflow board comes along too (cards/edges/config,
 * case ids remapped, Run results reset); with it false, only the raw
 * case/imaging/document data is duplicated and the copy starts with a
 * blank board. Never copies annotations or version history. */
export function duplicateStudy(studyId: string, name?: string, includeWorkflow = true): Promise<Study> {
  return apiFetch(base, `/admin/studies/${studyId}/duplicate`, {
    method: "POST",
    body: JSON.stringify({ name: name || null, include_workflow: includeWorkflow }),
  });
}

export function uploadStudyCoverImage(studyId: string, file: File): Promise<{ id: string; cover_image_url: string }> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch(base, `/admin/studies/${studyId}/cover-image`, { method: "POST", body: formData });
}

export interface MeMembership {
  study_id: string;
  study_name: string | null;
  role: string;
}

export interface Me {
  subject: string;
  email: string | null;
  is_admin: boolean;
  realm_roles: string[];
  memberships: MeMembership[];
}

/** Who am I -- global admin flag + every study membership with its role.
 * The access token carries no study-scoped roles, so this is what the
 * UI gates its buttons/nav on (the backend stays the real control). */
export function getMe(): Promise<Me> {
  return apiFetch(base, "/admin/me");
}

/** A member's display name: username, else email, else a shortened id. */
export function memberLabel(member: { username?: string | null; email?: string | null; user_id: string }): string {
  return member.username ?? member.email ?? `${member.user_id.slice(0, 8)}…`;
}

/** Revokes one specific role from a member -- their other roles in this
 * study, if any, are untouched (a member can hold several at once, e.g.
 * both annotator and reviewer). */
export function removeStudyMember(studyId: string, userId: string, role: string): Promise<void> {
  const qs = new URLSearchParams({ role });
  return apiFetch(base, `/admin/studies/${studyId}/members/${userId}?${qs}`, { method: "DELETE" });
}

export function listStudyMembers(studyId: string): Promise<StudyMember[]> {
  return apiFetch(base, `/admin/studies/${studyId}/members`);
}

/** Grants `role` to `userId` in this study -- additive, not a replace:
 * call again with a different role to grant another one without taking
 * away any role they already hold. Idempotent (granting a role they
 * already have is a no-op). */
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

export function deleteDeidentificationProfile(profileId: string): Promise<void> {
  return apiFetch(base, `/admin/deidentification-profiles/${profileId}`, { method: "DELETE" });
}

export function deleteDeidentificationRule(profileId: string, ruleId: string): Promise<void> {
  return apiFetch(base, `/admin/deidentification-profiles/${profileId}/rules/${ruleId}`, { method: "DELETE" });
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

export type PatientRef = { externalPatientId: string } | { patientId: string };

export function createCase(
  studyId: string,
  patientRef: PatientRef,
  fields: CaseFormFields
): Promise<{ id: string; patient_id: string; accession_number: string | null }> {
  const qs = new URLSearchParams({
    ...("externalPatientId" in patientRef
      ? { external_patient_id: patientRef.externalPatientId }
      : { patient_id: patientRef.patientId }),
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

/** Deletes a case and everything under it (imaging studies, series,
 * instances, clinical data items) -- irreversible, so callers should
 * confirm with the user first. */
export function deleteCase(caseId: string): Promise<void> {
  return apiFetch(base, `/admin/cases/${caseId}`, { method: "DELETE" });
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

/** Deletes a patient who has no cases, with their identity hash (B-23). */
export function deletePatient(patientId: string): Promise<void> {
  return apiFetch(base, `/admin/patients/${patientId}`, { method: "DELETE" });
}

export function removeClinicalDataTag(itemId: string, label: string): Promise<void> {
  const qs = new URLSearchParams({ label });
  return apiFetch(base, `/admin/clinical-data-items/${itemId}/tags?${qs}`, { method: "DELETE" });
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

/** Creates a real Keycloak account (global admin only) -- the password is
 * marked temporary server-side, so the new user sets their own at first
 * login. Sent as a JSON body rather than this file's usual query-string
 * convention, since a password doesn't belong in a URL. */
export function createKeycloakUser(input: CreateUserInput): Promise<KeycloakUser> {
  return apiFetch(base, "/admin/users", { method: "POST", body: JSON.stringify(input) });
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

// ---------------------------------------------------------------- users

export interface UpdateUserInput {
  first_name?: string;
  last_name?: string;
  email?: string;
  enabled?: boolean;
  is_admin?: boolean;
}

export function getKeycloakUser(userId: string): Promise<KeycloakUser> {
  return apiFetch(base, `/admin/users/${userId}`);
}

export function updateKeycloakUser(userId: string, input: UpdateUserInput): Promise<KeycloakUser> {
  return apiFetch(base, `/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function resetKeycloakPassword(userId: string, password: string, temporary: boolean): Promise<void> {
  return apiFetch(base, `/admin/users/${userId}/reset-password`, {
    method: "POST",
    body: JSON.stringify({ password, temporary }),
  });
}

export function deleteKeycloakUser(userId: string): Promise<void> {
  return apiFetch(base, `/admin/users/${userId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------- audit log

export interface AuditEntry {
  id: string;
  created_at: string | null;
  actor_id: string;
  /** Username when Keycloak could resolve it, else the bare subject id. */
  actor: string;
  /** "<entity>.<verb>", e.g. "study.update", "member.add", "card.run". */
  action: string;
  entity_type: string;
  entity_id: string;
  diff: Record<string, unknown> | null;
}

/** Newest first; global admin only. See admin-service's api/audit.py. */
export function listAuditLog(limit = 100): Promise<{ entries: AuditEntry[] }> {
  return apiFetch(base, `/admin/audit-log?limit=${limit}`);
}

// ---------------------------------------------------------------- usage tracking
// See admin-service's app/usage package. Every read and the switches
// are global-admin only; the tracker itself (src/usage/tracker.ts)
// talks to /config and /events directly.

export interface UsageSettings {
  enabled: boolean;
  track_pages: boolean;
  track_actions: boolean;
  track_clicks: boolean;
  track_mouse: boolean;
  track_scroll: boolean;
  track_keys: boolean;
  track_errors: boolean;
  track_perf: boolean;
  /** Screen snapshots carry the case images (small inline pictures) instead of grey blocks. */
  track_screen_images: boolean;
  mouse_sample_ms: number;
  retention_days: number;
  /** Viewer asks "how demanding was that case?" after every n-th finished case; 0 = never. */
  rating_every_n: number;
  disabled_user_ids: string[];
  /** Recorded, but left out of every figure (test/demo accounts). */
  excluded_user_ids: string[];
  /** Leave every account with the global admin role out of the figures. */
  exclude_admins: boolean;
  updated_at: string | null;
}

export type UsageSettingsPatch = Partial<Omit<UsageSettings, "disabled_user_ids" | "excluded_user_ids" | "updated_at">>;

/** One account with its two switches, for the Settings tab. */
export interface UsagePerson {
  user_id: string;
  username: string;
  email: string | null;
  is_admin: boolean;
  /** Recording is on for them (master switch on, not switched off). */
  recorded: boolean;
  /** Their events count in the figures (their own switch, and not an admin while admins are left out). */
  counted: boolean;
  /** Their own "count in analysis" switch, whatever the admin rule says. */
  counted_switch: boolean;
}

/** The headline measures for one build of one app (see stats.releases). */
export interface UsageRelease {
  app: "admin-ui" | "viewer";
  version: string;
  first_seen: string;
  last_seen: string;
  people: number;
  sessions: number;
  cases: number;
  active_median_ms: number | null;
  first_input_median_ms: number | null;
  no_response_rate: number | null;
  friction_score: number | null;
  errors: number;
}

/** One case worked in the viewer, with what made it hard. */
export interface UsageCaseRow {
  case_id: string;
  case_title: string | null;
  job_id: string;
  job_type: "annotation" | "review" | null;
  people: string[];
  sittings: number;
  active_ms: number;
  slices: number | null;
  objects: number | null;
  per_object_ms: number | null;
  undos: number;
  first_input_ms: number | null;
  rating: number | null;
  sent_back: number;
}

export interface UsageDriver {
  factor: "objects" | "slices" | "rating" | "sent_back" | "undos";
  label: string;
  r: number;
  n: number;
}

export interface UsagePerfRow {
  app: "admin-ui" | "viewer";
  endpoint: string;
  calls: number;
  total_ms: number;
  mean_ms: number;
  max_ms: number;
  slow: number;
  slow_share: number;
  failures: number;
  failure_rate: number;
}

export interface UsageTour {
  app: "admin-ui" | "viewer";
  route: string;
  opened: number;
  finished: number;
  skipped: number;
  finish_rate: number | null;
  /** 0-based step where people typically left. */
  skipped_at_median: number | null;
}

/** What one case costs in the viewer, medians over the cases worked in the window. */
export interface UsageEffort {
  cases: number;
  active_median_ms: number | null;
  sittings_median: number | null;
  undos_per_case: number | null;
  first_input_median_ms: number | null;
  first_input_count: number;
}

export interface UsageRouteStat {
  route: string;
  views: number;
  total_ms: number;
  avg_ms: number;
}

export interface UsageTransition {
  from: string;
  to: string;
  count: number;
  sessions: number;
}

export interface UsageTask {
  count: number;
  median_ms: number | null;
  mean_ms: number | null;
}

export interface UsageFrictionRow {
  route: string;
  rate?: number | null;
  bounces?: number;
  returns?: number;
  bursts?: number;
  clicks?: number;
  errors?: number;
}

export interface UsageUser {
  user_id: string;
  username: string;
  email: string | null;
  sessions: number;
  total_ms: number;
  page_views: number;
  pages_per_session: number;
  avg_dwell_ms: number;
  back_and_forth: number;
  clicks: number;
  clicks_per_min: number;
  mouse_px_per_page: number;
  /** Median active time in the viewer per case they worked on; null if none. */
  active_per_case_ms: number | null;
  cases_worked: number;
  annotated: number;
  reviewed: number;
  errors: number;
  last_seen_at: string | null;
}

/** Either the quick "last N days" preset, or an explicit calendar
 * window (datetime-local values, no timezone suffix -- the backend
 * treats a naive datetime as UTC, same as every browser clock in this
 * platform's own deployment). `to` omitted means "until now". */
export type UsageRange = { days: number } | { from: string; to?: string };

/** The immediately preceding period of the same length -- what a
 * "vs. last period" comparison on the Usage page diffs against. A
 * 30-day range compares against the 30 days before that; a custom
 * from/to compares against the same-length window right before `from`
 * ("to" missing means "until now", so the duration is measured to now). */
export function previousRange(range: UsageRange): UsageRange {
  if ("days" in range) {
    const to = new Date(Date.now() - range.days * 86_400_000);
    const from = new Date(to.getTime() - range.days * 86_400_000);
    return { from: from.toISOString(), to: to.toISOString() };
  }
  const from = new Date(range.from);
  const to = range.to ? new Date(range.to) : new Date();
  const durationMs = Math.max(to.getTime() - from.getTime(), 0);
  const prevTo = from;
  const prevFrom = new Date(from.getTime() - durationMs);
  return { from: prevFrom.toISOString(), to: prevTo.toISOString() };
}

/** The calendar hands over `datetime-local` values -- the viewer's own
 * wall-clock time, no offset. Sent as-is the server would read them as
 * UTC (two hours off in Budapest in summer), so they go out as real
 * instants. Values that already carry an offset pass through. */
export function toInstant(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function rangeParams(range: UsageRange): URLSearchParams {
  const params = new URLSearchParams();
  if ("days" in range) params.set("days", String(range.days));
  else {
    params.set("from", toInstant(range.from));
    if (range.to) params.set("to", toInstant(range.to));
  }
  return params;
}

/** One screen's friction, every component as a rate plus a single
 * 0-100 score -- see usage/stats.py's _by_screen for the formula. */
export interface UsageScreenFriction {
  route: string;
  views: number;
  clicks: number;
  bounces: number;
  bounce_rate: number;
  returns: number;
  back_rate: number;
  /** Clicks whose response was measured (on something clickable-looking); dead_rate is over these. */
  measured_clicks: number;
  dead_clicks: number;
  /** null when no click on the screen had a measured response. */
  dead_rate: number | null;
  rage_bursts: number;
  errors: number;
  score: number;
}

export interface UsageSummary {
  days: number;
  since: string;
  until: string;
  totals: { events: number; active_users: number; sessions: number; avg_session_ms: number; errors: number };
  tasks: { annotate: UsageTask; review: UsageTask };
  routes: UsageRouteStat[];
  transitions: UsageTransition[];
  actions: { name: string; count: number }[];
  friction: {
    bounces: UsageFrictionRow[];
    back_and_forth: UsageFrictionRow[];
    rage_clicks: UsageFrictionRow[];
    dead_clicks: UsageFrictionRow[];
    errors: UsageFrictionRow[];
    idle_share: number;
    by_screen: UsageScreenFriction[];
  };
  /** View-weighted mean of by_screen scores; null with no views. */
  friction_score: number | null;
  users: UsageUser[];
  recording: { enabled: boolean; disabled_user_ids: string[] };
  effort: { annotation: UsageEffort; review: UsageEffort; all: UsageEffort };
  effort_by_device: Record<string, UsageEffort>;
  cases: UsageCaseRow[];
  complexity: { cases: number; per_object_median_ms: number | null; drivers: UsageDriver[] };
  ratings: { count: number; mean: number | null; distribution: Record<string, number> };
  reject_reasons: { total: number; reasons: { reason: string; count: number; share: number }[] };
  tools: { tools: { tool: string; time_ms: number; share: number; selections: number }[]; case_visits: number; switches_per_case_median: number | null };
  performance: UsagePerfRow[];
  guides: { tours: UsageTour[]; finished_user_ids: string[] };
  releases: UsageRelease[];
  /** What the figures are built from, and who is left out. */
  basis: { events: number; people: number; sessions: number; not_counted: number; admins_left_out: boolean };
}

export type UsageTab = "overview" | "behaviour" | "friction" | "cases" | "people" | "settings";
export type UsageFindingSeverity = "critical" | "warn" | "info" | "good";

/** A plain-language conclusion the backend drew from the data -- see
 * usage/findings.py for the rules and thresholds. */
export interface UsageFinding {
  id: string;
  severity: UsageFindingSeverity;
  title: string;
  detail: string;
  tab: UsageTab;
  evidence: Record<string, unknown>;
}

export interface UsageFindings {
  since: string;
  until: string;
  findings: UsageFinding[];
  friction_score: number | null;
}

export interface UsageSession {
  session_id: string;
  user_id: string;
  username: string;
  app: "admin-ui" | "viewer";
  started_at: string;
  ended_at: string;
  duration_ms: number;
  page_views: number;
  actions: number;
  clicks: number;
  errors: number;
  routes: string[];
}

export interface UsageEventRow {
  id: string;
  user_id: string;
  session_id: string;
  app: "admin-ui" | "viewer";
  event_type: string;
  route: string;
  name: string | null;
  detail: Record<string, unknown> | null;
  duration_ms: number | null;
  occurred_at: string;
}

export interface UsageSessionDetail {
  session_id: string;
  user_id: string;
  username: string;
  app: "admin-ui" | "viewer";
  events: UsageEventRow[];
  /** Screen snapshots taken during the sitting, oldest first. */
  snapshots: UsageSnapshotMeta[];
}

const snapshotDocuments = new Map<string, Promise<string>>();

/** One snapshot as a self-contained HTML document for a sandboxed iframe (cached per id). */
export function getUsageSnapshotDocument(snapshotId: string): Promise<string> {
  let pending = snapshotDocuments.get(snapshotId);
  if (!pending) {
    pending = apiFetch<{ document: string }>(base, `/admin/usage/snapshots/${snapshotId}`).then((r) => r.document);
    pending.catch(() => snapshotDocuments.delete(snapshotId));
    snapshotDocuments.set(snapshotId, pending);
  }
  return pending;
}

/** A screen as recorded boxes: [x, y, w, h, kind, label?, background?] in viewport px. */
export interface UsageLayout {
  elements: [number, number, number, number, "panel" | "media" | "heading" | "button" | "link" | "input", string?, string?][];
  viewport: [number, number];
  bg?: string;
  occurred_at?: string;
  app_version?: string | null;
  mode?: UsageJobMode;
}

/** A recorded picture of a screen (its HTML without images), see admin-service usage/snapshots.py. */
export interface UsageSnapshotMeta {
  id: string;
  route: string;
  app: "admin-ui" | "viewer";
  app_version: string | null;
  job_id: string | null;
  viewport: [number, number];
  occurred_at: string | null;
  mode?: UsageJobMode;
  study_id?: string | null;
  structure_key?: string | null;
  /** The case images came along (recorded while track_screen_images was on). */
  has_images?: boolean;
}

/** The kind of job a click was made in: an Annotation or Review card's case, or neither. */
export type UsageJobMode = "annotation" | "review" | "other";

export interface UsageHeatmap {
  route: string;
  days: number;
  /** placed: on its own element (exact), on the same kind of element (similar), or at its screen position (screen). */
  points: { x: number; y: number; target: string | null; user_id: string; dead: boolean; mode: UsageJobMode; placed: "exact" | "similar" | "screen" }[];
  /** Clicks on elements the picture doesn't have (a pane switched off...). */
  hidden: { target: string; clicks: number }[];
  placement: { total: number; exact: number; similar: number; screen: number; hidden: number };
  /** Clicks per kind of job, before any mode filter. */
  modes: Record<UsageJobMode, number>;
  /** The screen's most recent recorded layout (in the chosen kind of job), to draw behind the clicks. */
  layout: UsageLayout | null;
  /** The screen's most recent snapshot (in the chosen kind of job) -- preferred over the layout. */
  snapshot: UsageSnapshotMeta | null;
  /** Who clicked, most clicks first -- the legend's order and colour key. */
  users: { user_id: string; username: string; clicks: number }[];
}

export function getUsageSettings(): Promise<UsageSettings> {
  return apiFetch(base, "/admin/usage/settings");
}

export function updateUsageSettings(patch: UsageSettingsPatch): Promise<UsageSettings> {
  return apiFetch(base, "/admin/usage/settings", { method: "PUT", body: JSON.stringify(patch) });
}

/** One "clear the usage log": what it moved out, and whether it can still be put back. */
export interface UsageClear {
  id: string;
  cleared_at: string | null;
  cleared_by: string | null;
  events: number;
  snapshots: number;
  first_at: string | null;
  last_at: string | null;
  /** What is still in the archive (the retention period may have taken the oldest). */
  remaining: { events: number; snapshots: number };
  status: "archived" | "restored" | "deleted" | "expired";
  restored_at: string | null;
  restored_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface UsageClears {
  live: { events: number; snapshots: number };
  clears: UsageClear[];
}

export function listUsageClears(): Promise<UsageClears> {
  return apiFetch(base, "/admin/usage/clears");
}

/** Moves the whole usage log into the archive -- restorable. */
export function clearUsageLog(): Promise<UsageClears & { clear: UsageClear }> {
  return apiFetch(base, "/admin/usage/clear", { method: "POST", body: JSON.stringify({ confirm: true }) });
}

export function restoreUsageClear(id: string): Promise<UsageClears & { restored: { events: number; snapshots: number } }> {
  return apiFetch(base, `/admin/usage/clears/${id}/restore`, { method: "POST" });
}

/** Deletes a cleared log's data for good. */
export function deleteUsageClear(id: string): Promise<UsageClears> {
  return apiFetch(base, `/admin/usage/clears/${id}`, { method: "DELETE" });
}

export function setUsageUserSwitch(userId: string, change: { enabled?: boolean; counted?: boolean }): Promise<UsageSettings> {
  return apiFetch(base, `/admin/usage/settings/users/${encodeURIComponent(userId)}`, { method: "PUT", body: JSON.stringify(change) });
}

export function listUsagePeople(): Promise<UsagePerson[]> {
  return apiFetch(base, "/admin/usage/people");
}

/** Everything the page shows for one window, in one call (see admin-service's /admin/usage/overview). */
export interface UsageOverview {
  since: string;
  until: string;
  summary: UsageSummary;
  previous: UsageSummary;
  pipeline: PipelineHealthSummary;
  pipeline_previous: PipelineHealthSummary;
  learning_curve: LearningCurvePoint[];
  findings: UsageFinding[];
}

export function getUsageOverview(range: UsageRange, userId?: string | null, studyId?: string | null): Promise<UsageOverview> {
  const params = rangeParams(range);
  if (userId) params.set("user_id", userId);
  if (studyId) params.set("study_id", studyId);
  return apiFetch(base, `/admin/usage/overview?${params}`);
}

export function getUsageSummary(range: UsageRange, userId?: string | null): Promise<UsageSummary> {
  const params = rangeParams(range);
  if (userId) params.set("user_id", userId);
  return apiFetch(base, `/admin/usage/summary?${params}`);
}

export function listUsageSessions(range: UsageRange, userId?: string | null, limit = 100, studyId?: string | null): Promise<UsageSession[]> {
  const params = rangeParams(range);
  params.set("limit", String(limit));
  if (userId) params.set("user_id", userId);
  if (studyId) params.set("study_id", studyId);
  return apiFetch(base, `/admin/usage/sessions?${params}`);
}

export function getUsageSession(sessionId: string): Promise<UsageSessionDetail> {
  return apiFetch(base, `/admin/usage/sessions/${encodeURIComponent(sessionId)}`);
}

export function getUsageHeatmap(route: string, range: UsageRange, userId?: string | null, mode?: UsageJobMode | null, studyId?: string | null): Promise<UsageHeatmap> {
  const params = rangeParams(range);
  params.set("route", route);
  if (userId) params.set("user_id", userId);
  if (studyId) params.set("study_id", studyId);
  if (mode) params.set("mode", mode);
  return apiFetch(base, `/admin/usage/heatmap?${params}`);
}

export function getUsageFindings(range: UsageRange, userId?: string | null): Promise<UsageFindings> {
  const params = rangeParams(range);
  if (userId) params.set("user_id", userId);
  return apiFetch(base, `/admin/usage/findings?${params}`);
}

async function fetchWithToken(path: string): Promise<Response> {
  const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${keycloak.token}` } });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  return response;
}

/** The Overview as Markdown -- text, not JSON, so not apiFetch. */
export async function getUsageReportMarkdown(range: UsageRange, userId?: string | null, studyId?: string | null): Promise<string> {
  const params = rangeParams(range);
  if (userId) params.set("user_id", userId);
  if (studyId) params.set("study_id", studyId);
  return (await fetchWithToken(`/admin/usage/report.md?${params}`)).text();
}

/** Every recorded event in the window as CSV, streamed by the server;
 * fetched with the bearer token (a plain <a href> couldn't carry it)
 * and saved through a temporary download link, the same way
 * downloadBackup does. */
export async function downloadUsageEventsCsv(range: UsageRange, userId?: string | null, includeMouse = false, studyId?: string | null): Promise<string> {
  const params = rangeParams(range);
  if (userId) params.set("user_id", userId);
  if (studyId) params.set("study_id", studyId);
  if (includeMouse) params.set("include_mouse", "true");
  const response = await fetchWithToken(`/admin/usage/export/events.csv?${params}`);
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "usage-events.csv";
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return filename;
}

// ---------------------------------------------------------------- pipeline health
// See admin-service's app/pipeline_health package. Admin only. A "leg"
// covers one Annotation or Review card's own handling of one case:
// queue (queued -> first touch) then work (first touch -> the card's
// terminal action). Distinct from usage tracking -- this is the
// clinical pipeline's own clock, not how someone used the UI.

export interface PipelineLegStat {
  count: number;
  median_ms: number | null;
  mean_ms: number | null;
}

export interface PipelineHealthSummary {
  days: number;
  since: string;
  until: string;
  legs: Record<string, { queue: PipelineLegStat; work: PipelineLegStat }>;
  bottlenecks: {
    card_id: string;
    card_type: "annotation" | "review";
    case_id: string;
    case_title: string | null;
    assignee_id: string | null;
    assignee: string | null;
    kind: "queue" | "work";
    waiting_ms: number;
    baseline_ms: number | null;
    flagged: boolean;
  }[];
  /** How cases decided in the window fared at review. */
  quality: { decided: number; first_pass_rate: number | null; sent_back_rate: number | null; rounds_to_approve: number | null };
  assignee_load: {
    assignee_id: string;
    assignee: string | null;
    card_type: "annotation" | "review";
    open_count: number;
    oldest_since: string;
  }[];
}

export interface LearningCurvePoint {
  actor_id: string;
  username: string | null;
  card_type: "annotation" | "review";
  week: number;
  median_ms: number;
  count: number;
}

export function getPipelineHealthSummary(range: UsageRange, cardId?: string | null): Promise<PipelineHealthSummary> {
  const params = rangeParams(range);
  if (cardId) params.set("card_id", cardId);
  return apiFetch(base, `/admin/pipeline-health/summary?${params}`);
}

export function getLearningCurve(): Promise<LearningCurvePoint[]> {
  return apiFetch(base, "/admin/pipeline-health/learning-curve");
}

// ---------------------------------------------------------------- registration requests

export interface RegistrationRequest {
  id: string;
  created_at: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  decided_at: string | null;
  decided_by: string | null;
  rejection_reason: string | null;
}

export interface RegistrationRequestInput {
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  note?: string | null;
}

/** The pre-login AuthPage's "Create account" tab posts here -- and
 * deliberately bypasses apiFetch (which always attaches the current
 * Keycloak token): there is no session yet, that's the whole point. */
export async function submitRegistrationRequest(input: RegistrationRequestInput): Promise<RegistrationRequest> {
  const response = await fetch(`${base}/public/registration-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  return response.json();
}

/** Every submission through that form -- listed here for the Users
 * page's "Registration requests" panel (global admin only). */
export function listRegistrationRequests(status?: RegistrationRequest["status"]): Promise<RegistrationRequest[]> {
  const qs = status ? `?status=${status}` : "";
  return apiFetch(base, `/admin/registration-requests${qs}`);
}

/** Creates the real Keycloak account with a random one-time password and
 * emails it to the requester -- see admin-service's registration.py. */
export function approveRegistrationRequest(id: string): Promise<RegistrationRequest> {
  return apiFetch(base, `/admin/registration-requests/${id}/approve`, { method: "POST" });
}

export function rejectRegistrationRequest(id: string, reason?: string): Promise<RegistrationRequest> {
  return apiFetch(base, `/admin/registration-requests/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason: reason || null }),
  });
}

// ---------------------------------------------------------------- study versions

export interface StudyVersionSummary {
  cards: number;
  edges: number;
  members: number;
  cases: number;
  name?: string | null;
}

export interface StudyVersion {
  id: string;
  number: number;
  kind: "auto" | "manual" | "pre_restore";
  label: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string | null;
  summary: StudyVersionSummary;
}

export interface VersionChangeCounts {
  added: number;
  removed: number;
  modified: number;
}

export interface StudyVersionDetail extends StudyVersion {
  snapshot: Record<string, unknown>;
  changes_if_restored: {
    study: boolean;
    members: VersionChangeCounts;
    cards: VersionChangeCounts;
    edges: VersionChangeCounts;
    cases: VersionChangeCounts;
  };
}

export function listStudyVersions(studyId: string): Promise<StudyVersion[]> {
  return apiFetch(base, `/admin/studies/${studyId}/versions`);
}

export function createStudyVersion(studyId: string, label: string): Promise<StudyVersion> {
  return apiFetch(base, `/admin/studies/${studyId}/versions`, { method: "POST", body: JSON.stringify({ label }) });
}

export function getStudyVersion(studyId: string, versionId: string): Promise<StudyVersionDetail> {
  return apiFetch(base, `/admin/studies/${studyId}/versions/${versionId}`);
}

export function restoreStudyVersion(
  studyId: string,
  versionId: string
): Promise<{ restored_version: number; safety_version: number | null; new_version: number | null }> {
  return apiFetch(base, `/admin/studies/${studyId}/versions/${versionId}/restore`, { method: "POST" });
}

export function deleteStudyVersion(studyId: string, versionId: string): Promise<void> {
  return apiFetch(base, `/admin/studies/${studyId}/versions/${versionId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------- database backups

export interface BackupFile {
  filename: string;
  size_bytes: number;
  created_at: string;
  sha256: string | null;
}

export interface BackupsOverview {
  available: boolean;
  backups: BackupFile[];
  status: { state: string; file: string; message: string; at: string } | null;
  queued: boolean;
  directory: string;
}

export function listBackups(): Promise<BackupsOverview> {
  return apiFetch(base, "/admin/backups");
}

export function requestBackup(): Promise<{ status: string }> {
  return apiFetch(base, "/admin/backups", { method: "POST" });
}

export function deleteBackup(filename: string): Promise<void> {
  return apiFetch(base, `/admin/backups/${filename}`, { method: "DELETE" });
}

/** The dump is fetched with the bearer token and handed to the browser
 * as a blob download -- a plain <a href> couldn't carry the token. */
export async function downloadBackup(filename: string): Promise<void> {
  const response = await fetch(`${base}/admin/backups/${filename}`, {
    headers: { Authorization: `Bearer ${keycloak.token}` },
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- notification service

export interface NotificationSettings {
  enabled: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_username: string | null;
  smtp_password_set: boolean;
  smtp_use_tls: boolean;
  smtp_use_ssl: boolean;
  from_address: string;
  platform_base_url: string;
  poll_interval_seconds: number;
  updated_at: string | null;
}

export type NotificationSettingsPatch = Partial<Omit<NotificationSettings, "smtp_password_set" | "updated_at">> & {
  // null/absent = keep the stored one, "" = clear it.
  smtp_password?: string | null;
};

export interface NotificationStatus {
  running: boolean;
  enabled: boolean;
  poll_interval_seconds: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  last_result: { cards: number; events: number; sent: number; skipped: number; failed: number; bootstrap: boolean } | null;
  log_entries: number;
}

export interface NotificationLogEntry {
  id: string;
  created_at: string;
  user_id: string;
  email: string | null;
  event_type: string;
  card_id: string | null;
  subject: string;
  body: string;
  status: "sent" | "failed" | "skipped";
  error: string | null;
}

export interface NotificationPreference {
  user_id: string;
  username?: string | null;
  email?: string | null;
  email_enabled: boolean;
  notify_new_job: boolean;
  notify_status_change: boolean;
}

export type NotificationPreferencePatch = Partial<Pick<NotificationPreference, "email_enabled" | "notify_new_job" | "notify_status_change">>;

export function getNotificationSettings(): Promise<NotificationSettings> {
  return apiFetch(base, "/admin/notifications/settings");
}

export function updateNotificationSettings(patch: NotificationSettingsPatch): Promise<NotificationSettings> {
  return apiFetch(base, "/admin/notifications/settings", { method: "PUT", body: JSON.stringify(patch) });
}

export function sendTestNotificationEmail(to?: string): Promise<{ status: string; to: string }> {
  return apiFetch(base, "/admin/notifications/test-email", { method: "POST", body: JSON.stringify({ to: to || null }) });
}

export function runNotificationCheckNow(): Promise<NotificationStatus["last_result"]> {
  return apiFetch(base, "/admin/notifications/run-now", { method: "POST" });
}

export function getNotificationStatus(): Promise<NotificationStatus> {
  return apiFetch(base, "/admin/notifications/status");
}

export function listNotificationLog(limit = 100): Promise<NotificationLogEntry[]> {
  return apiFetch(base, `/admin/notifications/log?limit=${limit}`);
}

export function listNotificationPreferences(): Promise<NotificationPreference[]> {
  return apiFetch(base, "/admin/notifications/preferences");
}

export function updateNotificationPreferences(userId: string, patch: NotificationPreferencePatch): Promise<NotificationPreference> {
  return apiFetch(base, `/admin/notifications/preferences/${userId}`, { method: "PUT", body: JSON.stringify(patch) });
}

export function getMyNotificationPreferences(): Promise<NotificationPreference> {
  return apiFetch(base, "/admin/notifications/preferences/me");
}

export function updateMyNotificationPreferences(patch: NotificationPreferencePatch): Promise<NotificationPreference> {
  return apiFetch(base, "/admin/notifications/preferences/me", { method: "PUT", body: JSON.stringify(patch) });
}
