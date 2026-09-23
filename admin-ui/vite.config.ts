import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

/** The build every usage event is stamped with (see src/usage/tracker.ts):
 * APP_VERSION when the build provides one (CI passes the commit),
 * otherwise package.json's version plus the build's UTC minute -- so
 * every build is distinguishable even when nobody bumps the version. */
function appVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION.slice(0, 40);
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `${pkg.version}+${stamp}`;
}

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
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
