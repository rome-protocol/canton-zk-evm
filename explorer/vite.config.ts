import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { bridgePins } from "./bridge-pins.ts";
import { withSiteMeta } from "./site-meta.ts";
import { bridgeAccountFromEnv } from "./src/bridge/canton/env.ts";
import { walletsFromEnv } from "./src/bridge/wallet/wallets.ts";

// The server serves `dist`. While working on the pages, `npm run dev` serves them with the server's API (on its default port) behind it.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // The network's name and the origins in index.html and bridge.html (site-meta.ts): from VITE_NETWORK_NAME, VITE_SITE_ORIGIN and VITE_BRIDGE_ORIGIN, as the Bridge's settings are.
    { name: "site-meta", transformIndexHtml: { order: "pre", handler: (html: string) => withSiteMeta(html, loadEnv(mode, process.cwd(), "VITE_")) } },
  ],
  // __WALLET_LOOP__: true only when the build's switch (VITE_CANTON_WALLETS, from the environment or an env file) lists "loop". Loop's library has no licence, so its code is in a build only then (connect.ts).
  // __BRIDGE_ACCOUNT__: true only when the build's switch (VITE_BRIDGE_ACCOUNT=on) is on. In every other build the Bridge account's code (the key made from a wallet signature, the kept-key store, the account service's client) is not in the pages: the `import()`s of it (src/bridge/derived.ts) go with their branch.
  define: {
    ...bridgePins(),
    __WALLET_LOOP__: JSON.stringify(walletsFromEnv(loadEnv(mode, process.cwd(), "VITE_")).wallets.includes("loop")),
    __BRIDGE_ACCOUNT__: JSON.stringify(bridgeAccountFromEnv(loadEnv(mode, process.cwd(), "VITE_"))),
  },
  // The dApp SDK imports an optional package (WalletConnect) that is not installed and not used here: it gets a stand-in (src/bridge/wallet/walletconnect-stub.ts), so that the SDK's script loads.
  resolve: { alias: { "@walletconnect/sign-client": fileURLToPath(new URL("./src/bridge/wallet/walletconnect-stub.ts", import.meta.url)) } },
  // Two entries from one code base: the explorer (index.html) and the Bridge's own site (bridge.html, src/bridge-main.tsx). Vite shares the common chunks between them.
  build: { outDir: "dist", emptyOutDir: true, rollupOptions: { input: { main: "index.html", bridge: "bridge.html" } } },
  server: { proxy: { "/api": "http://127.0.0.1:8088", "/healthz": "http://127.0.0.1:8088" } },
}));
