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
  server: { host: "0.0.0.0", port: 5174 },
  // Mirrors main.tsx's BrowserRouter basename -- both need to agree on
  // where this app is actually mounted. Defaults to the root.
  base: process.env.VITE_BASE_PATH || "/",
});
