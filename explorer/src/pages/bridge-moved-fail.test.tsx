// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeMoved } from "./BridgeMoved.tsx";

vi.mock("../bridge/unfinished.ts", () => { throw new Error("chunk failed to load"); });
const APP = "https://bridge.ostia.testnet.romeprotocol.xyz";
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("the explorer's /bridge address when the check's code cannot be fetched", () => {
  it("shows the page here, with the line that says where the Bridge is, and does not redirect or wait for ever", async () => {
    vi.stubEnv("VITE_BRIDGE_ORIGIN", APP);
    const go = vi.fn();
    render(<MemoryRouter initialEntries={["/bridge?tab=other-chains"]}><BridgeMoved go={go}><p>the Bridge page</p></BridgeMoved></MemoryRouter>);
    expect(await screen.findByText("the Bridge page")).toBeInTheDocument();
    expect(screen.queryByText("Opening the Bridge…")).toBeNull();
    expect(screen.getByRole("link", { name: "Open the Bridge" })).toHaveAttribute("href", `${APP}/?tab=other-chains`);
    expect(go).not.toHaveBeenCalled();
  });
});
