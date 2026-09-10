import keycloak from "../keycloak";

/** Signs out everywhere the session lives: the clinician desktop shell's
 * persisted token set is dropped first (otherwise the next launch would
 * silently restore it and undo the logout), then Keycloak ends the
 * session. In the browser deployment clinicianSession is undefined and
 * this is a plain Keycloak logout. */
export function logout(): void {
  const cleared = window.clinicianSession?.clearSession() ?? Promise.resolve();
  cleared.finally(() => keycloak.logout());
}
