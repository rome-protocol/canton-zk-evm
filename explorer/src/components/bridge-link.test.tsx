// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeLink } from "./BridgeLink.tsx";

const APP = "https://bridge.ostia.testnet.romeprotocol.xyz";
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
const show = () => render(<MemoryRouter><BridgeLink className="navlink" search="?tab=other-chains">Bridge</BridgeLink></MemoryRouter>);

describe("a link to the Bridge", () => {
  it("is the router's link to /bridge, which says there is no address, when no origin is set", () => {
    show();
    const link = screen.getByRole("link", { name: "Bridge" });
    expect(link).toHaveAttribute("href", "/bridge?tab=other-chains");
    expect(link).not.toHaveAttribute("target");
    expect(link).toHaveClass("navlink");
  });

  it("opens the Bridge's own site in a new tab, with the outside mark, once it has one", () => {
    vi.stubEnv("VITE_BRIDGE_ORIGIN", APP);
    show();
    const link = screen.getByRole("link", { name: "Bridge" });
    expect(link).toHaveAttribute("href", `${APP}/?tab=other-chains`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
    expect(link).toHaveClass("navlink", "out");
    expect(link.querySelector("svg.ic")).not.toBeNull();
  });
});
