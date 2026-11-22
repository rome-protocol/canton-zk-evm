// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveCheckpoint, type StoreLike } from "../bridge/moves/state.ts";
import { BridgeMoved } from "./BridgeMoved.tsx";

const APP = "https://bridge.ostia.testnet.romeprotocol.xyz";
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
const memory = (): StoreLike => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
const kept = () => {
  const store = memory();
  saveCheckpoint(store, { input: { kind: "lock", asset: ("0x" + "a1".repeat(20)) as `0x${string}`, amount: "1", receiver: "party::1" }, ref: "r1", account: ("0x" + "e3".repeat(20)) as `0x${string}`, party: "party::1", vault: ("0x" + "cd".repeat(20)) as `0x${string}`, stage: "sent", at: Date.now() });
  return store;
};
function show(at: string, store: StoreLike | null) {
  const go = vi.fn();
  render(<MemoryRouter initialEntries={[at]}><BridgeMoved store={store} go={go}><p>the Bridge page</p></BridgeMoved></MemoryRouter>);
  return go;
}

describe("the explorer's /bridge address", () => {
  it("is the Bridge page, as it was, while the Bridge has no site of its own", () => {
    const go = show("/bridge?tab=other-chains", kept());
    expect(screen.getByText("the Bridge page")).toBeInTheDocument();
    expect(screen.queryByText(/has its own site/)).toBeNull();
    expect(go).not.toHaveBeenCalled();
  });

  it("goes at once to the same view on the Bridge's site, with the query and the hash kept, when this browser keeps no move that is not over", async () => {
    vi.stubEnv("VITE_BRIDGE_ORIGIN", APP);
    const go = show("/bridge?tab=other-chains#top", memory());
    await waitFor(() => expect(go).toHaveBeenCalledOnce());
    expect(go).toHaveBeenCalledWith(`${APP}/?tab=other-chains#top`);
    expect(screen.queryByText("the Bridge page")).toBeNull();
  });

  it("goes to the root with nothing added when the address has no query", async () => {
    vi.stubEnv("VITE_BRIDGE_ORIGIN", APP);
    const go = show("/bridge", null);
    await waitFor(() => expect(go).toHaveBeenCalledWith(`${APP}/`));
  });

  it("stays, shows the page and says where the Bridge is, when a move kept here is not over", async () => {
    vi.stubEnv("VITE_BRIDGE_ORIGIN", APP);
    const go = show("/bridge?tab=other-chains", kept());
    expect(await screen.findByText("the Bridge page")).toBeInTheDocument();
    expect(go).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("The Bridge has its own site now. Moves you started on this page finish here.");
    const link = screen.getByRole("link", { name: "Open the Bridge" });
    expect(link).toHaveAttribute("href", `${APP}/?tab=other-chains`);
    expect(link).toHaveAttribute("target", "_blank");
  });
});
