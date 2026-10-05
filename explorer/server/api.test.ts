import { afterEach, describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApi, FIELDS, NOT_FOUND } from "./api.ts";
import { createChainIndex } from "./chain-index.ts";
import { loadConfig } from "./config.ts";
import { createLedger } from "./ledger.ts";
import { createFaucet } from "./faucet.ts";
import { ALLOWED_METHODS, createReth } from "./reth.ts";
import { FakeChain, hashOf, txHash, updateIdOf } from "../test/fake-chain.ts";
import { FAKE_CONFIRMER, FAKE_OPERATOR, FAKE_READER, startFakeLedger, type FakeLedger } from "../test/fake-ledger.ts";
import { startFakeReth, type FakeReth } from "../test/fake-reth.ts";

const TOKEN = "0x" + "ca".repeat(20), ALICE = "0x" + "9a".repeat(20), BOB = "0x" + "5b".repeat(20), POOL_TX = "0x" + "ab".repeat(32);
const TRANSFER = "0xa9059cbb" + "0".repeat(24) + "5b".repeat(20) + (10n * 10n ** 18n).toString(16).padStart(64, "0");
const FAUCET_KEY = generatePrivateKey(), FAUCET_ADDRESS = privateKeyToAccount(FAUCET_KEY).address.toLowerCase();
const settings = "programVK=0x" + "cd".repeat(32) + "\nrootC=0x" + "ef".repeat(32) + "\n";

let reth: FakeReth | undefined, ledger: FakeLedger | undefined;
afterEach(async () => { await reth?.close(); await ledger?.close(); });

/** reth's methods for the pages: the chain's own handlers, `latest`, full transactions, and the lookups by hash. */
function handlers(chain: FakeChain) {
  const tx = (n: number, i: number) => ({
    hash: txHash(n, i), blockNumber: "0x" + n.toString(16), blockHash: hashOf(n), transactionIndex: "0x" + i.toString(16), from: ALICE, to: TOKEN,
    value: "0x0", nonce: "0x1", type: "0x2", gas: "0x186a0", input: TRANSFER,
  });
  const pool = { ...tx(1, 0), hash: POOL_TX, blockNumber: null, blockHash: null, transactionIndex: null };
  const base = chain.rethHandlers;
  const find = (h: string) => chain.blocks.flatMap((b, n) => (b.transactions as string[]).flatMap((x, i) => (x === h ? [[n, i] as const] : [])))[0];
  const read = (b: { number: string; transactions: string[] } | undefined, full: unknown) => (!b ? null : full ? { ...b, transactions: b.transactions.map((_, i) => tx(Number(b.number), i)) } : b);
  return {
    ...base,
    eth_getBlockByNumber: (p: unknown[]) => read(chain.blocks[p[0] === "latest" ? chain.blocks.length - 1 : Number(p[0])] as never, p[1]),
    eth_getBlockByHash: (p: unknown[]) => read(chain.blocks.find((b) => b.hash === p[0]) as never, p[1]),
    eth_getTransactionByHash: (p: unknown[]) => { const f = find(p[0] as string); return f ? tx(...f) : p[0] === POOL_TX ? pool : null; },
    eth_getTransactionReceipt: (p: unknown[]) => { const f = find(p[0] as string); return f ? chain.receipts[f[0]]![f[1]] : null; },
    eth_getBalance: (p: unknown[]) => "0x" + (p[0] === FAUCET_ADDRESS ? 1000n * 10n ** 18n : 5n * 10n ** 17n).toString(16),
    eth_gasPrice: "0x3b9aca07",
    eth_maxPriorityFeePerGas: "0x3b9aca00",
    eth_sendRawTransaction: (p: unknown[]) => keccak256(p[0] as Hex),
    eth_getTransactionCount: () => "0x3",
    eth_getCode: (p: unknown[]) => (chain.tokens.has(p[0] as string) ? "0x6080" : "0x"),
  };
}

/** Adds a `leaked` field to every object it holds, as a careless pass-through of the index's or the config's own objects would send it on. */
const leaky = <T>(x: T): T => (Array.isArray(x) ? (x.map(leaky) as T) : x && typeof x === "object" ? ({ ...Object.fromEntries(Object.entries(x).map(([k, v]) => [k, leaky(v)])), leaked: "x" } as T) : x);

