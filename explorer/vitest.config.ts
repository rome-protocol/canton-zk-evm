import { defineConfig } from "vitest/config";

// Server tests run in Node. A page test asks for the browser-like environment on its first line:
// // @vitest-environment jsdom
export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "src/**/*.test.{ts,tsx}", "test/**/*.test.ts", "e2e/**/*.test.{ts,tsx}"],
    environment: "node",
    // The database tests are slow on the shared CI runners: each makes a database of its own, and with vitest's default 5 s the journal, api and api-indexed tests timed out there.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
