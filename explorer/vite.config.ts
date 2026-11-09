import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { bridgePins } from "./bridge-pins.ts";

// The server serves `dist`. While working on the pages, `npm run dev` serves them with the server's API (on its default port) behind it.
export default defineConfig({
  plugins: [react()],
  define: bridgePins(),
  // The dApp SDK imports an optional package (WalletConnect) that is not installed and not used here: it gets a stand-in (src/bridge/wallet/walletconnect-stub.ts), so that the SDK's script loads.
  resolve: { alias: { "@walletconnect/sign-client": fileURLToPath(new URL("./src/bridge/wallet/walletconnect-stub.ts", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8088", "/healthz": "http://127.0.0.1:8088" } },
});
