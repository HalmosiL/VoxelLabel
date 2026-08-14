import keycloak from "../keycloak";

/** Raised for any non-2xx response from a backend service. */
export class ApiError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`API error ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Thin fetch wrapper shared by every service's API client: attaches the
 * current Keycloak access token, sets JSON headers, and normalizes errors.
 */
export async function apiFetch<T>(baseUrl: string, path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${keycloak.token}`);
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(response.status, body);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
