// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Label, TokenMove } from "../api.ts";
import { useLabels } from "../labels.ts";
import { addr, fakeApi, reply } from "../test-utils.tsx";
import { AddressCell } from "./AddressCell.tsx";
import { Amount, TokenChip } from "./Amount.tsx";
import { ICON_NAMES } from "./Icon.tsx";

const usd: Label = { address: addr(0xcb), name: "Test USD", symbol: "tUSD", kind: "token", standard: "ERC-20", decimals: 6, verified: true };
const pass: Label = { address: addr(0xe3), name: "Ostia Pass", symbol: "OPASS", kind: "token", standard: "ERC-721", decimals: null, verified: true };
const move = (over: Partial<TokenMove> = {}): TokenMove => ({ token: usd.address, amount: "100000000", tokenId: null, standard: "ERC-20", decimals: 6, ...over });
const cell = (a: string, label?: Label, to?: string) => render(<MemoryRouter><AddressCell address={a} label={label} to={to} /></MemoryRouter>);

describe("an address cell", () => {
  it("shows a token by its name and symbol, with a document icon and a verified check, and links to the token", () => {
    const { container } = cell(usd.address, usd);
    expect(screen.getByRole("link", { name: "Test USD (tUSD)" })).toHaveAttribute("href", `/token/${usd.address}`);
    expect(screen.getByRole("img", { name: "Verified" })).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("link")).toHaveAttribute("title", usd.address);
  });

  it("shows a contract by its name and links to the contract", () => {
    cell(addr(0xd1), { address: addr(0xd1), name: "Disperse", symbol: null, kind: "contract", standard: null, decimals: null, verified: true });
    expect(screen.getByRole("link", { name: "Disperse" })).toHaveAttribute("href", `/contract/${addr(0xd1)}`);
  });

  it("gives no check to a name whose source is not verified", () => {
    cell(usd.address, { ...usd, verified: false });
    expect(screen.getByRole("link", { name: "Test USD (tUSD)" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Verified" })).toBeNull();
  });

  it("shows the short address when the label has no name, when there is no label, and for an account", () => {
    const a = addr(0x57);
    for (const label of [undefined, { ...usd, address: a, name: null, symbol: null, kind: null, verified: false } as Label, { ...usd, address: a, name: null, symbol: null, kind: "account", verified: false } as Label]) {
      const { unmount } = cell(a, label);
      expect(screen.getByRole("link", { name: "0x575757…5757" })).toHaveAttribute("href", `/address/${a}`);
      expect(screen.queryByRole("img", { name: "Verified" })).toBeNull();
      unmount();
    }
  });

  it("is the address's own link unless the page says where it leads", () => {
    cell(usd.address, usd, "/somewhere");
    expect(screen.getByRole("link")).toHaveAttribute("href", "/somewhere");
  });

  it("finds the label of a mixed-case address through useLabels, which is what a page passes in", async () => {
    fakeApi((path) => reply({ items: new URL(path, "http://x").searchParams.get("addresses")!.split(",").map((a) => (a === usd.address ? usd : { ...usd, address: a, name: null, symbol: null, kind: null })) }));
    const mixed = "0x" + usd.address.slice(2).toUpperCase();
    function Row() {
      const labels = useLabels([mixed]);
      return <AddressCell address={mixed} label={labels.get(mixed)} />;
    }
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Row /></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole("link", { name: "Test USD (tUSD)" })).toBeInTheDocument());
  });

  it("isolates a name's direction and keeps the whole name in its tooltip, so a hostile name cannot reorder the text beside it", () => {
    const hostile = "\u202eEvil".padEnd(300, "x");
    const { container } = cell(usd.address, { ...usd, name: hostile, symbol: null });
    const name = container.querySelector(".acell .aname")!;
    expect(name.querySelector("bdi")).not.toBeNull();
    expect(name.getAttribute("title")).toBe(hostile);
  });
});