interface Options { leak?: boolean; run?: { value: number }; faucet?: boolean; gate?: (method: string) => Promise<void> | void; firstLook?: "wait" | "go" }

/** With `firstLook: "go"` the index's first look is started and not waited for, and `look` is it: the answers are then those of a look in progress. */
async function boot(chain: FakeChain, { leak = false, run, faucet = false, gate, firstLook = "wait" }: Options = {}) {
  reth = await startFakeReth(handlers(chain), { gate });
  ledger = await startFakeLedger(chain.items);
  const real = loadConfig({ READER_PARTY: FAKE_READER, PINS_FILE: "guest.txt" }, () => settings);
  const config = leak ? leaky(real) : real;
  const r = createReth(reth.url, 2000), l = createLedger(ledger.url, 2000, FAKE_READER);
  const built = createChainIndex(r, l, real.pins, 100);
  const look = built.sync();
  if (firstLook === "wait") await look;
  const index: typeof built = {
    ...built,
    status: () => ({ ...(leak ? leaky(built.status()) : built.status()), ...(run ? { run: run.value } : {}) }),
    head: () => (leak ? leaky(built.head()) : built.head()),
    byNumber: (n) => (leak ? leaky(built.byNumber(n)) : built.byNumber(n)),
    byHash: (h) => (leak ? leaky(built.byHash(h)) : built.byHash(h)),
    byUpdate: (u) => (leak ? leaky(built.byUpdate(u)) : built.byUpdate(u)),
    latest: (n) => (leak ? leaky(built.latest(n)) : built.latest(n)),
    token: (a) => (leak ? leaky(built.token(a)) : built.token(a)),
    tx: (h) => (leak ? leaky(built.tx(h)) : built.tx(h)),
    contract: (a) => (leak ? leaky(built.contract(a)) : built.contract(a)),
  };
  const key = faucet ? FAUCET_KEY : null;
  const api = createApi({ config, reth: r, ledger: l, index, faucet: createFaucet({ key, chainId: real.chainId, ...real.faucet, reth: r }) });
  return { api, look, get: (target: string) => api("GET", target) };
}

const chain = () => {
  const c = new FakeChain();
  c.tokens.set(TOKEN, ["Token A", "TKA", 18]);
  c.add({ txs: 0 });
  c.add({ txs: 1, creates: TOKEN });
  c.add({ txs: 1, onCanton: false }); // made by reth, not on Canton yet
  return c;
};
const keys = (o: unknown) => Object.keys(o as object).sort();
const same = (o: unknown, fields: readonly string[]) => expect(keys(o)).toEqual([...fields].sort());
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Every object in an answer carries exactly its listed fields, the nested ones too. */
function checkFields(kind: "status" | "block" | "tx" | "address", body: unknown) {
  const b = body as Obj;
  same(b, FIELDS[kind]);
  if (kind === "status") {
    same(b.coin, FIELDS.coin); same(b.pins, FIELDS.pins); same(b.faucet, FIELDS.faucet);
    if (b.final) same(b.final, FIELDS.final);
    if (b.proving) same(b.proving, FIELDS.proving);
    if (b.signers) same(b.signers, FIELDS.signers);
    for (const l of b.latest) same(l, FIELDS.latest);
  } else if (kind === "block") {
    if (b.canton) {
      same(b.canton, FIELDS.canton);
      if (b.canton.proof) { same(b.canton.proof, FIELDS.proof); for (const f of ["programVK", "rootC", "blockHash"]) same(b.canton.proof[f], FIELDS.fact); }
    }
    for (const t of b.transactions) { same(t, FIELDS.blockTx); if (t.transfer) same(t.transfer, FIELDS.transfer); }
  } else if (kind === "tx") {
    if (b.block) same(b.block, FIELDS.txBlock);
    if (b.transfer) same(b.transfer, FIELDS.transfer);
    for (const l of b.logs) same(l, FIELDS.log);
  } else {
    if (b.token) same(b.token, FIELDS.token);
    if (b.createdBy) same(b.createdBy, FIELDS.createdBy);
  }
}

