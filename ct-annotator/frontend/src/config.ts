export const keycloakConfig = {
  url: import.meta.env.VITE_KEYCLOAK_URL ?? "http://localhost:8080",
  realm: import.meta.env.VITE_KEYCLOAK_REALM ?? "ct-platform",
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? "ct-platform",
};

/** The main platform's admin-ui -- only used for the Tutorial job's
 * "Back to My Jobs" link, since the tutorial has no real jobId/studyId
 * to build a normal returnUrl from. */
export const ADMIN_UI_URL = import.meta.env.VITE_ADMIN_UI_URL ?? "http://localhost:5173";

export const API = {
  // This repo's own thin backend -- DICOM rendering, mask annotations,
  // and (since admin-service/data-service's CORS is locked to admin-ui's
  // origin) a proxy for the study/case/imaging picker reads too.
  annotator: import.meta.env.VITE_ANNOTATOR_API ?? "http://localhost:8010",
};
