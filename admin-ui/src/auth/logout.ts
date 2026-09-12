import keycloak from "../keycloak";

/** Signs out everywhere the session lives: the clinician desktop shell's
 * persisted token set (or, in a plain browser tab, the localStorage
 * session main.tsx's bootstrap uses to survive a reload -- see its
 * "vl.session" key) is dropped first, otherwise the next launch or
 * reload would silently restore it and undo the logout, then Keycloak
 * ends the session. */
export function logout(): void {
  const cleared = window.clinicianSession?.clearSession() ?? Promise.resolve();
  if (!window.clinicianSession) {
    try {
      localStorage.removeItem("vl.session");
    } catch {
      // Best-effort -- see main.tsx's readBrowserSession for why this
      // can throw and why that's not fatal.
    }
  }
  cleared.finally(() => keycloak.logout());
}