/** One of each answer, with a log on the transaction in block 2. */
const answers = (chain: FakeChain): ["status" | "block" | "tx" | "address", string][] => {
  chain.receipts[2]![0]!.logs = [{ address: TOKEN, topics: ["0x" + "dd".repeat(32)], data: "0x01" }];
  return [
    ["status", "/api/status"], ["block", "/api/block/0"], ["block", "/api/block/1"], ["block", "/api/block/2"], ["block", "/api/block/3"],
    ["tx", `/api/tx/${txHash(2, 0)}`], ["tx", `/api/tx/${txHash(3, 0)}`], ["tx", `/api/tx/${POOL_TX}`],
    ["address", `/api/address/${TOKEN}`], ["address", `/api/address/${BOB}`],
  ];
};

describe("status and health", () => {
  it("says it is starting, not failed, while the first look is still reading the blocks", async () => {
    let release!: () => void, entered!: () => void;
    const open = new Promise<void>((ok) => (release = ok)), arrived = new Promise<void>((ok) => (entered = ok));
    const gate = async (method: string) => { if (method === "eth_getBlockReceipts") { entered(); await open; } };
    const { get, look } = await boot(chain(), { gate, firstLook: "go" });
    await arrived;
    const { status, body } = await get("/api/status");
    checkFields("status", body);
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, starting: true, problems: [], evm: true, canton: true, final: { number: 1 }, latest: [{ number: 1 }] });
    release();
    await look;
    expect(await get("/api/status")).toMatchObject({ status: 200, body: { ok: true, starting: false } });
  });

  it("says it has failed, not that it is starting, when the first look could not finish", async () => {
    const c = chain();
    c.blocks[2] = null as never;
    const { body } = await (await boot(c)).get("/api/status");
    expect(body).toMatchObject({ ok: false, starting: false, problems: [] });
  });

  it("says what is final and what is being proven, with the settings the pages need", async () => {
    const { get } = await boot(chain());
    const { status, body } = await get("/api/status");
    expect(status).toBe(200);
    checkFields("status", body);
    expect(body).toMatchObject({
      latest: [
        { number: 2, hash: hashOf(2), txCount: 1, updateId: updateIdOf(2) },
        { number: 1, hash: hashOf(1), txCount: 0, updateId: updateIdOf(1) },
      ],
      chainId: 770101, coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: "0x" + "cd".repeat(32), file: "guest.txt" }, ok: true, evm: true, canton: true,
      final: { number: 2, hash: hashOf(2) }, proving: { number: 3, hash: hashOf(3) }, signers: { operator: FAKE_OPERATOR, confirmer: FAKE_CONFIRMER }, faucet: { on: false },
    });
  });

  it("lists the newest ten final blocks, newest first, and no more", async () => {
    const c = new FakeChain();
    c.tokens.set(TOKEN, ["Token A", "TKA", 18]);
    for (let i = 0; i < 12; i++) c.add({ txs: 0 });
    const { body } = await (await boot(c)).get("/api/status");
    const latest = (body as Obj).latest as Obj[];
    expect(latest.map((x) => x.number)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(latest[0]).toEqual({ number: 12, hash: hashOf(12), timestamp: 1_000_096, txCount: 0, updateId: updateIdOf(12), recordTime: expect.stringMatching(/^2026-10-04T/) });
  });

  it("has an empty list before any block is final", async () => {
    const c = new FakeChain();
    expect(((await (await boot(c)).get("/api/status")).body as Obj).latest).toEqual([]);
  });

  it("goes red, with the same answer on both routes, when reth cannot be reached", async () => {
    const { api, get } = await boot(chain());
    await reth!.close();
    const status = await get("/api/status"), health = await api("GET", "/healthz");
    expect(status.body).toMatchObject({ ok: false, evm: false, canton: true });
    expect(health).toEqual({ status: 503, body: status.body });
  });
});

