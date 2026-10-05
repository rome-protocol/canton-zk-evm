// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiBlock, ApiStatus } from "../api.ts";
import { addr, block, fakeApi, hash, NOT_FOUND, renderApp, reply, route, status, tick, update } from "../test-utils.tsx";

const LEGS = "Daml legs settled with this block are not shown to the public. Only the parties to each leg and the chain's operator, confirmer, gateway and builder see them, and each token's registry sees its own token move.";
const KEY = "0x" + "cd".repeat(32);
const EE = "0x" + "ee".repeat(32);

const proving = (): ApiBlock => block({ status: "proving", number: 4, hash: hash(4), parentHash: hash(3), timestamp: block().timestamp + 8, canton: null });
const genesis = (over: Partial<ApiBlock> = {}): ApiBlock => block({ status: "genesis", number: 0, hash: hash(0xcd), parentHash: "0x" + "00".repeat(32), timestamp: 0, txCount: 0, gasUsed: 0, canton: null, transactions: [], genesisReferenced: true, ...over });
const withProof = (proof: Partial<NonNullable<ApiBlock["canton"]>>) => block({ canton: { ...block().canton!, ...proof } });

async function open(b: ApiBlock = block(), st: ApiStatus = status(), id = String(b.number)) {
  const calls = fakeApi(route({ block: () => reply(b), status: () => reply(st) }));
  renderApp(`/block/${id}`);
  await screen.findByRole("heading", { name: `Block ${b.number}` });
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
const steps = () => within(screen.getByRole("region", { name: "How it happened" })).getAllByRole("listitem");

describe("the block page, for a final block", () => {
  it("names the block and says it is final, with its neighbours", async () => {
    await open();
    const title = screen.getByRole("heading", { name: "Block 3" }).parentElement!;
    expect(within(title).getByText("Final")).toHaveClass("chip-final");
    const nav = within(screen.getByRole("navigation", { name: "Neighbouring blocks" }));
    expect(nav.getByRole("link", { name: "Previous block, 2" })).toHaveAttribute("href", "/block/2");
    expect(nav.getByRole("link", { name: "Next block, 4" })).toHaveAttribute("href", "/block/4");
  });

  it("has no next block when it is the newest", async () => {
    await open(block({ number: 4, hash: hash(4) }), status({ proving: null, final: { ...status().final!, number: 4 } }));
    const nav = within(screen.getByRole("navigation", { name: "Neighbouring blocks" }));
    expect(nav.getByRole("link", { name: "Previous block, 3" })).toBeInTheDocument();
    expect(nav.queryByRole("link", { name: /Next block/ })).toBeNull();
  });

  it("shows the EVM side from reth", async () => {
    await open();
    const evm = side("On the EVM");
    expect(evm.getByText("from reth")).toBeInTheDocument();
    expect(row(evm, "Hash")).toHaveTextContent("0x03030303…03030303");
    expect(row(evm, "Parent")).toHaveTextContent("Block 2 · 0x0202…0202");
    expect(within(row(evm, "Parent")).getByRole("link", { name: "Block 2" })).toHaveAttribute("href", "/block/2");
    expect(within(row(evm, "Parent")).getByRole("link", { name: "0x0202…0202" })).toHaveAttribute("href", `/block/${hash(2)}`);
    expect(row(evm, "Time")).toHaveTextContent("01:37:16 UTC · 2026-10-04");
    expect(row(evm, "Transactions")).toHaveTextContent("1");
    expect(row(evm, "Gas used")).toHaveTextContent("51,698 of 30,000,000");
    expect(row(evm, "Base fee")).toHaveTextContent("0.67 gwei");
    expect(within(row(evm, "Fee recipient")).getByRole("link")).toHaveAttribute("href", `/address/${block().miner}`);
    expect(row(evm, "State root")).toHaveTextContent("0x1010…1010");
  });

  it("shows the Canton side: the update, the commit time, the record and who signed it", async () => {
    await open();
    const canton = side("On Canton");
    expect(canton.getByText("the block record, read as the reader party")).toBeInTheDocument();
    expect(row(canton, "Canton update")).toHaveTextContent("1220 0303…0303");
    expect(row(canton, "Committed")).toHaveTextContent("01:37:23.412 UTC · 7.4 s after the block was made");
    expect(row(canton, "Record")).toHaveTextContent("Zk.Chain:BlockRecord");
    const signers = row(canton, "Signed by");
    expect(signers).toHaveTextContent("the chain's operator operator::1220…abab");
    expect(signers).toHaveTextContent("the chain's confirmer confirmer::1220…cdcd");
    expect(row(canton, "Hashes")).toHaveTextContent("reth, the record and the record's header give the same hash");
    expect(row(canton, "Proof")).toHaveTextContent("1,344 bytes");
  });

  it("copies the full Canton update id", async () => {
    const user = userEvent.setup();
    await open();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(within(row(side("On Canton"), "Canton update")).getByRole("button", { name: "Copy" }));
    expect(write).toHaveBeenCalledWith(update(3));
  });

  it("shows the proof's three facts next to what they should match, and says reading is not verifying", async () => {
    await open();
    const facts = within(screen.getByRole("group", { name: "Facts read from the proof" }));
    expect(row(facts, "Program key")).toHaveTextContent("0xcdcd…cdcd");
    expect(row(facts, "Program key").nextElementSibling).toHaveTextContent("ours");
    expect(row(facts, "ZisK release").nextElementSibling).toHaveTextContent("ZisK 1.3.1");
    expect(row(facts, "Block hash")).toHaveTextContent("0x0303…0303");
    expect(row(facts, "Block hash").nextElementSibling).toHaveTextContent("this block");
    expect(screen.getByRole("group", { name: "Facts read from the proof" })).not.toHaveClass("facts-bad");
    expect(screen.getByText(/Read from the proof's own bytes and compared with this explorer's pins, from/)).toHaveTextContent(
      "Read from the proof's own bytes and compared with this explorer's pins, from session.txt. Reading a value is not verifying it: Canton's confirmers verified the proof when the block committed.",
    );
  });

  it("says in full that Daml legs are not shown, and shows no count of them", async () => {
    await open();
    expect(screen.getByText(LEGS)).toBeInTheDocument();
    expect(screen.queryByText(/\b\d+ (Daml )?legs?\b/i)).toBeNull();
  });

  it("tells the same five steps, with exactly the two times it measures", async () => {
    await open();
    const items = steps();
    expect(items.map((li) => li.textContent)).toEqual([
      "01:37:16 UTC1reth made the block.",
      "2ZisK proved it.",
      "3It went to Canton as one transaction, ZkChain.Advance.",
      "4The sidecars of both confirming participants checked the proof (the check the Verify button runs below).",
      "01:37:23.412 UTC5The commit created this block record, and any Daml legs settled in the same transaction.",
    ]);
    expect(within(screen.getByRole("region", { name: "How it happened" })).getAllByText(/UTC$/)).toHaveLength(2);
    for (const li of items) expect(li).toHaveClass("done");
  });

  it("lists the block's transactions with what each did and how it ended", async () => {
    await open();
    const table = within(screen.getByRole("region", { name: "Transactions" }));
    expect(table.getByRole("heading", { name: "Transactions" }).nextElementSibling).toHaveTextContent("1");
    const cells = within(table.getAllByRole("row")[1]!);
    expect(cells.getByRole("link", { name: "0xf6f6…f6f6" })).toHaveAttribute("href", `/tx/${hash(0xf6)}`);
    expect(cells.getByRole("link", { name: "0x5b5b…5b5b" })).toHaveAttribute("href", `/address/${addr(0x5b)}`);
    expect(cells.getByRole("link", { name: "0xcbcb…cbcb" })).toHaveAttribute("href", `/token/${addr(0xcb)}`);
    expect(cells.getByText("TKA")).toHaveClass("tag");
    expect(cells.getByText("Sent", { exact: false }).closest("td")).toHaveTextContent("Sent 10 TKA to 0x5a5a…5a5a");
    expect(cells.getByText("Success")).toBeInTheDocument();
  });

  it("says when a transaction failed, when it is not known, and when one created a contract", async () => {
    const t = block().transactions[0]!;
    await open(block({
      txCount: 3,
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

  it("says so when the block holds no transactions", async () => {
    await open(block({ txCount: 0, transactions: [] }));
    expect(within(screen.getByRole("region", { name: "Transactions" })).getByText("No transactions in this block.")).toBeInTheDocument();
  });

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

  it("shows the Verify panel between the transactions and the record's data, ready, with the pins from the status", async () => {
    await open();
    const panel = (await screen.findByRole("heading", { name: "Verify this block in your browser" })).closest("section")!;
    const verify = within(panel);
    expect(verify.getByRole("button", { name: "Verify" })).toBeEnabled();
    expect(verify.getByText("session.txt")).toBeInTheDocument();
    expect(verify.getAllByText("0xcdcd…cdcd")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Transactions" }).compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it("asks the server for the block by the name in the address, a number or a hash", async () => {
    const calls = await open(block(), status(), hash(3));
    expect(calls).toContain(`/api/block/${hash(3)}`);
  });

  it("does not look again: a final block does not change", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const calls = await open();
    await tick(10_000);
    expect(calls.filter((c) => c.startsWith("/api/block"))).toHaveLength(1);
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
    expect(row(facts, "Block hash")).toHaveTextContent("none in its public values");
    expect(row(facts, "Block hash").nextElementSibling).toHaveTextContent("not this block's hash");
    expect(facts.queryByText("ours")).toBeNull();
    expect(screen.getByRole("group", { name: "Facts read from the proof" })).toHaveClass("facts-bad");
  });

  it("shows a hash that is not this block's with the hash that was read", async () => {
    await open(withProof({ proof: { ...block().canton!.proof!, blockHash: { value: hash(9), ok: false } } }));
    const facts = within(screen.getByRole("group", { name: "Facts read from the proof" }));
    expect(row(facts, "Block hash")).toHaveTextContent("0x0909…0909");
    expect(row(facts, "Block hash").nextElementSibling).toHaveTextContent("not this block's hash");
  });

  it("says that the status word stays Final, and what a red fact means", async () => {
    await open(withProof({ proof: { ...block().canton!.proof!, rootC: { value: EE, ok: false } } }));
    expect(screen.getByText("Final", { selector: ".chip" })).toBeInTheDocument();
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
    expect(row(side("On Canton"), "Proof")).toHaveTextContent("100 bytes");
    expect(screen.getByText("This proof is not 1,344 bytes, so its facts cannot be read.").closest(".alert")).toHaveClass("bad-alert");
    expect(screen.queryByRole("group", { name: "Facts read from the proof" })).toBeNull();
    expect(screen.queryByText("Program key")).toBeNull();
  });

  it("warns at the top when the three hashes differ, and says so beside the record", async () => {
    await open(withProof({ hashesMatch: false }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The hashes do not match. reth's hash for this block, the hash in its block record and the hash of the record's header are not all the same. The explorer's status is red until this is explained.");
    expect(alert.compareDocumentPosition(screen.getByRole("region", { name: "On the EVM" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const line = row(side("On Canton"), "Hashes");
    expect(line).toHaveTextContent("reth, the record and the record's header do not all give the same hash");
    expect(line.firstElementChild).toHaveClass("fact-bad");
  });

  it("has no warning when the hashes match", async () => {
    await open();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a block that is still being proven", () => {
  it("says so, and says that Canton does not have it yet", async () => {
    await open(proving());
    const title = screen.getByRole("heading", { name: "Block 4" }).parentElement!;
    expect(within(title).getByText("Being proven")).toHaveClass("chip-proving");
    const canton = side("On Canton");
    expect(canton.getByText("Not on Canton yet.")).toBeInTheDocument();
    expect(canton.getByText("reth has made this block and it is being proven. It becomes final when Canton commits it. It can still disappear if Canton refuses it.")).toBeInTheDocument();
    expect(canton.queryByText("Canton update")).toBeNull();
    expect(row(side("On the EVM"), "Hash")).toHaveTextContent("0x04040404…04040404");
  });

  it("has a link back to the block before it, and none forward", async () => {
    await open(proving());
    const nav = within(screen.getByRole("navigation", { name: "Neighbouring blocks" }));
    expect(nav.getByRole("link", { name: "Previous block, 3" })).toBeInTheDocument();
    expect(nav.queryByRole("link", { name: /Next block/ })).toBeNull();
  });

  it("shows step 1 with its time and says of the rest that they are not on Canton yet", async () => {
    await open(proving());
    const items = steps();
    expect(items[0]).toHaveClass("done");
    expect(items[0]).toHaveTextContent("01:37:24 UTC1reth made the block.");
    expect(items.slice(1).map((li) => li.className)).toEqual(["todo", "todo", "todo", "todo"]);
    expect(items[1]).toHaveTextContent("2ZisK proves it.Not on Canton yet");
    for (const li of items.slice(2)) expect(li).toHaveTextContent("Not on Canton yet");
    // step 4 does not point at the Verify button, which is greyed out until the block is final
    expect(items[3]).toHaveTextContent("4The sidecars of both confirming participants checked the proof.Not on Canton yet");
    expect(items[3]).not.toHaveTextContent("Verify");
    expect(within(screen.getByRole("region", { name: "How it happened" })).getAllByText(/UTC$/)).toHaveLength(1);
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
    await screen.findByText("Being proven", { selector: ".chip" });
    await tick();
    expect(calls.filter((c) => c.startsWith("/api/block"))).toHaveLength(2);
    expect(screen.getByText("Being proven", { selector: ".chip" })).toBeInTheDocument();
    answer = block({ number: 4, hash: hash(4), parentHash: hash(3) });
    await tick();
    expect(screen.getByText("Final", { selector: ".chip" })).toBeInTheDocument();
    expect(screen.getByText("Canton update")).toBeInTheDocument();
    const seen = calls.filter((c) => c.startsWith("/api/block")).length;
    await tick(10_000);
    expect(calls.filter((c) => c.startsWith("/api/block"))).toHaveLength(seen);
  });

  it("says Not found when Canton refuses the block and it goes away", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let gone = false;
    fakeApi(route({ block: () => (gone ? reply({ error: NOT_FOUND }, 404) : reply(proving())) }));
    renderApp("/block/4");
    await screen.findByText("Being proven", { selector: ".chip" });
    gone = true;
    await tick();
    expect(screen.getByRole("heading", { name: "Not found" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Block 4" })).toBeNull();
  });
});

describe("block 0", () => {
  it("is Genesis: the EVM side from reth, no parent, and no steps, legs line or transactions", async () => {
    await open(genesis());
    const title = screen.getByRole("heading", { name: "Block 0" }).parentElement!;
    expect(within(title).getByText("Genesis")).toHaveClass("chip-genesis");
    expect(row(side("On the EVM"), "Parent")).toHaveTextContent("none");
    expect(screen.queryByRole("region", { name: "How it happened" })).toBeNull();
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
    await screen.findByText("Genesis", { selector: ".chip" });
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
    expect(calls.filter((c) => c.startsWith("/api/block"))).toHaveLength(1);
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
    expect(screen.getByRole("heading", { name: "Block 3" })).toBeInTheDocument();
    expect(calls.filter((c) => c.startsWith("/api/block")).length).toBeGreaterThan(1);
  });

  it("keeps the block it has when one look at the chain fails", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let healthy = true;
    fakeApi(route({ block: () => (healthy ? reply(proving()) : reply({ error: "The explorer cannot read the chain right now." }, 502)) }));
    renderApp("/block/4");
    await screen.findByRole("heading", { name: "Block 4" });
    healthy = false;
    await tick();
    expect(screen.getByRole("heading", { name: "Block 4" })).toBeInTheDocument();
  });
});
