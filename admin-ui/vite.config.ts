import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Root-absolute asset URLs (the Vite default). This must NOT be a
  // relative "./" base: nginx (and clinician-app's static server) serve
  // the SPA with an index.html fallback for every client-side route, so
  // on a deep route like /studies/<id> a relative "./assets/x.js" would
  // resolve to /studies/assets/x.js, get the index.html fallback back
  // as text/html, and fail the module load -- a blank page on every
  // direct visit/refresh of a nested route. Both servers serve dist/
  // from their origin's root, so "/assets/..." resolves correctly
  // everywhere, including inside the Electron shell (which serves over
  // http://127.0.0.1:<port>/, never file://).
  base: "/",
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
});
