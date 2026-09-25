import { ADMIN_UI_URL } from "../config";

/** The viewer's "Back" target, from the `returnUrl` query parameter --
 * only ever somewhere of our own: a path on this viewer, or a page of
 * the platform's admin-ui. Anything else (a `javascript:` URL, another
 * site, a protocol-relative `//host`) is dropped, so a crafted link can
 * neither run script in the viewer's origin -- where the refresh token
 * lives -- nor send the annotator off to a look-alike page. */
export function safeReturnUrl(raw: string | null, here: string = window.location.origin, adminUi: string = ADMIN_UI_URL): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const allowed = new Set<string>([here]);
  try {
    allowed.add(new URL(adminUi).origin);
  } catch {
    // a misconfigured ADMIN_UI_URL only narrows what's allowed
  }
  return allowed.has(url.origin) ? url.toString() : null;
}

/** The Back target after moving from one case to another in the viewer:
 * a link to the case page of the case being left now points at the case
 * on screen (D-07 -- it kept returning to the first case opened). Any
 * other target (the picker, a job page) is kept as it is. */
export function returnUrlForCase(returnUrl: string | null, fromCaseId: string | null, toCaseId: string): string | null {
  if (!returnUrl || !fromCaseId) return returnUrl;
  return returnUrl.replace(`/cases/${fromCaseId}`, `/cases/${toCaseId}`);
}
