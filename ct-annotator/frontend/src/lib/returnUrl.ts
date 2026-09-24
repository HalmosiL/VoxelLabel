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
