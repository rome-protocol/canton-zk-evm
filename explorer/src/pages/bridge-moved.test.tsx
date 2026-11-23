// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeMoved } from "./BridgeMoved.tsx";

const APP = "https://bridge.ostia.testnet.romeprotocol.xyz";
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
function show(at: string) {
  const go = vi.fn();
  render(<MemoryRouter initialEntries={[at]}><BridgeMoved go={go} /></MemoryRouter>);
  return go;
}

describe("the explorer's /bridge address", () => {
  it("goes at once to the same view on the Bridge's site, with the query and the hash kept", async () => {
    vi.stubEnv("VITE_BRIDGE_ORIGIN", APP);
    const go = show("/bridge?tab=other-chains#top");
    await waitFor(() => expect(go).toHaveBeenCalledOnce());
    expect(go).toHaveBeenCalledWith(`${APP}/?tab=other-chains#top`);
  });

  it("goes to the root with nothing added when the address has no query", async () => {
    vi.stubEnv("VITE_BRIDGE_ORIGIN", APP);
    const go = show("/bridge");
    await waitFor(() => expect(go).toHaveBeenCalledWith(`${APP}/`));
  });

  it("goes nowhere, and says so, in a build with no Bridge origin", () => {
    const go = show("/bridge");
    expect(screen.getByText("The Bridge is its own site")).toBeInTheDocument();
    expect(go).not.toHaveBeenCalled();
  });
});
