import { defineConfig } from "vitest/config";

// Server tests run in Node. A page test asks for the browser-like environment on its first line:
// // @vitest-environment jsdom
export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "src/**/*.test.{ts,tsx}", "test/**/*.test.ts", "e2e/**/*.test.tsx"],
    environment: "node",
  },
});
