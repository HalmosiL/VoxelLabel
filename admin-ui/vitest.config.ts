import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Unit tests for the pieces with real logic in them (auth handoff,
// error wording, the tour engine, the sign-in/register form). Pages
// that are mostly data plumbing are covered end to end by e2e/ instead.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify("test") },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
