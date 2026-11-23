import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { withSiteMeta } from "./site-meta.ts";

// The server serves `dist`. While working on the pages, `npm run dev` serves them with the server's API (on its default port) behind it.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // The network's name and the origin in index.html (site-meta.ts): from VITE_NETWORK_NAME and VITE_SITE_ORIGIN.
    { name: "site-meta", transformIndexHtml: { order: "pre", handler: (html: string) => withSiteMeta(html, loadEnv(mode, process.cwd(), "VITE_")) } },
  ],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8088", "/healthz": "http://127.0.0.1:8088" } },
}));
