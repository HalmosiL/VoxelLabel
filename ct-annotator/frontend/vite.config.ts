import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { host: "0.0.0.0", port: 5174 },
  // Mirrors main.tsx's BrowserRouter basename -- both need to agree on
  // where this app is actually mounted. Defaults to the root.
  base: process.env.VITE_BASE_PATH || "/",
});
