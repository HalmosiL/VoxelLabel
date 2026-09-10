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

/** Same as apiFetch, but also returns the unpaged total a paged list
 * endpoint reports in its X-Total-Count header (see data-service's
 * list_cases / list_patients). */
export async function apiFetchWithTotal<T>(
  baseUrl: string,
  path: string,
  options: RequestInit = {}
): Promise<{ items: T; total: number }> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${keycloak.token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  if (!response.ok) {
    throw new ApiError(response.status, await response.text());
  }
  const items = (await response.json()) as T;
  const total = Number(response.headers.get("X-Total-Count") ?? (Array.isArray(items) ? items.length : 0));
  return { items, total };
}

/** Turns any thrown value into a sentence a person can act on -- the raw
 * `API error 403: {"detail": ...}` string every page used to show is
 * fine for a developer and meaningless to a doctor. The backend's
 * `detail` is kept where it says something specific; the well-known
 * status codes get a plain-language lead-in. */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    let detail = "";
    try {
      const parsed = JSON.parse(err.body) as { detail?: unknown };
      if (typeof parsed.detail === "string") detail = parsed.detail;
      else if (Array.isArray(parsed.detail)) {
        detail = parsed.detail
          .map((d) => (typeof d === "object" && d && "msg" in d ? String((d as { msg: unknown }).msg) : JSON.stringify(d)))
          .join("; ");
      }
    } catch {
      detail = err.body;
    }
    // A proxied error (ct-annotator forwards the platform's own JSON body
    // as its detail string) can nest one more level -- unwrap it.
    try {
      const nested = JSON.parse(detail) as { detail?: unknown };
      if (typeof nested.detail === "string") detail = nested.detail;
    } catch {
      // not nested
    }
    switch (err.status) {
      case 401:
        return "Your session has expired -- please sign in again.";
      case 403:
        return /realm role|study role|Insufficient/i.test(detail) || !detail
          ? "You don't have permission to do this in this study."
          : `You don't have permission to do this: ${detail}`;
      case 404:
        return detail ? `Not found: ${detail}` : "That item no longer exists.";
      case 409:
        return detail || "This conflicts with the current state -- reload the page and try again.";
      case 422:
        return detail ? `Invalid request: ${detail}` : "The request was invalid.";
      default:
        if (err.status >= 500) return `The server ran into a problem (HTTP ${err.status}). Please try again.`;
        return detail || err.message;
    }
  }
  if (err instanceof TypeError) return "Can't reach the server -- check that the platform is running.";
  return err instanceof Error ? err.message : String(err);
}
