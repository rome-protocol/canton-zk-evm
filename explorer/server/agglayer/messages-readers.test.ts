import { describe, expect, it } from "vitest";
import { claimMessageCall, emergencyStateCall, noteOfCall } from "./abi.ts";
import { AggkitError, LIST_MAX_PAGES, LIST_PAGE_SIZE, createAggkitReader } from "./aggkit.ts";
import { Secret } from "./secret.ts";
import { SIMULATE_FROM, SepoliaBusy, SepoliaError, createSepoliaReader } from "./sepolia.ts";

const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const WALLET = "0x00000000000000000000000000000000000000AB";
const BASE = "http://127.0.0.1:5578";
const row = (n: number, over: Record<string, unknown> = {}) => ({
  deposit_count: n, tx_hash: H(n + 1), block_timestamp: 1_700_000_000 + n, leaf_type: 1, global_index: "1", origin_network: 0, origin_address: A(0xab),
  destination_network: 75, destination_address: A(0xbeef), amount: "0", metadata: "0x68656c6c6f", ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A bridge service whose list answers by page: `pages[n - 1]` is page n's rows, and `count` is the wallet's total sends. */
function service(pages: unknown[][], count = pages.flat().length) {
  const urls: URL[] = [];
  const fetcher = (async (url: unknown) => {
    const u = new URL(String(url));
    urls.push(u);
    return json({ bridges: pages[Number(u.searchParams.get("page_number")) - 1] ?? [], count });
  }) as unknown as typeof fetch;
  return { urls, api: (extra: Partial<Parameters<typeof createAggkitReader>[0]> = {}) => createAggkitReader({ baseUrl: BASE, fetch: fetcher, ...extra }) };
}

describe("the bridge service reader's list of a wallet's messages", () => {
  it("asks for the wallet's sends to the other chain, 200 a page, the wallet's address in lower case, and nothing else", async () => {
    const s = service([[row(3)]]);
    await s.api().messagesFrom(0, WALLET, 75, 20);
    expect(s.urls).toHaveLength(1);
    expect(s.urls[0]!.pathname).toBe("/bridge/v1/bridges");
    expect(Object.fromEntries(s.urls[0]!.searchParams)).toEqual({ network_id: "0", network_ids: "75", from_address: WALLET.toLowerCase(), page_number: "1", page_size: "200" });
  });

  it("keeps only messages, newest first as the service gives them, and reads the metadata as the message's bytes", async () => {
    const s = service([[row(9, { leaf_type: 0, metadata: "not even hex" }), row(8), row(7, { leaf_type: 0 }), row(6)]]);
    const got = await s.api().messagesFrom(0, WALLET, 75, 20);
    expect(got.map((l) => l.depositCount)).toEqual([8, 6]);
    expect(got[0]).toMatchObject({ leafType: 1, originAddress: A(0xab), destinationAddress: A(0xbeef), metadata: "0x68656c6c6f", amount: "0" });
  });

  it("pages on past a page of only tokens until 20 messages are found, and stops at 20", async () => {
    const sends = Array.from({ length: LIST_PAGE_SIZE }, (_, i) => row(1000 - i, { leaf_type: 0 }));
    const messages = Array.from({ length: 30 }, (_, i) => row(500 - i));
    const s = service([sends, [...messages, ...Array.from({ length: LIST_PAGE_SIZE - 30 }, (_, i) => row(400 - i, { leaf_type: 0 }))], sends], 600);
    const got = await s.api().messagesFrom(0, WALLET, 75, 20);
    expect(got).toHaveLength(20);
    expect(got.map((l) => l.depositCount)).toEqual(messages.slice(0, 20).map((m) => m.deposit_count));
    expect(s.urls.map((u) => u.searchParams.get("page_number"))).toEqual(["1", "2"]);
  });

  it("stops when a page is short or the sends run out, and at the page limit", async () => {
    const full = (from: number) => Array.from({ length: LIST_PAGE_SIZE }, (_, i) => row(from - i, { leaf_type: 0 }));
    const short = service([full(900), [row(5)]]);
    expect(await short.api().messagesFrom(0, WALLET, 75, 20)).toHaveLength(1);
    expect(short.urls).toHaveLength(2);
    const ran = service([full(900), full(700)], 2 * LIST_PAGE_SIZE);
    expect(await ran.api().messagesFrom(0, WALLET, 75, 20)).toEqual([]);
    expect(ran.urls).toHaveLength(2);
    const endless = service(Array.from({ length: 9 }, (_, p) => full(9000 - p * 300)), 5000);
    expect(await endless.api().messagesFrom(0, WALLET, 75, 20)).toEqual([]);
    expect(endless.urls).toHaveLength(LIST_MAX_PAGES);
  });

  it("flags a message whose bytes are over the cap instead of reading them, and reads them again under a raised cap", async () => {
    const big = "0x" + "ab".repeat(5000);
    const s = service([[row(2, { metadata: big }), row(1)]]);
    const [first, second] = await s.api().messagesFrom(0, WALLET, 75, 20);
    expect(first).toMatchObject({ depositCount: 2, metadata: "0x", tooLarge: true });
    expect(second).not.toHaveProperty("tooLarge");
    const raised = await service([[row(2, { metadata: big })]]).api({ maxMetadataBytes: 8192 }).messagesFrom(0, WALLET, 75, 20);
    expect(raised[0]).toMatchObject({ metadata: big });
    expect(raised[0]).not.toHaveProperty("tooLarge");
    const lowered = await service([[row(2)]]).api({ maxMetadataBytes: 4 }).messagesFrom(0, WALLET, 75, 20);
    expect(lowered[0]).toMatchObject({ tooLarge: true });
  });

  it("still refuses a token deposit with metadata over the cap, and takes a deposit by number under the message cap too", async () => {
    const big = "0x" + "ab".repeat(5000);
    const f = (async () => json({ bridges: [row(7, { leaf_type: 0, metadata: big })], count: 1 })) as unknown as typeof fetch;
    await expect(createAggkitReader({ baseUrl: BASE, fetch: f }).bridge(0, 7)).rejects.toBeInstanceOf(AggkitError);
    const m = (async () => json({ bridges: [row(7, { metadata: big })], count: 1 })) as unknown as typeof fetch;
    expect(await createAggkitReader({ baseUrl: BASE, fetch: m }).bridge(0, 7)).toMatchObject({ leafType: 1, tooLarge: true, metadata: "0x" });
  });

  it("is an error, not an empty list, when the service cannot answer, and refuses a wallet that is not an address", async () => {
    for (const status of [404, 503, 500]) {
      const f = (async () => json({}, status)) as unknown as typeof fetch;
      await expect(createAggkitReader({ baseUrl: BASE, fetch: f }).messagesFrom(0, WALLET, 75, 20)).rejects.toBeInstanceOf(AggkitError);
    }
    const bad = (async () => json({ bridges: "no", count: 1 })) as unknown as typeof fetch;
    await expect(createAggkitReader({ baseUrl: BASE, fetch: bad }).messagesFrom(0, WALLET, 75, 20)).rejects.toBeInstanceOf(AggkitError);
    await expect(service([]).api().messagesFrom(0, "0x12&network_ids=1", 75, 20)).rejects.toBeInstanceOf(TypeError);
  });
});

const KEY_URL = "https://sepolia.example.invalid/v3/hidden-part-one";
const BRIDGE = "0x528e26b25a34a4a5d0dbda1d57d318153d2ed582";
const BOARD = "0x1111111111111111111111111111111111111111";
interface Sent { method: string; params: unknown[] }
function chain(answer: (c: Sent) => unknown | Error, now = { t: 0 }, maxPerSecond?: number) {
  const calls: Sent[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { id: number; method: string; params: unknown[] };
    calls.push(body);
    const a = answer(body);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(a !== null && typeof a === "object" && "error" in a ? a : { result: a }) }));
  }) as unknown as typeof fetch;
  return { calls, now, api: createSepoliaReader({ url: new Secret(KEY_URL), bridge: BRIDGE, rollupManager: null, fetch: fetcher, now: () => now.t, ...(maxPerSecond === undefined ? {} : { maxPerSecond }) }) };
}
const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");