describe("blocks", () => {
  it("gives a final block's two sides, and the record's three fields as hex, by number, hash or update", async () => {
    const { get } = await boot(chain());
    const { status, body } = await get("/api/block/2");
    expect(status).toBe(200);
    checkFields("block", body);
    expect(body).toMatchObject({
      status: "final", number: 2, hash: hashOf(2), txCount: 1, genesisReferenced: null,
      canton: { updateId: updateIdOf(2), hashesMatch: true, proofHex: "ee".repeat(1344), txsHex: "02".repeat(20), proof: { programVK: { ok: false } } },
      transactions: [{ hash: txHash(2, 0), from: ALICE, to: TOKEN, success: true, transfer: { symbol: "TKA", decimals: 18, to: BOB, value: (10n ** 19n).toString() } }],
    });
    expect((await get(`/api/block/${hashOf(2)}`)).body).toEqual(body);
    expect((await get(`/api/block/${hashOf(2).toUpperCase().replace("0X", "0x")}`)).body).toEqual(body); // case does not matter
  });

  it("gives a block being proven with no Canton side, and the genesis with its link to block 1", async () => {
    const { get } = await boot(chain());
    expect((await get("/api/block/3")).body).toMatchObject({ status: "proving", number: 3, canton: null });
    expect((await get("/api/block/0")).body).toMatchObject({ status: "genesis", number: 0, canton: null, genesisReferenced: true });
  });

  it("answers 404 for a block nobody has, and 400 for something that is not a block", async () => {
    const { get } = await boot(chain());
    expect((await get("/api/block/9")).status).toBe(404);
    expect((await get("/api/block/nope")).status).toBe(400);
  });
});

describe("transactions and addresses", () => {
  it("gives a transaction as Final, Being proven or Waiting, with the decoded token transfer and the fee", async () => {
    const { get } = await boot(chain());
    const final = await get(`/api/tx/${txHash(2, 0)}`);
    checkFields("tx", final.body);
    expect(final.body).toMatchObject({
      status: "final", block: { number: 2, updateId: updateIdOf(2) }, success: true, fee: String(0x5208 * 7), toToken: "TKA", transfer: { symbol: "TKA", to: BOB }, created: TOKEN,
    });
    expect((await get(`/api/tx/${txHash(3, 0)}`)).body).toMatchObject({ status: "proving", block: { number: 3, updateId: null } });
    expect((await get(`/api/tx/${POOL_TX}`)).body).toMatchObject({ status: "waiting", block: null, success: null, fee: null });
    expect((await get(`/api/tx/0x${"00".repeat(32)}`)).status).toBe(404);
  });

  it("gives an account, a token, and the transaction that made a contract", async () => {
    const { get } = await boot(chain());
    const account = await get(`/api/address/${BOB}`);
    checkFields("address", account.body);
    expect(account.body).toMatchObject({ address: BOB, kind: "account", balance: String(5n * 10n ** 17n), nonce: 3, token: null, createdBy: null });
    expect((await get(`/api/address/${TOKEN}`)).body).toMatchObject({ kind: "token", token: { symbol: "TKA" }, createdBy: { txHash: txHash(2, 0), block: 2 } });
    expect((await get("/api/address/0x12")).status).toBe(400);
  });
});

describe("search", () => {
  it("works out what was typed from its shape, and says what it takes when nothing is found", async () => {
    const { get } = await boot(chain());
    const path = async (q: string) => (await get(`/api/search?q=${encodeURIComponent(q)}`)).body;
    expect(await path(" 2 ")).toEqual({ path: "/block/2" });
    expect(await path(txHash(2, 0))).toEqual({ path: `/tx/${txHash(2, 0)}` });
    expect(await path(POOL_TX)).toEqual({ path: `/tx/${POOL_TX}` });
    expect(await path(hashOf(1))).toEqual({ path: `/block/${hashOf(1)}` });
    expect(await path(BOB)).toEqual({ path: `/address/${BOB}` });
    expect(await path(updateIdOf(2))).toEqual({ path: "/block/2" });
    for (const q of ["", "9", "hello", "0x" + "00".repeat(32), "1220" + "00".repeat(32)]) expect(await get(`/api/search?q=${q}`)).toEqual({ status: 404, body: { error: NOT_FOUND } });
  });
});

describe("fields", () => {
  it("gives every object of every answer exactly its listed fields", async () => {
    const c = chain(), { get } = await boot(c);
    for (const [kind, target] of answers(c)) checkFields(kind, (await get(target)).body);
  });

  it("builds each object field by field, so nothing an inner object carries is passed on", async () => {
    const c = chain(), { get } = await boot(c, { leak: true });
    for (const [kind, target] of answers(c)) {
      const { body } = await get(target);
      expect(JSON.stringify(body)).not.toContain("leaked");
      checkFields(kind, body);
    }
  });
});

