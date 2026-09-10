import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { MeProvider } from "./auth/MeContext";
import keycloak from "./keycloak";
import "./styles.css";

function renderApp() {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Missing #root element");

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <BrowserRouter>
        <MeProvider>
          <App />
        </MeProvider>
      </BrowserRouter>
    </React.StrictMode>
  );
}

function renderAuthError(message: string) {
  const rootElement = document.getElementById("root");
  if (rootElement) rootElement.innerHTML = `<p class="error" style="padding:2rem">${message}</p>`;
}

// Keep the token fresh; api/client.ts reads keycloak.token on every
// request. In the clinician-app shell, also re-persist the (rotated)
// refresh token on every successful renewal -- otherwise the *next*
// app launch would try to restore a session with an already-superseded
// refresh token and fail.
function startTokenRefreshLoop() {
  setInterval(() => {
    keycloak
      .updateToken(30)
      .then(() => {
        const session = window.clinicianSession;
        if (session && keycloak.token && keycloak.refreshToken && keycloak.idToken) {
          session.saveSession({ token: keycloak.token, refreshToken: keycloak.refreshToken, idToken: keycloak.idToken });
        }
      })
      .catch(() => keycloak.login());
  }, 20000);
}

async function bootstrap() {
  const session = window.clinicianSession;
  const saved = session ? await session.getSession() : null;

  try {
    // checkLoginIframe is off in both branches: the session-status iframe
    // depends on third-party cookies (blocked by default in current
    // browsers), so it can't reliably detect anything -- and it fired an
    // aborted request on every page load. Token refresh (below) is what
    // actually keeps the session alive.
    // With a saved session, hand keycloak-js the (possibly already-
    // expired) token set it had at last launch rather than forcing a
    // fresh login-required redirect -- this is keycloak-js's own
    // documented pattern for restoring a session across reloads: it
    // decodes what it's given to know whether/when it expired, then an
    // immediate updateToken() below mints a live access token from the
    // still-valid refresh token, all without ever showing a login page.
    const authenticated = await keycloak.init(
      saved
        ? { token: saved.token, refreshToken: saved.refreshToken, idToken: saved.idToken, pkceMethod: "S256", checkLoginIframe: false }
        : { onLoad: "login-required", pkceMethod: "S256", checkLoginIframe: false }
    );

    if (saved) {
      await keycloak.updateToken(-1);
    }

    if (!authenticated) {
      renderAuthError("Not authenticated.");
      return;
    }

    if (session && keycloak.token && keycloak.refreshToken && keycloak.idToken) {
      await session.saveSession({ token: keycloak.token, refreshToken: keycloak.refreshToken, idToken: keycloak.idToken });
    }

    startTokenRefreshLoop();
    renderApp();
  } catch (error) {
    if (saved) {
      // The saved session was rejected outright (refresh token expired
      // or revoked) -- clear it and reload to fall back to a real
      // login-required flow. keycloak.init() can only ever be called
      // once per Keycloak instance, so a plain reload (not a second
      // init call on this same instance) is how that retry happens.
      await session?.clearSession();
      window.location.reload();
      return;
    }
    renderAuthError(`Failed to reach Keycloak: ${String(error)}`);
  }
}

bootstrap();
