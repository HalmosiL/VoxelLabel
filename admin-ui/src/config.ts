export const keycloakConfig = {
  url: import.meta.env.VITE_KEYCLOAK_URL ?? "http://localhost:8080",
  realm: import.meta.env.VITE_KEYCLOAK_REALM ?? "ct-platform",
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? "ct-platform",
};

export const API = {
  ingestion: import.meta.env.VITE_INGESTION_API ?? "http://localhost:8001",
  data: import.meta.env.VITE_DATA_API ?? "http://localhost:8002",
  annotation: import.meta.env.VITE_ANNOTATION_API ?? "http://localhost:8003",
  admin: import.meta.env.VITE_ADMIN_API ?? "http://localhost:8004",
};

/** The standalone ct-annotator repo's frontend -- a separate app/repo that
 * calls this platform's services under the caller's own Keycloak token
 * (see ~/Desktop/ct-annotator). Not one of this app's own backends. */
export const ANNOTATOR_UI_URL = import.meta.env.VITE_ANNOTATOR_UI_URL ?? "http://localhost:5174";
