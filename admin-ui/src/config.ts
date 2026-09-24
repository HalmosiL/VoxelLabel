// The clinician-app Electron shell's preload script injects this
// synchronously (see clinician.d.ts) before this module ever runs, so
// reading it here at module scope is safe -- undefined in the normal
// browser deployment, where every value below falls back to today's
// existing VITE_*-env-var reads exactly as before.
const clinician = window.clinicianConfig;

export const keycloakConfig = {
  url: clinician?.keycloakUrl ?? import.meta.env.VITE_KEYCLOAK_URL ?? "http://localhost:8080",
  realm: clinician?.keycloakRealm ?? import.meta.env.VITE_KEYCLOAK_REALM ?? "ct-platform",
  clientId: clinician?.keycloakClientId ?? import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? "ct-platform",
};

export const API = {
  ingestion: clinician?.ingestionApi ?? import.meta.env.VITE_INGESTION_API ?? "http://localhost:8001",
  data: clinician?.dataApi ?? import.meta.env.VITE_DATA_API ?? "http://localhost:8002",
  annotation: clinician?.annotationApi ?? import.meta.env.VITE_ANNOTATION_API ?? "http://localhost:8003",
  admin: clinician?.adminApi ?? import.meta.env.VITE_ADMIN_API ?? "http://localhost:8004",
};

/** A stored object's URL as the browser should load it. The services now
 * hand out signed links to their own API as a path ("/data/objects?...",
 * "/admin/objects?...") -- served through the API the browser already
 * reaches, not straight from MinIO -- so a path gets that API's base in
 * front; anything absolute is left as it is. */
export function assetUrl(base: string, url: string): string;
export function assetUrl(base: string, url: string | null): string | null;
export function assetUrl(base: string, url: string | null): string | null {
  if (!url) return url;
  return url.startsWith("/") ? `${base.replace(/\/$/, "")}${url}` : url;
}

/** The standalone ct-annotator repo's frontend -- a separate app/repo that
 * calls this platform's services under the caller's own Keycloak token
 * (see ~/Desktop/ct-annotator). Not one of this app's own backends. */
export const ANNOTATOR_UI_URL = clinician?.annotatorUiUrl ?? import.meta.env.VITE_ANNOTATOR_UI_URL ?? "http://localhost:5174";

/** True only inside the clinician-app Electron shell. Drives the "just
 * this one doctor's own jobs, nothing else" UI reduction (Layout's nav,
 * App's default route) -- backend role checks are the real access
 * control regardless of what this flag shows or hides. */
export const isClinicianApp = clinician !== undefined;
