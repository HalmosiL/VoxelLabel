import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Unit tests for the viewer's pure logic (fill/histogram/plane math);
// the rendering surface itself is covered by the platform repo's e2e/
// specs (tutorial-*, viewer-*) driving a real browser.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
