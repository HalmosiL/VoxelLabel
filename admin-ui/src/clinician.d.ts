/** Ambient types for the bridge the clinician-app Electron shell's
 * preload script injects into `window` -- absent in the normal browser
 * deployment (Docker/nginx), which is exactly how every "clinician
 * mode" check in this app (config.ts's isClinicianApp, Layout's nav,
 * App's default route, main.tsx's login flow) decides which behavior
 * to use. See clinician-app/preload.js for the implementation. */
export {};

declare global {
  interface Window {
    /** Injected synchronously (before this bundle's own module code
     * runs) with the contents of the Electron app's hand-edited
     * config.json -- overrides config.ts's own VITE_*-env-var reads,
     * since those are baked in at build time and only ever point at
     * localhost. */
    clinicianConfig?: {
      keycloakUrl: string;
      keycloakRealm: string;
      keycloakClientId: string;
      ingestionApi: string;
      dataApi: string;
      annotationApi: string;
      adminApi: string;
      annotatorUiUrl: string;
    };
    /** A full Keycloak token set, persisted (encrypted at rest via
     * Electron's safeStorage) so the app can restore a session on
     * launch without a fresh login. All three fields are required
     * together -- keycloak-js's own "restore a session across reloads"
     * pattern needs the (possibly already-expired) access token and id
     * token alongside the refresh token to initialize correctly before
     * an immediate updateToken() mints a live access token. */
    clinicianSession?: {
      getSession(): Promise<{ token: string; refreshToken: string; idToken: string } | null>;
      saveSession(session: { token: string; refreshToken: string; idToken: string }): Promise<void>;
      clearSession(): Promise<void>;
    };
  }
}
