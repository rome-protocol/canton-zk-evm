import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { bridgePins } from "./bridge-pins.ts";

// Server tests run in Node. A page test asks for the browser-like environment on its first line:
// // @vitest-environment jsdom
export default defineConfig({
  define: bridgePins(),
  // The dApp SDK imports an optional package (WalletConnect) that is not installed: the tests that load the SDK get a stand-in for it (src/bridge/wallet/walletconnect-stub.ts).
  resolve: { alias: { "@walletconnect/sign-client": fileURLToPath(new URL("./src/bridge/wallet/walletconnect-stub.ts", import.meta.url)) } },
  test: {
    server: { deps: { inline: [/@canton-network\/dapp-sdk/] } },
    include: ["server/**/*.test.ts", "src/**/*.test.{ts,tsx}", "test/**/*.test.ts", "e2e/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
