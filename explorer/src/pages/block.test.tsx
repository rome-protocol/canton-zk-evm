// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiBlock, ApiStatus } from "../api.ts";
import { addr, block, blockDetail, fakeApi, hash, inFlight, NOT_FOUND, page, renderApp, reply, route, status, tick, txItem, update, updateDetail } from "../test-utils.tsx";

const LEGS = "Daml legs settled with this block are not shown to the public. Only the parties to each leg and the chain's operator, confirmer, gateway and builder see them, and each token's registry sees its own token move.";
const KEY = "0x" + "cd".repeat(32);
const EE = "0x" + "ee".repeat(32);

const proving = (): ApiBlock => block({ status: "proving", number: 4, hash: hash(4), parentHash: hash(3), timestamp: block().timestamp + 8, canton: null });
const genesis = (over: Partial<ApiBlock> = {}): ApiBlock => block({ status: "genesis", number: 0, hash: hash(0xcd), parentHash: "0x" + "00".repeat(32), timestamp: 0, txCount: 0, gasUsed: 0, canton: null, transactions: [], genesisReferenced: true, ...over });
const withProof = (proof: Partial<NonNullable<ApiBlock["canton"]>>) => block({ canton: { ...block().canton!, ...proof } });

async function open(b: ApiBlock = block(), st: ApiStatus = status(), id = String(b.number), more: Parameters<typeof route>[0] = {}) {
  const calls = fakeApi(route({ block: () => reply(b), status: () => reply(st), blockDetail: () => reply(blockDetail({ number: b.number })), update: () => reply(updateDetail(b.number)), ...more }));
  renderApp(`/block/${id}`);
  await screen.findByRole("heading", { name: `Block #${b.number}` });
  return calls;
}
/** The API as `open` has it, and the check's file as the explorer serves it: a HEAD says how big it is, a GET gives it (or the status `get`). Every request is kept in `calls`, as "METHOD path". */
function serving(h: Parameters<typeof route>[0], file: { size?: number; get?: number; wasm?: Uint8Array }) {
  const calls: string[] = [];
  const api = route(h);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${input}`);
    if (input.startsWith("/verify/")) {
      if (method === "HEAD") return new Response(null, { status: 200, headers: file.size ? { "content-length": String(file.size) } : {} });
      return file.wasm ? new Response(new Uint8Array(file.wasm), { status: 200, headers: { "content-type": "application/wasm" } }) : new Response("Not found", { status: file.get ?? 404 });
    }
    const a = api(input);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }));
  return calls;
}
const side = (name: string) => within(screen.getByRole("region", { name }));
/** The value beside a label in one of the page's lists of facts. */
const row = (scope: ReturnType<typeof within>, label: string) => scope.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
/** The status word in the page's title, which the EVM side repeats as its Stage. */
const titleWord = (n: number, text: string) => within(screen.getByRole("heading", { name: `Block #${n}` }).parentElement!).getByText(text);
/** What the block route really sends for a block still being proven: no lifecycle, since the journal is read only for a final block. The producer's times come from the in-flight route. */
const notFinalDetail = () => blockDetail({ number: 4, lifecycle: null });
const steps = () => within(screen.getByRole("region", { name: "How this block became final" })).getAllByRole("listitem");

describe("the block page, for a final block", () => {
  it("names the block and says it is final on Canton, with its neighbours", async () => {
    await open();
    const title = screen.getByRole("heading", { name: "Block #3" }).parentElement!;
    expect(within(title).getByText("Final on Canton")).toHaveClass("chip-final");
    expect(within(screen.getByRole("navigation", { name: "Where this is" })).getByRole("link", { name: "Blocks" })).toHaveAttribute("href", "/blocks");
    const nav = within(screen.getByRole("navigation", { name: "Neighbouring blocks" }));
    expect(nav.getByRole("link", { name: "Previous block, 2" })).toHaveAttribute("href", "/block/2");
    expect(nav.getByRole("link", { name: "Next block, 4" })).toHaveAttribute("href", "/block/4");
  });

  it("shows a gas limit above 30,000,000 as the block's own, in the EVM side and in the tiles", async () => {
    await open(block({ gasUsed: 45_000_000, gasLimit: 60_000_000 }));
    const evm = side("On the EVM");
    expect(row(evm, "Gas used")).toHaveTextContent("45,000,000 (75.00% of 60,000,000)");
    expect(screen.getByRole("group", { name: "This block in numbers" })).toHaveTextContent("45,000,000 gas");
  });

  it("says the producer's times cannot be read right now when the detail request fails, never that the log has no row", async () => {
    await open(block(), status(), "3", { blockDetail: () => reply({ error: "Too many requests." }, 429) });
    const tiles = within(screen.getByRole("group", { name: "This block in numbers" }));
    expect((await tiles.findAllByText("cannot be read right now")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/no row in the producer's log/)).toBeNull();
    expect(screen.queryByText(/has no row for this block/)).toBeNull();
    expect(within(screen.getByRole("region", { name: "How this block became final" })).getByText(/cannot be read right now/)).toBeInTheDocument();
  });

  it("says the log has no row for a final block whose detail came back without one", async () => {
    await open(block(), status(), "3", { blockDetail: () => reply(blockDetail({ lifecycle: null })) });
    expect(await screen.findByText(/The producer's log has no row for this block/)).toBeInTheDocument();
  });

  it("has no next block when it is the newest", async () => {
    await open(block({ number: 4, hash: hash(4) }), status({ proving: null, final: { ...status().final!, number: 4 } }));
    const nav = within(screen.getByRole("navigation", { name: "Neighbouring blocks" }));
    expect(nav.getByRole("link", { name: "Previous block, 3" })).toBeInTheDocument();
    expect(nav.queryByRole("link", { name: /Next block/ })).toBeNull();
  });

  it("shows the EVM side from reth: the height, the stage, the time, the hashes, the gas, the fees and the record's sizes", async () => {
    await open();
    const evm = side("On the EVM");
    expect(evm.getByText("from reth, at the final head")).toBeInTheDocument();
    expect(row(evm, "Block height")).toHaveTextContent("3");
    expect(row(evm, "Stage")).toHaveTextContent(/Final on Canton\s*final .+ ago/);
    expect(row(evm, "Time")).toHaveTextContent("4 Oct 2026, 01:37:16 UTC · block timestamp, whole seconds");
    expect(within(row(evm, "Transactions")).getByRole("link", { name: "1 transaction" })).toHaveAttribute("href", "#transactions");
    expect(row(evm, "Hash")).toHaveTextContent(hash(3));
    expect(within(row(evm, "Parent hash")).getByRole("link", { name: "0x02020202…02020202" })).toHaveAttribute("href", `/block/${hash(2)}`);
    expect(row(evm, "Parent hash")).toHaveTextContent("block 2");
    expect(row(evm, "Gas used")).toHaveTextContent("51,698 (0.17% of 30,000,000)");
    expect(row(evm, "Base fee")).toHaveTextContent("0.67 gwei");
    expect(row(evm, "Burnt fees")).toHaveTextContent("0.0000346 tROME");
    expect(within(row(evm, "Fee recipient")).getByRole("link")).toHaveAttribute("href", `/address/${block().miner}`);
    expect(row(evm, "Fee recipient")).toHaveTextContent("priority fees only");
    expect(row(evm, "State root")).toHaveTextContent("0x10101010…10101010");
    expect(row(evm, "Record data")).toHaveTextContent("2,137 bytes · header 612, transactions 181, proof 1,344");
  });

  it("shows the block's record on Canton: the update, the times, the reader's offset, the template, who signed it, and the hashes", async () => {
    await open();
    const canton = side("Final on Canton");
    expect(canton.getByText("read as the reader party")).toBeInTheDocument();
    expect(row(canton, "Update id")).toHaveTextContent(update(3));
    expect(row(canton, "Record time")).toHaveTextContent("2026-10-04T01:37:23.412Z");
    expect(await within(row(canton, "Offset")).findByText("52")).toBeInTheDocument();
    expect(row(canton, "Synchronizer")).toHaveTextContent("da::1220…e8e8");
    expect(row(canton, "Offset")).toHaveTextContent("on the reader's participant");
    expect(row(canton, "Template")).toHaveTextContent("Zk.Chain:ZkChain · choice Advance");
    expect(within(row(canton, "Template")).getByText("producer log")).toHaveClass("tag");
    expect(row(canton, "Created")).toHaveTextContent("Zk.Chain:BlockRecord for block 3");
    const signers = row(canton, "Signed by");
    expect(signers).toHaveTextContent("the chain's operator operator::1220…abab");
    expect(signers).toHaveTextContent("the chain's confirmer confirmer::1220…cdcd");
    expect(row(canton, "Hashes")).toHaveTextContent("reth, the record and the record's header give the same hash");
    expect(canton.getByRole("link", { name: /Open the Canton record/ })).toHaveAttribute("href", `/canton/${update(3)}`);
  });

  it("shows no offset and says the template cannot be read right now when the update's route fails", async () => {
    await open(block(), status(), "3", { update: () => reply({ error: "no" }, 429) });
    const canton = side("Final on Canton");
    await within(row(canton, "Template")).findByText("cannot be read right now");
    expect(row(canton, "Offset")).toHaveTextContent("—");
    expect(row(canton, "Synchronizer")).toHaveTextContent("—");
    expect(row(canton, "Template")).not.toHaveTextContent("not in the producer's log");
  });

  it("says the template is being read, not that it is missing, while the update's route has not answered", async () => {
    fakeApi(route({ block: () => reply(block()), status: () => reply(status()), blockDetail: () => reply(blockDetail({ number: 3 })), update: () => reply(updateDetail(3)) }));
    const answer = globalThis.fetch as unknown as (i: string) => Promise<Response>;
    vi.stubGlobal("fetch", vi.fn((input: string) => (input.startsWith("/api/canton/updates/") ? new Promise<Response>(() => {}) : answer(input))));
    renderApp("/block/3");
    await screen.findByRole("heading", { name: "Block #3" });
    const canton = side("Final on Canton");
    expect(row(canton, "Template")).toHaveTextContent("reading…");
    expect(row(canton, "Template")).not.toHaveTextContent("not in the producer's log");
  });

  it("says the template is not in the producer's log only when the update's route answers that it is not", async () => {
    await open(block(), status(), "3", { update: () => reply({ ...updateDetail(3), producerRecord: null }) });
    const canton = side("Final on Canton");
    await within(row(canton, "Offset")).findByText("52");
    expect(row(canton, "Template")).toHaveTextContent("not in the producer's log");
    expect(within(row(canton, "Template")).queryByText("producer log")).toBeNull();
  });

  it("never shows the builder's completion offset", async () => {
    await open(block(), status(), "3", { update: () => reply({ ...updateDetail(3), completionOffset: 777, producerRecord: { ...updateDetail(3).producerRecord, completionOffset: 777 } }) });
    await within(row(side("Final on Canton"), "Offset")).findByText("52");
    expect(document.body.textContent).not.toContain("777");
  });

  it("copies the full Canton update id", async () => {
    const user = userEvent.setup();
    await open();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(within(row(side("Final on Canton"), "Update id")).getByRole("button", { name: "Copy" }));
    expect(write).toHaveBeenCalledWith(update(3));
  });

  it("shows the proof's facts next to what they should match", async () => {
    await open();
    expect(screen.getByRole("region", { name: "The proof" })).toHaveTextContent("read from the proof's own bytes, compared with this explorer's pins, from session.txt");
    const facts = within(screen.getByRole("group", { name: "Facts read from the proof" }));
    expect(row(facts, "Program key")).toHaveTextContent("0xcdcd…cdcd");
    expect(row(facts, "Program key").nextElementSibling).toHaveTextContent("ours");
    expect(row(facts, "ZisK release").nextElementSibling).toHaveTextContent("ZisK 1.3.1");
    expect(row(facts, "Block hash committed")).toHaveTextContent("0x0303…0303");
    expect(row(facts, "Block hash committed").nextElementSibling).toHaveTextContent("this block");
    expect(row(facts, "Proof")).toHaveTextContent("1,344 bytes · proof 768, program key 32, release 32, public values 512");
    expect(screen.getByRole("group", { name: "Facts read from the proof" })).not.toHaveClass("facts-bad");
  });

  it("says in full that Daml legs are not shown, and shows no count of them", async () => {
    await open();
    expect(screen.getByText(LEGS)).toBeInTheDocument();
    expect(screen.queryByText(/\b\d+ (Daml )?legs?\b/i)).toBeNull();
  });

  it("tells the six steps of the way to final, each with its clock, its time since the one before and where it comes from", async () => {
    await open();
    await screen.findByText(/Cut to final in/);
    const items = steps();
    expect(items.map((li) => li.textContent)).toEqual([
      "Cut01:37:15.900startproducer log",
      "Built01:37:16.100+0.200 s · reth made the blockproducer log",
      "Proof started01:37:16.200+0.100 sproducer log",
      "Proof done01:37:23.000+6.800 s · ZisK, 1,344 bytesproducer log",
      "Sent to Canton01:37:23.050+0.050 s · ZkChain · Advanceproducer log",
      "Final on Canton01:37:23.412000+0.362 sCanton record time",
    ]);
    expect(items[5]).toHaveClass("last");
    expect(screen.getByText(/Cut to final in 7\.512 s\./)).toBeInTheDocument();
  });

  it("labels the bar's parts: the proof with its time and the Canton part by its seconds alone", async () => {
    await open();
    await screen.findByText(/Cut to final in/);
    const bar = within(screen.getByRole("region", { name: "How this block became final" })).getByRole("img");
    expect(within(bar).getByText("Proof 6.80 s")).toBeInTheDocument();
    expect(within(bar).getByText("0.36")).toBeInTheDocument();
  });

  it("lists the block's transactions a page at a time, in order, from the block's own route", async () => {
    const calls = await open(block({ txCount: 2 }), status(), "3", {
      blockTxs: () => reply(page([txItem(3, { hash: hash(0xf6), index: 0 }), txItem(3, { hash: hash(0xa1), index: 1, success: false, to: null, created: addr(0xc1) })])),
    });
    const table = within(await screen.findByRole("region", { name: "Transactions" }));
    expect(table.getByRole("heading", { name: "Transactions" }).nextElementSibling).toHaveTextContent("2 in this block, in order");
    expect(calls).toContain("/api/blocks/3/transactions?limit=10");
    await table.findByRole("link", { name: "0xf6f6f6f6…f6f6f6" });
    expect(table.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(table.queryByRole("button", { name: /full/i })).toBeNull();
    const rows = table.getAllByRole("row").slice(1);
    const cells = within(rows[0]!);
    expect(cells.getByRole("link", { name: "0xf6f6f6f6…f6f6f6" })).toHaveAttribute("href", `/tx/${hash(0xf6)}`);
    expect(cells.getByRole("link", { name: "0x5b5b5b5b…5b5b5b" })).toHaveAttribute("href", `/address/${addr(0x5b)}`);
    expect(rows[0]).toHaveTextContent("0.25 tROME");
    expect(rows[0]).toHaveTextContent("0.000035 tROME");
    expect(cells.getByText("Success")).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("Failed (reverted)");
    expect(rows[1]).toHaveTextContent("creates contract");
    expect(table.getByText("Showing 1–2 of 2")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Transfer")).toHaveClass("method");
    expect(table.queryByRole("navigation", { name: "Pages of transactions" })).toBeNull();
  });

  it("opens any page of a long block's transactions, since the block's count says how many pages there are", async () => {
    const user = userEvent.setup();
    const calls = await open(block({ txCount: 25 }), status(), "3", {
      blockTxs: (_, path) => {
        const after = /after=(\d+)/.exec(path)?.[1];
        const first = after === undefined ? 0 : Number(after) + 1;
        return reply(page(Array.from({ length: Math.min(10, 25 - first) }, (_, i) => txItem(3, { hash: hash(0x80 + first + i), index: first + i }))));
      },
    });
    const nav = () => within(screen.getByRole("navigation", { name: "Pages of transactions" }));
    await screen.findByRole("link", { name: "0x80808080…808080" });
    expect(nav().getByText("Page 1 of 3")).toBeInTheDocument();
    expect(nav().getByRole("button", { name: "First" })).toBeDisabled();
    await user.click(nav().getByRole("button", { name: "Next page" }));
    await screen.findByRole("link", { name: "0x8a8a8a8a…8a8a8a" });
    expect(calls).toContain("/api/blocks/3/transactions?limit=10&after=9");
    expect(screen.getByText("Showing 11–20 of 25")).toBeInTheDocument();
    await user.click(nav().getByRole("button", { name: "Last" }));
    await screen.findByRole("link", { name: "0x94949494…949494" });
    expect(calls).toContain("/api/blocks/3/transactions?limit=10&after=19");
    expect(nav().getByText("Page 3 of 3")).toBeInTheDocument();
    expect(screen.getByText("Showing 21–25 of 25")).toBeInTheDocument();
    expect(nav().getByRole("button", { name: "Next page" })).toBeDisabled();
    await user.click(nav().getByRole("button", { name: "First" }));
    await screen.findByRole("link", { name: "0x80808080…808080" });
  });

  it("names the faucet as the sender of its transactions", async () => {
    await open(block({ txCount: 1 }), status(), "3", {
      blockTxs: () => reply(page([txItem(3, { from: addr(0xfa) })])),
      faucet: () => reply({ on: true, address: addr(0xfa) }),
    });
    expect(await screen.findByRole("link", { name: "Ostia faucet" })).toHaveAttribute("href", `/address/${addr(0xfa)}`);
  });

  it("says so when the block holds no transactions", async () => {
    await open(block({ txCount: 0, transactions: [] }));
    expect(await within(screen.getByRole("region", { name: "Transactions" })).findByText("No transactions in this block.")).toBeInTheDocument();
  });

  it("lists the gateway legs the block recorded, and shows nothing when it recorded none", async () => {
    await open(block(), status(), "3", { blockLegs: () => reply(page([{ legIndex: 0, txIndex: 0, logIndex: 1, kind: "Deposit", legId: hash(0x1e), token: addr(0xcb), account: addr(0x5b), amount: "250" }])) });
    const legs = within(await screen.findByRole("region", { name: "Gateway legs" }));
    const r = legs.getAllByRole("row")[1]!;
    expect(r).toHaveTextContent("Deposit");
    expect(within(r).getByRole("link", { name: "0xcbcb…cbcb" })).toHaveAttribute("href", `/token/${addr(0xcb)}`);
    expect(r).toHaveTextContent("250");
    expect(within(r).getByRole("link", { name: "0" })).toHaveAttribute("href", `/leg/${hash(0x1e)}`);
    expect(within(await screen.findByRole("region", { name: "Gateway legs" })).getByRole("link", { name: "All gateway legs" })).toHaveAttribute("href", "/legs");
  });

  it("has no legs section for a block with none", async () => {
    await open();
    await screen.findByRole("region", { name: "Transactions" });
    expect(screen.queryByRole("region", { name: "Gateway legs" })).toBeNull();
  });

  it("lists the transactions a block being proven holds, as the block's own answer gives them, and says when a transaction failed, is not known, or created a contract", async () => {
    const t = block().transactions[0]!;
    await open(block({
      status: "proving", canton: null, txCount: 3,
      transactions: [
        { ...t, success: false }, // the server still decodes the transfer of a reverted call
        { ...t, hash: hash(0xa1), success: null, transfer: null },
        { ...t, hash: hash(0xa2), to: null, transfer: null },
      ],
    }));
    const rows = within(screen.getByRole("region", { name: "Transactions" })).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Failed (reverted)");
    expect(rows[0]).toHaveTextContent("Tried to send 10 TKA to 0x5a5a…5a5a. Reverted, nothing moved.");
    expect(rows[0]).not.toHaveTextContent("Sent");
    expect(rows[1]).toHaveTextContent("Not known");
    expect(rows[2]).toHaveTextContent("Created a contract");
  });

  it("asks the server for the block by the name in the address, a number or a hash", async () => {
    const calls = await open(block(), status(), hash(3));
    expect(calls).toContain(`/api/block/${hash(3)}`);
  });

  it("does not look again: a final block does not change", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const calls = await open();
    await tick(10_000);
    expect(calls.filter((c) => c.startsWith("/api/block/"))).toHaveLength(1);
  });
});

describe("the block page, for a final block: the record", () => {
  it("shows the sizes of the record's data, and copies each part exactly as the record holds it", async () => {
    const user = userEvent.setup();
    await open();
    const data = within(screen.getByRole("region", { name: "The record's data" }));
    expect(data.getByText("proof 1,344 B")).toBeInTheDocument();
    expect(data.getByText("header 612 B")).toBeInTheDocument();
    expect(data.getByText("transactions 181 B")).toBeInTheDocument();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(data.getByRole("button", { name: "Copy the header" }));
    expect(write).toHaveBeenLastCalledWith("22".repeat(612));
    await user.click(data.getByRole("button", { name: "Copy the transactions" }));
    expect(write).toHaveBeenLastCalledWith("33".repeat(181));
    await user.click(data.getByRole("button", { name: "Copy the proof" }));
    expect(write).toHaveBeenLastCalledWith("11".repeat(1344));
  });

  it("shows the Verify panel in the proof's card, above the transactions and the record's data, ready, with the pins from the status", async () => {
    await open();
    const panel = (await screen.findByRole("heading", { name: "Verify this block in your browser" })).closest("section")!;
    const verify = within(panel);
    expect(verify.getByRole("button", { name: "Verify" })).toBeEnabled();
    expect(verify.getByText("session.txt")).toBeInTheDocument();
    expect(verify.getAllByText("0xcdcd…cdcd")).toHaveLength(2);
    expect(panel.compareDocumentPosition(await screen.findByRole("region", { name: "Transactions" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.compareDocumentPosition(screen.getByRole("region", { name: "The record's data" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("tells the panel the size of the check from the file's own answer, and downloads nothing before Verify is pressed", async () => {
    const calls = serving({ block: () => reply(block()) }, { size: 170_260 });
    renderApp("/block/3");
    expect(await screen.findByText(/downloads once, about 170 KB, when you press Verify/)).toBeInTheDocument();
    expect(calls).toContain("HEAD /verify/zk_explorer_verify.wasm");
    expect(calls).not.toContain("GET /verify/zk_explorer_verify.wasm");
  });

  it("leaves out the size and keeps the rest when the server does not give one", async () => {
    await open();
    expect(await screen.findByText(/The check downloads once when you press Verify\./)).toBeInTheDocument();
  });

  it("downloads the check from the explorer when Verify is pressed, and says so when it cannot", async () => {
    const calls = serving({ block: () => reply(block()) }, { size: 170_260, get: 404 });
    renderApp("/block/3");
    await userEvent.click(await screen.findByRole("button", { name: "Verify" }));
    expect(await screen.findByText(/The check could not be downloaded \(404\)\./)).toBeInTheDocument();
    expect(calls).toContain("GET /verify/zk_explorer_verify.wasm");
  });

  // Runs the built module (CI builds it, and sets VERIFY_WASM). The page's block carries made-up bytes, so the check must say no, with its own reason.
  it.skipIf(!process.env.VERIFY_WASM)("runs the built check on the block's record, and shows what the check says", async () => {
    const bytes = readFileSync(process.env.VERIFY_WASM!);
    serving({ block: () => reply(block()) }, { size: bytes.length, wasm: bytes });
    renderApp("/block/3");
    await userEvent.click(await screen.findByRole("button", { name: "Verify" }));
    expect(await screen.findByText(/^Failed: /)).toBeInTheDocument();
  });
});

describe("when something does not match", () => {
  it("shows a key that is not the explorer's pin in red, with the value that was read and the pin", async () => {
    await open(withProof({ proof: { programVK: { value: EE, ok: false }, rootC: { value: EE, ok: false }, blockHash: { value: null, ok: false } } }));
    const facts = within(screen.getByRole("group", { name: "Facts read from the proof" }));
    expect(row(facts, "Program key")).toHaveTextContent("0xeeee…eeee");
    const program = row(facts, "Program key").nextElementSibling!;
    expect(program).toHaveTextContent(`does not match this explorer's pin ${"0xcdcd…cdcd"}`);
    expect(program.firstElementChild).toHaveClass("fact-bad");
    expect(row(facts, "ZisK release").nextElementSibling).toHaveTextContent("does not match this explorer's pin 0xcdcd…cdcd");
    expect(row(facts, "Block hash committed")).toHaveTextContent("none in its public values");
    expect(row(facts, "Block hash committed").nextElementSibling).toHaveTextContent("not this block's hash");
    expect(facts.queryByText("ours")).toBeNull();
    expect(screen.getByRole("group", { name: "Facts read from the proof" })).toHaveClass("facts-bad");
  });

  it("shows a hash that is not this block's with the hash that was read", async () => {
    await open(withProof({ proof: { ...block().canton!.proof!, blockHash: { value: hash(9), ok: false } } }));
    const facts = within(screen.getByRole("group", { name: "Facts read from the proof" }));
    expect(row(facts, "Block hash committed")).toHaveTextContent("0x0909…0909");
    expect(row(facts, "Block hash committed").nextElementSibling).toHaveTextContent("not this block's hash");
  });

  it("says that the status word stays Final, and what a red fact means", async () => {
    await open(withProof({ proof: { ...block().canton!.proof!, rootC: { value: EE, ok: false } } }));
    expect(within(screen.getByRole("heading", { name: "Block #3" }).parentElement!).getByText("Final on Canton")).toBeInTheDocument();
    expect(screen.getByText(/The status word stays Final/)).toHaveTextContent(
      "The status word stays Final: Canton's confirmers checked the proof against their own pins when the block committed. A red fact means the proof differs from the pins this explorer was given.",
    );
  });

  it("has no such note when every fact matches", async () => {
    await open();
    expect(screen.queryByText(/The status word stays Final/)).toBeNull();
  });

  it("shows one red line, and no facts, for a proof that is not 1,344 bytes", async () => {
    await open(withProof({ proof: null, proofBytes: 100, proofHex: "11".repeat(100) }));
    expect(screen.getByText("This proof is not 1,344 bytes, so its facts cannot be read.").closest(".alert")).toHaveClass("bad-alert");
    expect(screen.queryByRole("group", { name: "Facts read from the proof" })).toBeNull();
    expect(screen.queryByText("Program key")).toBeNull();
  });

  it("warns at the top when the three hashes differ, and says so beside the record", async () => {
    await open(withProof({ hashesMatch: false }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The hashes do not match. reth's hash for this block, the hash in its block record and the hash of the record's header are not all the same. The explorer's status is red until this is explained.");
    expect(alert.compareDocumentPosition(screen.getByRole("region", { name: "On the EVM" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const line = row(side("Final on Canton"), "Hashes");
    expect(line).toHaveTextContent("reth, the record and the record's header do not all give the same hash");
    expect(line.firstElementChild).toHaveClass("fact-bad");
  });

  it("has no warning when the hashes match", async () => {
    await open();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a block that Canton holds and the indexer has not read", () => {
  it("says it is final on Canton and not indexed, and not that it is being proven", async () => {
    await open(block({ status: "unindexed", number: 4, hash: hash(4), parentHash: hash(3), canton: null }));
    const title = screen.getByRole("heading", { name: "Block #4" }).parentElement!;
    expect(within(title).getByText("Not indexed yet")).toHaveClass("chip-unindexed");
    const canton = side("On Canton");
    expect(canton.getByText("Final on Canton, not indexed yet.")).toBeInTheDocument();
    expect(canton.queryByText("Not on Canton yet.")).toBeNull();
  });

  it("does not call it 'not final yet' in the tiles or the way to final: Canton holds it and the explorer has not read it", async () => {
    await open(block({ status: "unindexed", number: 4, hash: hash(4), parentHash: hash(3), canton: null }));
    expect(screen.queryByText(/not final yet/i)).toBeNull();
    expect(screen.getAllByText("Canton holds it, not read yet").length).toBeGreaterThan(0);
    expect(screen.getByText(/its way to final is not shown/)).toBeInTheDocument();
  });
});

describe("a block that is still being proven", () => {
  it("says so, and says that Canton does not have it yet", async () => {
    await open(proving());
    const title = screen.getByRole("heading", { name: "Block #4" }).parentElement!;
    expect(within(title).getByText("Being proven")).toHaveClass("chip-proving");
    const canton = side("On Canton");
    expect(canton.getByText("Not on Canton yet.")).toBeInTheDocument();
    expect(canton.getByText("reth has made this block and it is being proven. It becomes final when Canton commits it. It can still disappear if Canton refuses it.")).toBeInTheDocument();
    expect(canton.queryByText("Update id")).toBeNull();
    expect(row(side("On the EVM"), "Hash")).toHaveTextContent(hash(4));
  });

  it("has a link back to the block before it, and none forward", async () => {
    await open(proving());
    const nav = within(screen.getByRole("navigation", { name: "Neighbouring blocks" }));
    expect(nav.getByRole("link", { name: "Previous block, 3" })).toBeInTheDocument();
    expect(nav.queryByRole("link", { name: /Next block/ })).toBeNull();
  });

  it("shows the steps it has the producer's times for, and a dash for the rest, which Canton does not have yet", async () => {
    await open(proving(), status(), "4", { blockDetail: () => reply(notFinalDetail()), inFlight: () => reply(inFlight()) });
    await screen.findByText(/This block is not final yet/);
    await screen.findByText("01:37:24.200");
    const items = steps();
    expect(items.map((li) => li.className)).toEqual(["got", "got", "got", "none", "none", "none"]);
    expect(items[1]).toHaveTextContent("Built01:37:24.200");
    expect(items[3]).toHaveTextContent("Proof done—");
    expect(items[5]).toHaveTextContent("Final on Canton—");
    expect(within(screen.getByRole("region", { name: "How this block became final" })).queryByRole("img")).toBeNull();
  });

  it("says 'not final yet' under the tiles that have no time, never that the producer's log has no row", async () => {
    await open(proving(), status(), "4", { blockDetail: () => reply(notFinalDetail()), inFlight: () => reply(inFlight()) });
    await screen.findByText("01:37:24.200");
    const tiles = within(screen.getByRole("group", { name: "This block in numbers" }));
    expect(tiles.getAllByText("not final yet").length).toBeGreaterThan(0);
    expect(tiles.queryByText(/no row in the producer's log/)).toBeNull();
  });

  it("still says that Daml legs are not shown, and still lists the transactions", async () => {
    await open(proving());
    expect(screen.getByText(LEGS)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Transactions" })).getAllByRole("row")).toHaveLength(2);
  });

  it("has no record data, and greys the Verify panel: its button is off and nothing is downloaded", async () => {
    const calls = serving({ block: () => reply(proving()) }, { size: 170_260 });
    renderApp("/block/4");
    const panel = (await screen.findByRole("heading", { name: "Verify this block in your browser" })).closest("section")!;
    expect(screen.queryByRole("region", { name: "The record's data" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Verify" })).toBeDisabled();
    expect(panel).toHaveTextContent("Verify works on the block record, so it opens once this block is final on Canton.");
    expect(calls).not.toContain("GET /verify/zk_explorer_verify.wasm");
  });

  it("looks again every two seconds, and becomes final by itself", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let answer = proving();
    const calls = fakeApi(route({ block: () => reply(answer) }));
    renderApp("/block/4");
    await screen.findAllByText("Being proven", { selector: ".chip" });
    await tick();
    expect(calls.filter((c) => c.startsWith("/api/block") && !c.includes("/transactions")).length).toBeGreaterThanOrEqual(2);
    expect(titleWord(4, "Being proven")).toBeInTheDocument();
    answer = block({ number: 4, hash: hash(4), parentHash: hash(3) });
    await tick();
    expect(titleWord(4, "Final on Canton")).toBeInTheDocument();
    expect(screen.getByText("Update id")).toBeInTheDocument();
    const polls = () => calls.filter((c) => /^\/api\/blocks?\/4$/.test(c)).length;
    const seen = polls();
    await tick(10_000);
    expect(polls()).toBe(seen);
  });

  it("says Not found when Canton refuses the block and it goes away", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let gone = false;
    fakeApi(route({ block: () => (gone ? reply({ error: NOT_FOUND }, 404) : reply(proving())) }));
    renderApp("/block/4");
    await screen.findAllByText("Being proven", { selector: ".chip" });
    gone = true;
    await tick();
    expect(screen.getByRole("heading", { name: "Not found" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Block #4" })).toBeNull();
  });
});

describe("block 0", () => {
  it("is Genesis: the EVM side from reth, no parent, and no steps, legs line or transactions", async () => {
    await open(genesis());
    const title = screen.getByRole("heading", { name: "Block #0" }).parentElement!;
    expect(within(title).getByText("Genesis")).toHaveClass("chip-genesis");
    expect(row(side("On the EVM"), "Parent hash")).toHaveTextContent("none");
    expect(screen.queryByRole("region", { name: "How this block became final" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Transactions" })).toBeNull();
    expect(screen.queryByText(LEGS)).toBeNull();
    expect(screen.queryByRole("link", { name: /Previous block/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Next block, 1" })).toHaveAttribute("href", "/block/1");
  });

  it("says that it has no block record, and that block 1's record names it as its parent", async () => {
    await open(genesis());
    const canton = side("On Canton");
    expect(canton.getByText("The chain's starting block.")).toBeInTheDocument();
    expect(canton.getByText("It has no block record. Block 1's record names it as its parent.")).toBeInTheDocument();
    expect(canton.getByText("Block 1's record names this hash as its parent")).toHaveClass("fact-ok");
  });

  it("says that nothing on Canton refers to it until block 1 commits, and keeps looking", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let b = genesis({ genesisReferenced: false });
    let st = status({ final: null, latest: [], proving: null });
    fakeApi(route({ block: () => reply(b), status: () => reply(st) }));
    renderApp("/block/0");
    await screen.findAllByText("Genesis", { selector: ".chip" });
    expect(screen.getByText("Nothing on Canton refers to it yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Next block/ })).toBeNull();
    b = genesis({ genesisReferenced: true });
    st = status();
    await tick();
    expect(screen.getByText("Block 1's record names this hash as its parent")).toBeInTheDocument();
  });

  it("says in red when block 1 is final and its record does not name it", async () => {
    await open(genesis({ genesisReferenced: false }));
    const line = screen.getByText("Block 1's record does not name this hash as its parent");
    expect(line).toHaveClass("fact-bad");
    expect(screen.queryByText("Nothing on Canton refers to it yet.")).toBeNull();
  });
});

describe("a block that cannot be shown", () => {
  it("says Not found with the server's own words, and does not keep asking", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const calls = fakeApi(route({ block: () => reply({ error: NOT_FOUND }, 404) }));
    renderApp("/block/999");
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
    expect(screen.getByText(NOT_FOUND.replace("Not found. ", ""))).toBeInTheDocument();
    await tick(10_000);
    expect(calls.filter((c) => c.startsWith("/api/block/"))).toHaveLength(1);
  });

  it("says what a block is named by when the address is not a number or a hash", async () => {
    fakeApi(route({ block: () => reply({ error: "A block is named by its number or its 0x hash." }, 400) }));
    renderApp("/block/abc");
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
    expect(screen.getByText("A block is named by its number or its 0x hash.")).toBeInTheDocument();
  });

  it("says it cannot read the chain, and tries again, when the server cannot", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let healthy = false;
    const calls = fakeApi(route({ block: () => (healthy ? reply(block()) : reply({ error: "The explorer cannot read the chain right now." }, 502)) }));
    renderApp("/block/3");
    expect(await screen.findByRole("heading", { name: "Cannot read the chain" })).toBeInTheDocument();
    expect(screen.getByText("The page tries again in a few seconds.")).toBeInTheDocument();
    healthy = true;
    await tick();
    expect(screen.getByRole("heading", { name: "Block #3" })).toBeInTheDocument();
    expect(calls.filter((c) => c.startsWith("/api/block")).length).toBeGreaterThan(1);
  });

  it("keeps the block it has when one look at the chain fails", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let healthy = true;
    fakeApi(route({ block: () => (healthy ? reply(proving()) : reply({ error: "The explorer cannot read the chain right now." }, 502)) }));
    renderApp("/block/4");
    await screen.findByRole("heading", { name: "Block #4" });
    healthy = false;
    await tick();
    expect(screen.getByRole("heading", { name: "Block #4" })).toBeInTheDocument();
  });
});
