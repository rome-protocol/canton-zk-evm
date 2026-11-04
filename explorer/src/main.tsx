import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import "./styles.css";

// No retries: a failed read shows its plain message at once, and the pages that follow the chain ask again by themselves.
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

// A page's script that cannot be fetched (the site was updated while the tab was open) is fetched again by loading the site once; the mark keeps that from looping.
window.addEventListener("vite:preloadError", () => {
  try {
    if (sessionStorage.getItem("preload-reloaded")) return;
    sessionStorage.setItem("preload-reloaded", "1");
    window.location.reload();
  } catch { /* storage is blocked: the error card stands */ }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
