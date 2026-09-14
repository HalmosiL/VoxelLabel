import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import keycloak from "./keycloak";
import "./styles.css";

interface TokenSet {
  token: string;
  refreshToken: string;
  idToken: string;
}

const SESSION_KEY = "ct.session";

/** Keeps this app's own session alive across a hard reload of the
 * viewer tab (or a second, direct `goto` to another viewer URL within
 * it) -- without this, only the *first* load after a handoff from
 * admin-ui (see tokensFromHandoff below) would be authenticated; a
 * plain refresh would fall through to login-required with nothing to
 * restore, since a direct token exchange (ROPC, or this app's own
 * handoff consumption) never sets Keycloak's own SSO cookie the way an
 * interactive hosted-login redirect would have. Wrapped in try/catch:
 * private browsing or a locked-down browser can make localStorage
 * throw on read *or* write -- worst case is "sign in again", never a
 * crash. */
function readSession(): TokenSet | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as TokenSet) : null;
  } catch {
    return null;
  }
}
function writeSession(tokens: TokenSet): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(tokens));
  } catch {
    // Session still works for this tab; it just won't survive a reload.
  }
}
function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing to do -- see readSession's note.
  }
}

function renderApp() {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Missing #root element");

  // Empty by default (served at the domain root). A deployment that
  // mounts this app under a sub-path (e.g. a reverse proxy putting it
  // at /viewer alongside another app on the same origin) sets
  // VITE_BASE_PATH at build time -- see vite.config.ts's matching
  // `base`, which is what makes the emitted asset URLs agree with this.
  const basePath = (import.meta.env.VITE_BASE_PATH ?? "/").replace(/\/$/, "");
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <BrowserRouter basename={basePath}>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
}

function renderAuthError(message: string) {
  const rootElement = document.getElementById("root");
  if (rootElement) rootElement.innerHTML = `<p class="error" style="padding:2rem">${message}</p>`;
}

function startTokenRefreshLoop() {
  // Keep the token fresh; api/client.ts reads keycloak.token on every request.
  setInterval(() => {
    keycloak
      .updateToken(30)
      .then(() => {
        if (keycloak.token && keycloak.refreshToken && keycloak.idToken) {
          writeSession({ token: keycloak.token, refreshToken: keycloak.refreshToken, idToken: keycloak.idToken });
        }
      })
      .catch(() => {
        // The refresh was rejected (session gone). Forget the stored
        // copy first, or the reload after Keycloak's login would try to
        // restore it, fail, and reload once more for nothing.
        clearSession();
        keycloak.login();
      });
  }, 20000);
}

/** admin-ui's "Open in Viewer" link (CaseDetailPage.tsx's viewerUrl)
 * hands this app the caller's current session tokens in the URL
 * *fragment* -- never the query string or anywhere else a server
 * would log it. Consuming them here means someone already signed in
 * on admin-ui doesn't have to sign in again on this app's own,
 * separate Keycloak client: each app still ends up with its own
 * independent session, but the handoff makes opening the viewer feel
 * seamless instead of a second login screen. The fragment is stripped
 * from the address bar immediately once consumed, so it never lingers
 * in the URL or browser history. A direct or bookmarked visit (no
 * fragment) falls back to readSession(), and only then to this app's
 * own login-required redirect.
 *
 * Critical: keycloak-js's own OIDC callback (after a real
 * login-required redirect) *also* lands back with a fragment --
 * `#state=...&session_state=...&code=...` -- which its init() needs to
 * read to complete the login. Stripping the fragment unconditionally
 * here (an earlier version of this function did exactly that) deleted
 * that code before init() ever saw it, so every fresh sign-in looked
 * unauthenticated and redirected to Keycloak again, which redirected
 * right back with a new code, forever -- caught this from a runaway
 * loop that fired thousands of token requests in seconds. Only touch
 * the fragment (and only report a handoff) when it's actually ours. */
function tokensFromHandoff(): TokenSet | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("at");
  const refreshToken = params.get("rt");
  const idToken = params.get("it");
  if (!(token && refreshToken && idToken)) return null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return { token, refreshToken, idToken };
}

async function activate(tokens: TokenSet) {
  try {
    // checkLoginIframe off for the same reason admin-ui's own bootstrap
    // turns it off: the session-status iframe depends on third-party
    // cookies, blocked by default in current browsers.
    const authenticated = await keycloak.init({ ...tokens, pkceMethod: "S256", checkLoginIframe: false });
    if (!authenticated) {
      renderAuthError("Not authenticated.");
      return;
    }
    // A handed-off or restored access token may already be near expiry
    // -- mint a fresh one from the refresh token right away rather than
    // waiting for the first 20s refresh tick.
    await keycloak.updateToken(-1).catch(() => {});
    if (keycloak.token && keycloak.refreshToken && keycloak.idToken) {
      writeSession({ token: keycloak.token, refreshToken: keycloak.refreshToken, idToken: keycloak.idToken });
    }
    startTokenRefreshLoop();
    renderApp();
  } catch {
    // The handed-off or restored session was rejected outright -- e.g.
    // Keycloak answers "invalid_grant / Session not active" when the
    // underlying SSO session behind the refresh token is already gone
    // (logged out elsewhere, or simply timed out), which can happen
    // even though the JWTs themselves haven't reached their own `exp`
    // yet. Either way: clear it and fall back to a real login-required
    // redirect. keycloak.init() can only EVER be called once per
    // instance -- calling it again here (an earlier version of this
    // code did exactly that) throws "A 'Keycloak' instance can only be
    // initialized once" and leaves the page blank. A full reload is the
    // only valid way to retry: it re-runs this whole module fresh,
    // against a brand new Keycloak instance.
    clearSession();
    window.location.reload();
  }
}

const tokens = tokensFromHandoff() ?? readSession();

if (tokens) {
  void activate(tokens);
} else {
  keycloak
    // checkLoginIframe off, same reasoning as everywhere else it's
    // turned off in this codebase (see admin-ui's main.tsx): its
    // session-status iframe depends on third-party cookies, blocked by
    // default in current browsers, so it can't reliably tell whether
    // there's a live SSO session -- worse, a truly cookie-less first
    // visit (never having gone through admin-ui at all) could see it
    // retry the check indefinitely instead of ever reaching the login
    // form, since it can neither confirm nor rule out an existing
    // session.
    .init({ onLoad: "login-required", pkceMethod: "S256", checkLoginIframe: false })
    .then((authenticated) => {
      if (!authenticated) {
        renderAuthError("Not authenticated.");
        return;
      }
      startTokenRefreshLoop();
      renderApp();
    })
    .catch((error) => {
      renderAuthError(`Failed to reach Keycloak: ${String(error)}`);
    });
}
