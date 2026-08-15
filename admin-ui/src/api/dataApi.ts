import { API } from "../config";
import { apiFetch } from "./client";

export interface CaseSummary {
  id: string;
  patient_pseudonym_id: string;
  accession_number: string | null;
}

export interface Study {
  id: string;
  study_instance_uid: string;
  study_date: string | null;
  modality: string | null;
  description: string | null;
}

export interface Series {
  id: string;
  series_instance_uid: string;
  series_description: string | null;
}

export interface Instance {
  id: string;
  sop_instance_uid: string;
  instance_number: number | null;
}

export interface ClinicalDataItem {
  id: string;
  date: string | null;
  type: string;
  title: string;
  has_file: boolean;
  tags: string[];
  consents: { consent_type: string; status: "granted" | "revoked" }[];
}

export interface PatientSummary {
  id: string;
  pseudonym_id: string;
  case_count: number;
}

export interface PatientCase {
  id: string;
  project_id: string;
  project_name: string;
  accession_number: string | null;
  studies: { id: string; study_instance_uid: string; modality: string | null; description: string | null }[];
  tags: string[];
}

const base = API.data;

export function listCases(projectId: string): Promise<CaseSummary[]> {
  return apiFetch(base, `/data/projects/${projectId}/cases`);
}

export function getCase(caseId: string): Promise<CaseSummary & { project_id: string }> {
  return apiFetch(base, `/data/cases/${caseId}`);
}

export function listStudies(caseId: string): Promise<Study[]> {
  return apiFetch(base, `/data/cases/${caseId}/studies`);
}

export function listSeries(studyId: string): Promise<Series[]> {
  return apiFetch(base, `/data/studies/${studyId}/series`);
}

export function listInstances(seriesId: string): Promise<Instance[]> {
  return apiFetch(base, `/data/series/${seriesId}/instances`);
}

export function getPixelDataUrl(instanceId: string): Promise<{ url: string }> {
  return apiFetch(base, `/data/instances/${instanceId}/pixel-data-url`);
}

export function listClinicalDataItems(caseId: string): Promise<ClinicalDataItem[]> {
  return apiFetch(base, `/data/cases/${caseId}/clinical-data-items`);
}

export function getClinicalDataFileUrl(itemId: string): Promise<{ url: string }> {
  return apiFetch(base, `/data/clinical-data-items/${itemId}/file-url`);
}

export function listPatients(): Promise<PatientSummary[]> {
  return apiFetch(base, "/data/patients");
}

export function listPatientCases(patientId: string): Promise<PatientCase[]> {
  return apiFetch(base, `/data/patients/${patientId}/cases`);
}
