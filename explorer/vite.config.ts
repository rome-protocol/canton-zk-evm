import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The server serves `dist`. While working on the pages, `npm run dev` serves them with the server's API (on its default port) behind it.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8088", "/healthz": "http://127.0.0.1:8088" } },
});
