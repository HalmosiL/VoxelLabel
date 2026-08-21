import { API } from "../config";
import { apiFetch } from "./client";

export interface CaseSummary {
  id: string;
  study_id: string;
  patient_pseudonym_id: string;
  accession_number: string | null;
  date: string | null;
  type: string | null;
  title: string | null;
  comment: string | null;
  tags: string[];
}

export interface ImagingStudy {
  id: string;
  study_instance_uid: string;
  study_date: string | null;
  modality: string | null;
  description: string | null;
  thumbnail_url: string | null;
}

export interface Series {
  id: string;
  series_instance_uid: string;
  series_description: string | null;
  thumbnail_url: string | null;
}

export interface CaseSeries extends Series {
  imaging_study_id: string;
  imaging_study_description: string | null;
}

export interface Instance {
  id: string;
  sop_instance_uid: string;
  instance_number: number | null;
  thumbnail_url: string | null;
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

export interface PatientCaseImagingStudy {
  id: string;
  study_instance_uid: string;
  modality: string | null;
  description: string | null;
  thumbnail_url: string | null;
}

export interface PatientCase {
  id: string;
  study_id: string;
  study_name: string;
  accession_number: string | null;
  title: string | null;
  imaging_studies: PatientCaseImagingStudy[];
  documents: ClinicalDataItem[];
  tags: string[];
}

const base = API.data;

export function listCases(studyId: string): Promise<CaseSummary[]> {
  return apiFetch(base, `/data/studies/${studyId}/cases`);
}

export function getCase(caseId: string): Promise<CaseSummary> {
  return apiFetch(base, `/data/cases/${caseId}`);
}

export function listImagingStudies(caseId: string): Promise<ImagingStudy[]> {
  return apiFetch(base, `/data/cases/${caseId}/imaging-studies`);
}

export function listCaseSeries(caseId: string): Promise<CaseSeries[]> {
  return apiFetch(base, `/data/cases/${caseId}/series`);
}

export function listSeries(imagingStudyId: string): Promise<Series[]> {
  return apiFetch(base, `/data/imaging-studies/${imagingStudyId}/series`);
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