describe("the Ethereum Sepolia reader's reads for messages", () => {
  it("reads the bridge's pause state, kept for 30 s", async () => {
    const c = chain(() => word(1));
    expect(await c.api.paused()).toBe(true);
    expect(c.calls[0]).toMatchObject({ method: "eth_call", params: [{ to: BRIDGE, data: emergencyStateCall() }, "latest"] });
    await c.api.paused();
    expect(c.calls).toHaveLength(1);
    c.now.t = 31_000;
    await c.api.paused();
    expect(c.calls).toHaveLength(2);
    expect(await chain(() => word(0)).api.paused()).toBe(false);
  });

  it("asks whether an address has code with eth_getCode only, and keeps a yes longer than a no", async () => {
    const withCode = chain(() => "0x6080");
    expect(await withCode.api.hasCode(BOARD)).toBe(true);
    expect(withCode.calls[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [BOARD, "latest"] });
    const none = chain(() => "0x");
    expect(await none.api.hasCode(BOARD)).toBe(false);
    none.now.t = 6_000;
    await none.api.hasCode(BOARD);
    expect(none.calls).toHaveLength(2);
    withCode.now.t = 6_000;
    await withCode.api.hasCode(BOARD);
    expect(withCode.calls).toHaveLength(1);
    await expect(chain(() => "0x").api.hasCode("0x12")).rejects.toBeInstanceOf(TypeError);
  });

  it("simulates the exact calldata at the bridge from the fixed address that holds nothing: a revert is false, a pass true", async () => {
    const data = claimMessageCall({
      smtProofLocalExitRoot: Array.from({ length: 32 }, (_, i) => H(i)), smtProofRollupExitRoot: Array.from({ length: 32 }, (_, i) => H(100 + i)), globalIndex: "5", mainnetExitRoot: H(1), rollupExitRoot: H(2),
      originNetwork: 75, originTokenAddress: A(0xab), destinationNetwork: 0, destinationAddress: BOARD, amount: "0", metadata: "0x6869",
    });
    const accepting = chain(() => "0x");
    expect(await accepting.api.wouldPass(data)).toBe(true);
    expect(accepting.calls[0]).toMatchObject({ method: "eth_call", params: [{ from: SIMULATE_FROM, to: BRIDGE, data }, "latest"] });
    expect(accepting.calls[0]!.params[0]).toHaveProperty("gas");
    expect(await chain(() => ({ error: { code: 3, message: "execution reverted", data: "0x" } })).api.wouldPass(data)).toBe(false);
    expect(await chain(() => ({ error: { code: -32000, message: "execution reverted: MessageFailed()" } })).api.wouldPass(data)).toBe(false);
  });

  it("is an error, not a revert, when the node refuses the call for another reason, and never shows the endpoint", async () => {
    for (const refusal of [{ error: { code: -32005, message: "rate limit exceeded" } }, { error: "x" }]) {
      const e = await chain(() => refusal).api.wouldPass("0x1234").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SepoliaError);
      expect(String((e as Error).message)).not.toContain("hidden-part-one");
    }
    await expect(chain(() => new Error("connect hidden-part-one")).api.wouldPass("0x1234")).rejects.toThrow("Ethereum Sepolia cannot be reached");
    await expect(chain(() => "nothex").api.hasCode(BOARD)).rejects.toBeInstanceOf(SepoliaError);
  });

  it("reads a note board's noteOf for a sender, and null when the call reverts", async () => {
    const out = word(32);
    const c = chain(() => out);
    expect(await c.api.noteOf(BOARD, 75, A(0xab))).toBe(out);
    expect(c.calls[0]).toMatchObject({ method: "eth_call", params: [{ to: BOARD, data: noteOfCall(75, A(0xab)) }, "latest"] });
    expect(await chain(() => ({ error: { code: 3, message: "execution reverted" } })).api.noteOf(BOARD, 75, A(0xab))).toBeNull();
  });

  it("counts every new read against the total cap on calls to Sepolia, and answers busy with no call made", async () => {
    const c = chain(() => "0x", { t: 0 }, 2);
    await c.api.hasCode(BOARD);
    await c.api.wouldPass("0x01");
    for (const read of [() => c.api.paused(), () => c.api.hasCode(A(5)), () => c.api.wouldPass("0x02"), () => c.api.noteOf(BOARD, 0, A(1))]) await expect(read()).rejects.toBeInstanceOf(SepoliaBusy);
    expect(c.calls).toHaveLength(2);
  });
});
