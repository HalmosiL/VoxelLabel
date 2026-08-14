import keycloak from "../keycloak";
import { API } from "../config";
import { ApiError } from "./client";

export async function uploadDicom(projectId: string, file: File): Promise<{ job_id: string; status: string }> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${API.ingestion}/ingestion/projects/${projectId}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keycloak.token}` },
    body: formData,
  });

  if (!response.ok) {
    throw new ApiError(response.status, await response.text());
  }
  return response.json();
}
