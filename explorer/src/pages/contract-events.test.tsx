// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, toEventSelector } from "viem";
import type { ContractEvent } from "../api.ts";
import { addr, contractSource, hash, page, unverifiedSource } from "../test-utils.tsx";
import { open, TOKEN_ABI } from "./contract-harness.tsx";

const A = addr(0xcb), ME = addr(0xe3), YOU = addr(0xe6);
const SIG = "Transfer(address,address,uint256)";
const ABI = [...TOKEN_ABI, { type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] }];
const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
const log = (n: number, over: Partial<ContractEvent> = {}): ContractEvent => ({
  txHash: hash(n), block: 20 - n, txIndex: 0, logIndex: n, timestamp: 1_760_000_000 - n, address: A, topics: [toEventSelector(SIG), pad(ME), pad(YOU)],
  data: encodeAbiParameters([{ type: "uint256" }], [BigInt(n) * 100n]), method: "0xa9059cbb", creation: false, ...over,
});
const verified = { [A]: contractSource(0xcb, { abi: ABI }) };
afterEach(() => vi.unstubAllGlobals());

describe("the contract page: Events", () => {
  it("shows each log in the words of its event, with the method that wrote it, and links the addresses", async () => {
    await open("events", { sources: verified, events: () => page([log(1)]) });
    const row = (await screen.findByRole("link", { name: new RegExp(`^${ME.slice(0, 8)}`) })).closest("tr")!;
    expect(within(row).getByText("Transfer")).toBeInTheDocument();
    expect(within(row).getByText("transfer")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: new RegExp(`^${ME.slice(0, 8)}`) })).toHaveAttribute("href", `/address/${ME}`);
    expect(within(row).getByText("100")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "19" })).toHaveAttribute("href", "/block/19");
  });

  it("names a contract-creation transaction \"Create contract\", not the first bytes of its init code", async () => {
    await open("events", { sources: verified, events: () => page([log(3, { method: null, creation: true }), log(4, { method: "0xa9059cbb" })]) });
    const rows = await screen.findAllByRole("row");
    const created = rows.find((r) => within(r).queryByText("Create contract"))!;
    expect(created).toBeDefined();
    expect(within(created).getByText("Create contract")).toHaveClass("tag", "method");
    expect(within(created).queryByText("—")).toBeNull();
    expect(screen.getAllByText("Create contract")).toHaveLength(1);
  });

  it("opens with the standard card header: the title with its words inline, and the Filter by topic button in outline style", async () => {
    await open("events", { sources: verified, events: () => page([log(1)]) });
    const card = screen.getByRole("region", { name: "Events" });
    const h = card.querySelector(".card-head")!;
    expect(h).not.toBeNull();
    expect(within(h as HTMLElement).getByRole("heading", { level: 2, name: "Events" }).parentElement!.querySelector(".muted")).not.toBeNull();
    const filter = screen.getByRole("button", { name: /Filter by topic/ });
    expect(filter).toHaveClass("btn-line");
    expect(filter).not.toHaveClass("btn");
  });

  it("says a log is not decoded while the source is not verified, and shows the raw topics and data", async () => {
    await open("events", { sources: { [A]: unverifiedSource() }, events: () => page([log(2, { method: null })]) });
    expect(await screen.findByText("Not decoded")).toBeInTheDocument();
    expect(screen.getByText(/2 indexed, data 0x/)).toBeInTheDocument();
    expect(screen.getByText(/shown raw while the source is not verified/)).toBeInTheDocument();
  });

  it("asks the API for only one kind of event when its button is pressed", async () => {
    const paths: string[] = [];
    await open("events", { sources: verified, events: (p) => { paths.push(p); return page([log(1)]); } });
    await userEvent.click(await screen.findByRole("button", { name: "Transfer" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Transfer" })).toHaveAttribute("aria-pressed", "true"));
    expect(paths.some((p) => p.includes(`topic0=${toEventSelector(SIG)}`))).toBe(true);
  });

  it("opens the first page of a new kind of event after paging forward", async () => {
    const paths: string[] = [];
    await open("events", { sources: verified, events: (p) => { paths.push(p); return page([log(1)], p.includes("before=") ? null : "19:0:1"); } });
    await userEvent.click(await screen.findByRole("button", { name: "Older page" }));
    await waitFor(() => expect(screen.getByText("Page 2")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Transfer" }));
    await waitFor(() => expect(paths.some((p) => p.includes("topic0=") && !p.includes("before="))).toBe(true));
    expect(paths.some((p) => p.includes("topic0=") && p.includes("before="))).toBe(false);
    await waitFor(() => expect(screen.getByText("Page 1")).toBeInTheDocument());
  });

  it("filters by a typed topic, and refuses one that is not 0x and 64 hex digits", async () => {
    const paths: string[] = [];
    await open("events", { sources: verified, events: (p) => { paths.push(p); return page([]); } });
    await userEvent.click(screen.getByRole("button", { name: /Filter by topic/ }));
    await userEvent.type(screen.getByLabelText("First topic"), "0x12");
    expect(screen.getByRole("alert")).toHaveTextContent("0x and 64 hex digits");
    await userEvent.clear(screen.getByLabelText("First topic"));
    const t = "0x" + "ab".repeat(32);
    await userEvent.type(screen.getByLabelText("First topic"), t);
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(await screen.findByText(/in a final block/)).toBeInTheDocument();
    expect(paths.some((p) => p.includes(`topic0=${t}`))).toBe(true);
  });

  it("says plainly when the contract has written no logs in a final block", async () => {
    await open("events", { sources: verified });
    expect(await screen.findByText("This contract has written no logs in a final block.")).toBeInTheDocument();
  });
});
