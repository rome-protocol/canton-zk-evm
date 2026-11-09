import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { bridgePins } from "./bridge-pins.ts";
import { walletsFromEnv } from "./src/bridge/wallet/wallets.ts";

// The server serves `dist`. While working on the pages, `npm run dev` serves them with the server's API (on its default port) behind it.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // __WALLET_LOOP__: true only when the build's switch (VITE_CANTON_WALLETS, from the environment or an env file) lists "loop". Loop's library has no licence, so its code is in a build only then (connect.ts).
  define: { ...bridgePins(), __WALLET_LOOP__: JSON.stringify(walletsFromEnv(loadEnv(mode, process.cwd(), "VITE_")).wallets.includes("loop")) },
  // The dApp SDK imports an optional package (WalletConnect) that is not installed and not used here: it gets a stand-in (src/bridge/wallet/walletconnect-stub.ts), so that the SDK's script loads.
  resolve: { alias: { "@walletconnect/sign-client": fileURLToPath(new URL("./src/bridge/wallet/walletconnect-stub.ts", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8088", "/healthz": "http://127.0.0.1:8088" } },
}));