describe("a token amount chip", () => {
  it("shows a fungible amount in whole tokens with the symbol, and its exact value in the tooltip", () => {
    render(<TokenChip move={move()} label={usd} />);
    const chip = screen.getByText("100 tUSD");
    expect(chip.closest(".tchip")).toHaveAttribute("title", "100 tUSD");
  });

  it("groups thousands", () => {
    render(<TokenChip move={move({ amount: "5000000000" })} label={usd} />);
    expect(screen.getByText("5,000 tUSD")).toBeInTheDocument();
  });

  it("shows a token id as 'OPASS #3'", () => {
    render(<TokenChip move={move({ token: pass.address, amount: null, tokenId: "3", standard: "ERC-721", decimals: null })} label={pass} />);
    expect(document.querySelector(".tname")!.textContent).toBe("OPASS #3");
  });

  it("shows the number of a many-copies token before its id, and says nothing of one copy", () => {
    const { unmount } = render(<TokenChip move={move({ token: pass.address, amount: "5", tokenId: "3", standard: "ERC-1155", decimals: null })} label={{ ...pass, standard: "ERC-1155" }} />);
    expect(document.querySelector(".tname")!.textContent).toBe("5 × OPASS #3");
    unmount();
    render(<TokenChip move={move({ token: pass.address, amount: "1", tokenId: "3", standard: "ERC-1155", decimals: null })} label={{ ...pass, standard: "ERC-1155" }} />);
    expect(document.querySelector(".tname")!.textContent).toBe("OPASS #3");
  });

  it("names a token it has no label for by its short address, and says so", () => {
    render(<TokenChip move={move({ token: addr(0x77) })} />);
    const chip = screen.getByText("100 0x777777…7777").closest(".tchip")!;
    expect(chip.getAttribute("title")).toMatch(/name of this token is not known/i);
  });

  it("takes the decimals from the label when the move has none", () => {
    render(<TokenChip move={move({ decimals: null })} label={usd} />);
    expect(screen.getByText("100 tUSD")).toBeInTheDocument();
  });

  it("shows the raw count, and says why, when the decimals are not known", () => {
    render(<TokenChip move={move({ amount: "1500000", decimals: null })} label={{ ...usd, decimals: null }} />);
    const chip = screen.getByText("1,500,000 tUSD").closest(".tchip")!;
    expect(chip.getAttribute("title")).toMatch(/decimals are not known/i);
    expect(chip.getAttribute("title")).toMatch(/smallest unit/i);
    expect(chip.getAttribute("title")).toMatch(/^1,500,000 tUSD /); // the exact count is on hover too
  });

  it("does not show an amount the logs did not carry", () => {
    render(<TokenChip move={move({ amount: null, tokenId: null })} label={usd} />);
    expect(screen.getByText("tUSD").closest(".tchip")!.getAttribute("title")).toMatch(/amount is not in the logs/i);
  });
});

describe("a long token id and name in a chip", () => {
  const id = "9".repeat(78);
  it("shortens a 78-digit token id and keeps the whole id in the tooltip", () => {
    render(<TokenChip move={move({ token: pass.address, amount: null, tokenId: id, standard: "ERC-721", decimals: null })} label={pass} />);
    const chip = screen.getByText(/OPASS/).closest(".tchip")!;
    expect(chip.textContent).toBe("OPASS #999999…9999");
    expect(chip.getAttribute("title")).toContain(id);
  });
  it("keeps the symbol in its own bidi-isolated element", () => {
    const { container } = render(<TokenChip move={move()} label={{ ...usd, symbol: "\u202eEVIL" }} />);
    expect(container.querySelector(".tchip bdi.tname")?.textContent).toBe("100 \u202eEVIL");
  });
});

describe("the cells' styles", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "styles.css"), "utf8");
  const rule = (sel: string) => css.split("\n").find((l) => l.startsWith(sel + " {")) ?? "";
  it("cuts a long name short with an ellipsis, and isolates its direction", () => {
    for (const sel of [".acell .aname", ".tchip .tname"]) {
      const r = rule(sel);
      expect(r, sel).toMatch(/max-width:\s*[\d.]+(ch|px|em|rem)/);
      expect(r, sel).toMatch(/overflow:\s*hidden/);
      expect(r, sel).toMatch(/text-overflow:\s*ellipsis/);
      expect(r, sel).toMatch(/unicode-bidi:\s*isolate/);
    }
  });
});

describe("the icons the cells use", () => {
  it("has the funnel and the coin", () => {
    expect(ICON_NAMES).toContain("funnel");
    expect(ICON_NAMES).toContain("coin");
  });
});

describe("an amount", () => {
  it("sets the symbol apart in its own bdi", () => {
    const { container } = render(<Amount raw="5000000" decimals={6} symbol={"\u202Eevil"} />);
    expect([...container.querySelectorAll("bdi")].map((b) => b.textContent)).toEqual(["\u202Eevil"]);
  });
});

describe("a token chip with a hostile symbol", () => {
  const evil = { ...pass, symbol: "\u202EOPASS" };
  it("keeps the token id outside the symbol's bdi, so the symbol cannot reorder it", () => {
    const { container } = render(<TokenChip move={move({ token: pass.address, amount: null, tokenId: "12", standard: "ERC-721", decimals: null })} label={evil} />);
    const bdis = [...container.querySelectorAll("bdi")];
    expect(bdis.map((b) => b.textContent)).toEqual(["\u202EOPASS"]);
    const wrap = container.querySelector(".tname")!;
    expect(wrap.textContent).toBe("\u202EOPASS #12");
    expect(bdis[0]!.textContent).not.toContain("#12");
  });

  it("keeps the number of copies and the amount outside the symbol's bdi", () => {
    const { container } = render(<TokenChip move={move({ token: pass.address, amount: "5", tokenId: "12", standard: "ERC-1155", decimals: null })} label={evil} />);
    expect(container.querySelector(".tname")!.textContent).toBe("5 \u00D7 \u202EOPASS #12");
    expect(container.querySelector("bdi")!.textContent).toBe("\u202EOPASS");
  });
});
