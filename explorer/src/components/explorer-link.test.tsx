// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExplorerLink } from "./ExplorerLink.tsx";

const SITE = "https://ostia.testnet.romeprotocol.xyz";
afterEach(() => { cleanup(); vi.unstubAllEnvs(); document.documentElement.removeAttribute("data-app"); });
const show = () => render(<MemoryRouter><ExplorerLink to="/tx/0x1" className="small">the move</ExplorerLink></MemoryRouter>);

describe("a link to an explorer page", () => {
  it("is the router's own link in the explorer", () => {
    show();
    const link = screen.getByRole("link", { name: "the move" });
    expect(link).toHaveAttribute("href", "/tx/0x1");
    expect(link).not.toHaveAttribute("target");
    expect(link).toHaveClass("small");
  });

  it("is a link to the explorer's address in a new tab, with the outside mark, in the Bridge's own site", () => {
    vi.stubEnv("VITE_SITE_ORIGIN", SITE);
    document.documentElement.setAttribute("data-app", "bridge");
    show();
    const link = screen.getByRole("link", { name: "the move" });
    expect(link).toHaveAttribute("href", `${SITE}/tx/0x1`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
    expect(link).toHaveClass("small", "out");
    expect(link.querySelector("svg.ic")).not.toBeNull();
  });
});
