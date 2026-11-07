import { defineConfig } from "vitest/config";
import { bridgePins } from "./bridge-pins.ts";

// Server tests run in Node. A page test asks for the browser-like environment on its first line:
// // @vitest-environment jsdom
export default defineConfig({
  define: bridgePins(),
  test: {
    include: ["server/**/*.test.ts", "src/**/*.test.{ts,tsx}", "test/**/*.test.ts", "e2e/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
