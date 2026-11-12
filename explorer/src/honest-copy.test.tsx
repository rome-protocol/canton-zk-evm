// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HelpLine, reportTime, StillStuck } from "./components/Help.tsx";
import { pageTitle } from "./components/Shell.tsx";
import { ACCOUNT_KEY_WORDS, SIGN_IN_NO_RECOVERY, SIGN_IN_SAME_ACCOUNT, TWINS_HOLDERS } from "./copy.ts";
import { noWalletWords, NO_WALLET, NO_WALLET_PHONE, onPhone } from "./wallet.ts";
import { plainWords } from "./bridge/words.ts";

describe("copy that must match the trust model", () => {
  it("does not say that only the wallet can move what the account holds, or that any device opens it", () => {
    for (const text of [ACCOUNT_KEY_WORDS, SIGN_IN_SAME_ACCOUNT, SIGN_IN_NO_RECOVERY, TWINS_HOLDERS]) expect(text).not.toMatch(/only your (MetaMask|key|wallet)|any device|cannot sign/i);
    expect(ACCOUNT_KEY_WORDS).toMatch(/Rome runs the node that hosts this account/);
    expect(ACCOUNT_KEY_WORDS).toMatch(/you trust Rome/);
    expect(TWINS_HOLDERS).toMatch(/Rome's participants/);
  });
  it("names no one wallet where any wallet works", () => {
    expect(NO_WALLET).toMatch(/wallet extension/);
    expect(NO_WALLET_PHONE).toMatch(/wallet app's own browser/);
    expect(NO_WALLET_PHONE).toMatch(/No phone wallet has been tested/);
  });
  it("says the phone's words only on a phone", () => {
    const phone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
    const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36";
    expect(onPhone(phone)).toBe(true);
    expect(onPhone("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36")).toBe(true);
    expect(onPhone(desktop)).toBe(false);
    expect(noWalletWords(phone)).toBe(NO_WALLET_PHONE);
    expect(noWalletWords(desktop)).toBe(NO_WALLET);
  });
  it("has a words for a wallet that now signs differently from before", () => {
    expect(plainWords({ name: "PageError", code: "second_account" })).toMatch(/signs differently/);
  });
});

describe("help", () => {
  it("links the docs and the issues in their own tab", () => {
    render(<HelpLine />);
    for (const [name, href] of [["Read the docs", "https://docs.rome.builders/canton-zk-evm/"], ["open an issue", "https://github.com/rome-protocol/canton-zk-evm/issues"]]) {
      const a = screen.getByRole("link", { name });
      expect(a).toHaveAttribute("href", href);
      expect(a).toHaveAttribute("target", "_blank");
      expect(a).toHaveAttribute("rel", "noopener noreferrer");
    }
  });
  it("quotes the time, in UTC, to the minute", () => {
    expect(reportTime(new Date("2026-11-11T14:05:59Z"))).toBe("2026-11-11 14:05 UTC");
    render(<StillStuck />);
    expect(screen.getByText(/Still stuck\?/)).toHaveTextContent(/quote \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  });
  it("keeps the time of the first error while the error is the same, and takes a new time for a different one", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-11T14:05:00Z"));
      const { rerender, container } = render(<StillStuck error="first" />);
      expect(container).toHaveTextContent("quote 2026-11-11 14:05 UTC");
      vi.setSystemTime(new Date("2026-11-11T14:09:00Z"));
      rerender(<StillStuck error="first" />);
      expect(container).toHaveTextContent("quote 2026-11-11 14:05 UTC");
      rerender(<StillStuck error="second" />);
      expect(container).toHaveTextContent("quote 2026-11-11 14:09 UTC");
    } finally { vi.useRealTimers(); }
  });
});

describe("page titles", () => {
  it("name the page and the site, so a signing page also shows which site is asking", () => {
    expect(pageTitle("/bridge", "Ostia", "DevNet")).toBe("Bridge · Ostia DevNet");
    expect(pageTitle("/faucet", "Ostia", "DevNet")).toBe("Faucet · Ostia DevNet");
    expect(pageTitle("/block/12", "Ostia", null)).toBe("Block · Ostia");
    expect(pageTitle("/blocks", "Ostia", null)).toBe("Blocks · Ostia");
    expect(pageTitle("/address/0x1", "Ostia", null)).toBe("Address · Ostia");
    expect(pageTitle("/docs/api", "Ostia", null)).toBe("API · Ostia");
    expect(pageTitle("/", "Ostia", "DevNet")).toBe("Ostia DevNet");
    expect(pageTitle("/nowhere", "Ostia", "DevNet")).toBe("Ostia DevNet");
  });
});
