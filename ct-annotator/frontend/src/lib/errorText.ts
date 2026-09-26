import { ApiError } from "../api/client";

/** Any failure as a sentence for the error banner. Raw texts such as
 * "TypeError: Failed to fetch" or "API error 500: Internal Server Error"
 * reached the screen and alarmed people (K7). */
export function errorText(err: unknown): string {
  if (err instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(err.message)) {
    return "Lost the connection to the server -- check your network and try again.";
  }
  if (err instanceof ApiError) {
    let detail = "";
    try {
      const parsed = JSON.parse(err.body);
      if (typeof parsed?.detail === "string") detail = parsed.detail;
    } catch {
      // not JSON: a proxy's or server's own error page
    }
    if (detail) return detail;
    if (err.status >= 500) return "The server had a problem -- try again in a minute.";
    return `The request was refused (${err.status}).`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
