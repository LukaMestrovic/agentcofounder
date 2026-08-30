import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    passWithNoTests: false,
    // A journey test drives the whole UI through userEvent, which types character by character with
    // a real delay per key. The 5s default expires mid-journey and reports a timeout that looks like
    // a product bug, costing repair sessions to a suite that was never wrong.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["./src/test/setup.ts"],
  },
});
