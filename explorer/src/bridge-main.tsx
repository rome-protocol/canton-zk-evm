import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { BridgeApp } from "./bridge-app/BridgeApp.tsx";
import "./styles.css";

// The Bridge's own site (bridge.html): the same providers as the explorer's (main.tsx) around the app's frame. No retries: a failed read shows its plain message at once.
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <BridgeApp />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
