import { API } from "../config";
import { apiFetch } from "./client";

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

const base = API.data;

export function listStudies(projectId: string): Promise<Study[]> {
  return apiFetch(base, `/data/projects/${projectId}/studies`);
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