describe("the faucet routes", () => {
  const ask = (api: Awaited<ReturnType<typeof boot>>["api"], address: unknown) => api("POST", "/api/faucet", JSON.stringify({ address }));

  it("gives the coin and answers with the transaction's hash, the address and the amount, and nothing else", async () => {
    const { api } = await boot(chain(), { faucet: true });
    const answer = await ask(api, BOB);
    expect(answer.status).toBe(200);
    same(answer.body, FIELDS.faucetSent);
    expect(answer.body).toMatchObject({ to: BOB, amount: (10n ** 18n).toString() });
    expect((answer.body as Obj).hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("answers 429 with Retry-After for an address that was served, and for a send close behind another", async () => {
    const { api } = await boot(chain(), { faucet: true });
    await ask(api, BOB);
    const again = await ask(api, BOB);
    expect(again).toMatchObject({ status: 429, headers: { "Retry-After": expect.stringMatching(/^\d+$/) } });
    expect(Object.keys(again.body as object)).toEqual(["error", "reason"]);
    expect(again.body).toMatchObject({ reason: "address" });
    const close = await ask(api, ALICE);
    expect(close.status).toBe(429);
    expect(close.body).toMatchObject({ reason: "busy" });
  });

  it("answers 400 to a body that is not JSON, to no address, and to a bad address", async () => {
    const { api } = await boot(chain(), { faucet: true });
    for (const body of ["not json", "", "[]", "null", "5", "{}", JSON.stringify({ address: 5 }), JSON.stringify({ address: "0x12" })]) {
      expect((await api("POST", "/api/faucet", body)).status).toBe(400);
    }
    expect((await api("POST", "/api/faucet")).status).toBe(400);
  });

  it("answers 503 when the faucet is off, whatever is asked", async () => {
    const { api } = await boot(chain());
    expect((await ask(api, BOB)).status).toBe(503);
    expect((await api("POST", "/api/faucet", "not json")).status).toBe(503);
    expect((await api("POST", "/api/faucet")).body).toEqual({ error: "The faucet is off." });
  });

  it("shows, on GET, whether it is on, its address and balance, and what it gives, with exactly its fields", async () => {
    const on = await (await boot(chain(), { faucet: true })).get("/api/faucet");
    expect(on.status).toBe(200);
    same(on.body, FIELDS.faucetInfo);
    expect(on.body).toEqual({ on: true, address: FAUCET_ADDRESS, balance: (1000n * 10n ** 18n).toString(), amount: (10n ** 18n).toString(), perAddressSeconds: 86400 });
    await reth?.close(); await ledger?.close();
    const off = await (await boot(chain())).get("/api/faucet");
    expect(off.body).toEqual({ on: false, address: null, balance: null, amount: (10n ** 18n).toString(), perAddressSeconds: 86400 });
  });

  it("says in the status whether the faucet is on", async () => {
    expect(((await (await boot(chain(), { faucet: true })).get("/api/status")).body as Obj).faucet).toEqual({ on: true });
    await reth?.close(); await ledger?.close();
    expect(((await (await boot(chain())).get("/api/status")).body as Obj).faucet).toEqual({ on: false });
  });

  it("answers 405 to other methods", async () => {
    const { api } = await boot(chain(), { faucet: true });
    for (const m of ["PUT", "DELETE", "PATCH"]) expect((await api(m, "/api/faucet")).status).toBe(405);
    expect((await api("POST", "/api/faucet/extra", "{}")).status).toBe(404);
  });

  it("never lets the key into an answer", async () => {
    const { api } = await boot(chain(), { faucet: true });
    const text = JSON.stringify([await ask(api, BOB), await ask(api, BOB), await api("GET", "/api/faucet"), await api("GET", "/api/status")]);
    expect(text).not.toContain(FAUCET_KEY.slice(2));
  });
});

describe("the rest of the routes", () => {
  it("answers 404 or 405 elsewhere", async () => {
    const { api } = await boot(chain());
    expect((await api("POST", "/api/status")).status).toBe(405);
    expect((await api("GET", "/api/nothing")).status).toBe(404);
  });

  it("answers 404 for names that every object has, and never reads them as routes", async () => {
    const { api } = await boot(chain());
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(await api("GET", `/api/${name}`)).toEqual({ status: 404, body: { error: "No such route." } });
      expect((await api("GET", `/api/${name}/x`)).status).toBe(404);
    }
  });

  it("answers 400 for a target that is not a path, and does not throw", async () => {
    const { api } = await boot(chain());
    for (const target of ["//", "///", "//x/api/status"]) expect((await api("GET", target)).status).toBe(400);
  });

  it("answers 502, naming nothing internal, when reth fails mid-request", async () => {
    const { get } = await boot(chain());
    await reth!.close();
    const { status, body } = await get(`/api/tx/${txHash(2, 0)}`);
    expect(status).toBe(502);
    expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1|fetch/);
  });
});

describe("tokens the index does not hold", () => {
  const unheld = () => {
    const c = new FakeChain();
    c.tokens.set(TOKEN, ["Token A", "TKA", 18]);
    c.add({ txs: 3 }); // three transfers to a token that no block created
    return c;
  };
  const tokenCalls = () => reth!.calls.filter((m) => m === "eth_call").length;

  it("asks reth for the token once, however many transfers of a block go to it, and once more for nothing", async () => {
    const { get } = await boot(unheld());
    const first = (await get("/api/block/1")).body as Obj;
    expect(first.transactions.map((t: Obj) => t.transfer.symbol)).toEqual(["TKA", "TKA", "TKA"]);
    expect(tokenCalls()).toBe(3); // name, symbol, decimals: one set, not three
    await get("/api/block/1");
    await get(`/api/tx/${txHash(1, 0)}`);
    expect(tokenCalls()).toBe(3);
  });

  it("forgets them when the index starts a new run", async () => {
    const run = { value: 1 }, c = unheld();
    const { get } = await boot(c, { run });
    const symbol = async () => ((await get("/api/block/1")).body as Obj).transactions[0].transfer.symbol;
    expect(await symbol()).toBe("TKA");
    c.tokens.set(TOKEN, ["Token B", "TKB", 18]);
    expect(await symbol()).toBe("TKA"); // same run: kept
    run.value = 2;
    expect(await symbol()).toBe("TKB");
  });
});

describe("what the server touches", () => {
  it("calls only listed methods on reth and only the two reads on Canton, naming only the reader party and the block record", async () => {
    const { get, api } = await boot(chain(), { faucet: true });
    await api("POST", "/api/faucet", JSON.stringify({ address: BOB }));
    for (const t of ["/api/faucet", "/api/status", "/api/block/2", "/api/block/3", "/api/block/0", `/api/tx/${txHash(2, 0)}`, `/api/address/${TOKEN}`, `/api/search?q=${hashOf(1)}`]) await get(t);
    expect(reth!.calls.length).toBeGreaterThan(5);
    for (const m of reth!.calls) expect(ALLOWED_METHODS.has(m)).toBe(true);
    const seen = ledger!.requests.map((r) => `${r.method} ${r.path}`);
    expect(new Set(seen)).toEqual(new Set(["GET /v2/state/ledger-end", "POST /v2/updates"]));
    for (const r of ledger!.requests.filter((x) => x.body)) {
      const text = JSON.stringify(r.body);
      expect(text).toContain(FAKE_READER);
      expect(text.match(/::1220/g)).toHaveLength(1); // one party, and no other
      expect(text).toContain("Zk.Chain:BlockRecord");
    }
  });

  it("never lets a party id other than the two signers into any answer", async () => {
    const { get } = await boot(chain());
    const search = `/api/search?q=${encodeURIComponent(updateIdOf(2))}`;
    for (const t of ["/api/status", "/api/block/0", "/api/block/1", "/api/block/2", "/api/block/3", `/api/tx/${txHash(2, 0)}`, `/api/address/${TOKEN}`, search, `/api/search?q=${BOB}`, `/api/search?q=${"1220" + "00".repeat(32)}`]) {
      const text = JSON.stringify((await get(t)).body);
      expect(text).not.toMatch(/builder::|reader::/);
    }
  });
});
