import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import keycloak from "./keycloak";
import "./styles.css";

function renderApp() {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Missing #root element");

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
}

function renderAuthError(message: string) {
  const rootElement = document.getElementById("root");
  if (rootElement) rootElement.innerHTML = `<p class="error" style="padding:2rem">${message}</p>`;
}

keycloak
  .init({ onLoad: "login-required", pkceMethod: "S256" })
  .then((authenticated) => {
    if (!authenticated) {
      renderAuthError("Not authenticated.");
      return;
    }

    // Keep the token fresh; api/client.ts reads keycloak.token on every request.
    setInterval(() => {
      keycloak.updateToken(30).catch(() => keycloak.login());
    }, 20000);

    renderApp();
  })
  .catch((error) => {
    renderAuthError(`Failed to reach Keycloak: ${String(error)}`);
  });
