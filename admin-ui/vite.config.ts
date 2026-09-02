import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Relative, not the Vite default of absolute "/assets/..." -- the app
  // is always served from its origin's root either way (nginx today),
  // so this changes nothing there, but it makes the built dist/ folder
  // itself relocatable: the clinician-app Electron shell serves this
  // same dist/ from its own local static server (a plain file:// load
  // would seem simpler, but Keycloak's own redirect handling throws on
  // a host-less file:// redirect_uri -- see clinician-app/static-
  // server.js), and relative asset paths are what let that work without
  // needing to know in advance what port it'll be served from.
  base: "./",
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
});
