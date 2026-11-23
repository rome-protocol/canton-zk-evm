// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackRows } from "./BackRows.tsx";
import type { Back, BackRow } from "./useBack.ts";

const SITE = "https://ostia.testnet.romeprotocol.xyz";
const HASH = "0x" + "70".repeat(32);
afterEach(() => { cleanup(); vi.unstubAllEnvs(); document.documentElement.removeAttribute("data-app"); });
const item = { row: { id: "r1", at: 0, episode: { txHash: HASH } }, view: { title: "Back to Canton", word: "on its way", steps: [], sends: [], notes: [], actions: [], phase: "sent", open: false, marksOf: null } } as unknown as BackRow;
const back = { busy: null, messages: {}, act: () => {}, giveUp: () => {} } as unknown as Back;
const show = () => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><BackRows items={[item]} back={back} faucet={null} /></MemoryRouter></QueryClientProvider>);

describe("the link to the move on Ostia in the way back to Canton", () => {
  it("is the router's own link in the explorer", () => {
    show();
    const link = screen.getByRole("link", { name: /The move on Ostia/ });
    expect(link).toHaveAttribute("href", `/tx/${HASH}`);
    expect(link).not.toHaveAttribute("target");
  });

  it("opens the explorer in a new tab in the Bridge's own site", () => {
    vi.stubEnv("VITE_SITE_ORIGIN", SITE);
    document.documentElement.setAttribute("data-app", "bridge");
    show();
    const link = screen.getByRole("link", { name: /The move on Ostia/ });
    expect(link).toHaveAttribute("href", `${SITE}/tx/${HASH}`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
  });
});
