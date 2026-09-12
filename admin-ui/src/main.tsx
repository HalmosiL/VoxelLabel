import React, { ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import AuthPage, { AUTH_NOTICE_KEY, AuthTokens } from "./pages/AuthPage";
import { MeProvider } from "./auth/MeContext";
import keycloak from "./keycloak";
import "./styles.css";

interface TokenSet {
  token: string;
  refreshToken: string;
  idToken: string;
}

type Source = "clinician" | "browser";

const BROWSER_SESSION_KEY = "vl.session";

/** Where a plain browser tab keeps its own session across reloads and
 * restarts -- the local equivalent of what the clinician-app's
 * Electron shell does with its encrypted session-store.js, and of what
 * Keycloak's own SSO cookie used to do before this app started
 * handling login itself (see pages/AuthPage.tsx's docstring for why:
 * the ROPC exchange used there never visits Keycloak's own login page,
 * so it never sets that cookie -- without storing something ourselves,
 * every full page reload would otherwise sign the person straight back
 * out). Used only outside the clinician app, which has its own,
 * better-protected store instead. Wrapped in try/catch: private
 * browsing or a locked-down browser can make localStorage throw on
 * read *or* write -- worst case here is "sign in again next reload",
 * never a crash. */
function readBrowserSession(): TokenSet | null {
  try {
    const raw = localStorage.getItem(BROWSER_SESSION_KEY);
    return raw ? (JSON.parse(raw) as TokenSet) : null;
  } catch {
    return null;
  }
}
function writeBrowserSession(tokens: TokenSet): void {
  try {
    localStorage.setItem(BROWSER_SESSION_KEY, JSON.stringify(tokens));
  } catch {
    // Session still works for this tab; it just won't survive a reload.
  }
}
function clearBrowserSession(): void {
  try {
    localStorage.removeItem(BROWSER_SESSION_KEY);
  } catch {
    // Nothing to do -- see readBrowserSession's note.
  }
}

/** One React root for the whole page lifetime. The pre-login AuthPage
 * and the authenticated App are rendered into the *same* root in turn
 * -- calling ReactDOM.createRoot() twice on the same container (an
 * earlier version did) is something React 18 explicitly warns about
 * and can leave the first tree's effects running underneath the
 * second. */
let root: ReactDOM.Root | null = null;
function render(node: ReactNode) {
  if (!root) {
    const rootElement = document.getElementById("root");
    if (!rootElement) throw new Error("Missing #root element");
    root = ReactDOM.createRoot(rootElement);
  }
  root.render(<React.StrictMode>{node}</React.StrictMode>);
}

function renderApp() {
  render(
    <BrowserRouter>
      <MeProvider>
        <App />
      </MeProvider>
    </BrowserRouter>
  );
}

function renderAuthError(message: string) {
  render(<p className="alert-error" style={{ margin: "2rem" }}>{message}</p>);
}

/** The pre-login screen: sign in or ask for an account, one surface,
 * see pages/AuthPage.tsx. Reached whenever there's no saved session to
 * restore -- replaces what used to be an unconditional redirect to
 * Keycloak's own hosted login page. `?auth=register` (register.html
 * redirects here with it) opens straight to the "Create account" tab. */
function renderAuthPage(onAuthenticated: (tokens: AuthTokens) => void) {
  const initialTab = new URLSearchParams(window.location.search).get("auth") === "register" ? "register" : "signin";
  render(<AuthPage onAuthenticated={onAuthenticated} initialTab={initialTab} />);
}

/** Persists a just-refreshed or just-obtained token set back to
 * wherever this session's tokens came from, so the *next* reload or
 * launch restores with the current (rotated) refresh token rather than
 * an already-superseded one. */
function persist(source: Source, tokens: TokenSet) {
  if (source === "clinician") void window.clinicianSession?.saveSession(tokens);
  else writeBrowserSession(tokens);
}

/** Forgets the stored session and starts over from a clean page load,
 * which lands on AuthPage. This is the one way out of every "the
 * session we had is no good any more" situation -- Keycloak answering
 * invalid_grant / "Session not active" to a refresh, a rejected
 * restore, a refresh loop that finally fails -- because keycloak.init()
 * can only ever be called once per page and a full reload is the only
 * way to get a fresh instance. Deliberately NOT keycloak.login(): that
 * would bounce people to Keycloak's own hosted login page, the exact
 * screen this app's own sign-in form exists to replace. */
function startOver(source: Source) {
  try {
    // Read once by AuthPage on its next mount, so the person sees *why*
    // they're looking at the sign-in form again instead of a silent bounce.
    sessionStorage.setItem(AUTH_NOTICE_KEY, "Your session ended -- please sign in again.");
  } catch {
    // Fine without the notice.
  }
  if (source === "clinician") void window.clinicianSession?.clearSession().finally(() => window.location.reload());
  else {
    clearBrowserSession();
    window.location.reload();
  }
}

// Keep the token fresh; api/client.ts reads keycloak.token on every
// request. updateToken(30) is a no-op until the access token is within
// 30s of expiry, so an actual refresh happens every few minutes, not
// every tick.
function startTokenRefreshLoop(source: Source) {
  setInterval(() => {
    keycloak
      .updateToken(30)
      .then(() => {
        if (keycloak.token && keycloak.refreshToken && keycloak.idToken) {
          persist(source, { token: keycloak.token, refreshToken: keycloak.refreshToken, idToken: keycloak.idToken });
        }
      })
      .catch(() => startOver(source));
  }, 20000);
}

/** Hands a token set (however it was obtained -- restored from a saved
 * session, or fresh from AuthPage's password-grant exchange) to
 * keycloak-js. This is the ONE place keycloak.init() is ever called:
 * that call is only valid once per instance, so both bootstrap paths
 * below funnel through here instead of each calling it themselves.
 * keycloak-js, given tokens and no login iframe, immediately does a
 * forced refresh against the refresh token -- so a token set whose
 * Keycloak session is already gone fails right here, and startOver()
 * takes the person back to the sign-in form. */
async function activateSession(tokens: TokenSet, source: Source) {
  try {
    // checkLoginIframe is off: the session-status iframe depends on
    // third-party cookies (blocked by default in current browsers), so
    // it can't reliably detect anything -- and it fired an aborted
    // request on every page load. Token refresh (above) is what
    // actually keeps the session alive.
    const authenticated = await keycloak.init({ ...tokens, pkceMethod: "S256", checkLoginIframe: false });
    if (!authenticated) {
      startOver(source);
      return;
    }
    if (keycloak.token && keycloak.refreshToken && keycloak.idToken) {
      persist(source, { token: keycloak.token, refreshToken: keycloak.refreshToken, idToken: keycloak.idToken });
    }
    startTokenRefreshLoop(source);
    renderApp();
  } catch (error) {
    // A network-level failure (Keycloak unreachable) is worth showing
    // rather than silently reloading into the same failure; anything
    // else means the tokens were rejected -- start over.
    if (error instanceof TypeError) renderAuthError(`Failed to reach Keycloak: ${String(error)}`);
    else startOver(source);
  }
}

async function bootstrap() {
  const clinicianSession = window.clinicianSession;
  const source: Source = clinicianSession ? "clinician" : "browser";
  const saved = clinicianSession ? await clinicianSession.getSession() : readBrowserSession();

  if (saved) {
    // keycloak-js's own documented pattern for restoring a session
    // across reloads/launches: hand it the (possibly already-expired)
    // token set from last time; it decodes what it's given to know
    // whether/when it expired, then refreshes from the still-valid
    // refresh token -- no login screen shown at all when this succeeds.
    await activateSession(saved, source);
    return;
  }

  // Nothing to restore: show our own sign-in/register surface instead
  // of redirecting straight to Keycloak's hosted page. Only once
  // someone actually authenticates does keycloak.init() get called,
  // exactly once, via activateSession above.
  renderAuthPage((tokens: AuthTokens) => {
    void activateSession({ token: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token }, source);
  });
}

bootstrap();
