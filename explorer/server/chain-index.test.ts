import { keccak256 } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { createChainIndex } from "./chain-index.ts";
import { createLedger } from "./ledger.ts";
import { createReth } from "./reth.ts";
import { FakeChain, hashOf, headerHex, txHash, updateIdOf } from "../test/fake-chain.ts";
import { FAKE_CONFIRMER, FAKE_OPERATOR, FAKE_READER, checkpoint, startFakeLedger, type FakeLedger } from "../test/fake-ledger.ts";
import { startFakeReth, type FakeReth } from "../test/fake-reth.ts";

const pins = { programVK: "0x" + "cd".repeat(32), rootC: "0x" + "ef".repeat(32), file: "guest.txt" };
const TOKEN = "0x" + "ca".repeat(20), PLAIN = "0x" + "cb".repeat(20);

let reth: FakeReth | undefined, ledger: FakeLedger | undefined;
afterEach(async () => { await reth?.close(); await ledger?.close(); });

async function setup(chain: FakeChain, party: string | null = FAKE_READER) {
  reth = await startFakeReth(chain.rethHandlers);
  ledger = await startFakeLedger(chain.items);
  return createChainIndex(createReth(reth.url, 2000), createLedger(ledger.url, 2000, party), pins, 100);
}
const threeBlocks = () => {
  const c = new FakeChain();
  c.tokens.set(TOKEN, ["Token A", "TKA", 18]);
  c.add({ txs: 0 });
  c.add({ txs: 2, creates: TOKEN });
  c.add({ txs: 1, creates: PLAIN });
  return c;
};

describe("walking the final blocks", () => {
  it("keeps what each block needs, found by number, hash or Canton update, newest first", async () => {
    const index = await setup(threeBlocks());
    await index.sync();
    expect(index.byNumber(2)).toEqual({
      number: 2, hash: hashOf(2), parentHash: hashOf(1), timestamp: 1_000_016, txCount: 2, gasUsed: 42000,
      updateId: updateIdOf(2), recordTime: "2026-10-04T01:37:12.412Z",
      proof: { programVK: { value: "0x" + "ee".repeat(32), ok: false }, rootC: { value: "0x" + "ee".repeat(32), ok: false }, blockHash: { value: null, ok: false } },
      headerHex: headerHex(2), txsHex: "02".repeat(20), proofHex: "ee".repeat(1344), hashesMatch: true,
    });
    expect(index.byHash(hashOf(3))?.number).toBe(3);
    expect(index.byUpdate(updateIdOf(1))?.number).toBe(1);
    expect(index.latest(2).map((b) => b.number)).toEqual([3, 2]);
    expect(index.head()?.number).toBe(3);
    expect(index.byNumber(4)).toBeUndefined();
    expect(index.status()).toMatchObject({ ok: true, offset: 6, lastLookAt: expect.any(Number), run: 1, genesisHash: "0x" + "90".repeat(32), genesisReferenced: true, signers: { operator: FAKE_OPERATOR, confirmer: FAKE_CONFIRMER } });
  });

  it("keeps each transaction's block and place, each created contract's transaction, and each token once", async () => {
    const chain = threeBlocks();
    const index = await setup(chain);
    await index.sync();
    expect(index.tx(txHash(2, 1))).toEqual({ block: 2, index: 1 });
    expect(index.tx(txHash(1, 0))).toBeUndefined();
    expect(index.contract(TOKEN)).toEqual({ txHash: txHash(2, 0), block: 2 });
    expect(index.token(TOKEN)).toEqual({ name: "Token A", symbol: "TKA", decimals: 18 });
    expect(index.token(PLAIN)).toBeNull();
    expect(index.token("0x" + "dd".repeat(20))).toBeNull(); // an address no block created is never read or remembered
    expect(chain.calls.filter((c) => c === "token")).toHaveLength(6); // three reads for each of the two contracts, and no more
  });

  it("reads the proof as a block record holds it, and takes a proof of the wrong length to have no facts", async () => {
    const chain = new FakeChain();
    chain.add({ onCanton: false });
    chain.commit(1, { proofHex: "ee".repeat(100) });
    const index = await setup(chain);
    await index.sync();
    expect(index.byNumber(1)?.proof).toBeNull();
  });
});

describe("before the first look", () => {
  it("is not healthy until a complete look has finished, and says when it did", async () => {
    const index = await setup(threeBlocks());
    expect(index.status()).toMatchObject({ ok: false, lastLookAt: null, offset: 0 });
    const before = Date.now();
    await index.sync();
    expect(index.status().ok).toBe(true);
    expect(index.status().lastLookAt).toBeGreaterThanOrEqual(before);
  });
});

/** A reth that holds every receipts read until `release` is called, and says when the first one arrives: the index is then in the middle of a look. */
function slowReth() {
  let release!: () => void, entered!: () => void;
  const open = new Promise<void>((ok) => (release = ok)), arrived = new Promise<void>((ok) => (entered = ok));
  return { release, arrived, gate: async (method: string) => { if (method === "eth_getBlockReceipts") { entered(); await open; } } };
}

describe("while a look is going on", () => {
  it("says it is starting, with the blocks read so far, and stops saying so when the first look is done", async () => {
    const chain = threeBlocks(), slow = slowReth();
    reth = await startFakeReth(chain.rethHandlers, { gate: slow.gate });
    ledger = await startFakeLedger(chain.items);
    const index = createChainIndex(createReth(reth.url, 2000), createLedger(ledger.url, 2000, FAKE_READER), pins, 100);
    expect(index.status().starting).toBe(true);
    const look = index.sync();
    await slow.arrived;
    expect(index.head()?.number).toBe(1);
    expect(index.status()).toMatchObject({ ok: false, starting: true, problems: [], error: null });
    slow.release();
    await look;
    expect(index.status()).toMatchObject({ ok: true, starting: false });
  });

  it("is not starting when the first look failed: that is a failure, with the reason", async () => {
    const index = await setup(threeBlocks(), null);
    await index.sync();
    expect(index.status()).toMatchObject({ ok: false, starting: false, error: expect.stringContaining("READER_PARTY") });
  });

  it("is not starting during a later look that follows a finished one", async () => {
    const chain = threeBlocks(), slow = slowReth();
    reth = await startFakeReth(chain.rethHandlers, { gate: (m) => (chain.blocks.length > 4 ? slow.gate(m) : undefined) });
    ledger = await startFakeLedger(chain.items);
    const index = createChainIndex(createReth(reth.url, 2000), createLedger(ledger.url, 2000, FAKE_READER), pins, 100);
    await index.sync();
    chain.add({ txs: 1 });
    const look = index.sync();
    await slow.arrived;
    expect(index.status()).toMatchObject({ ok: true, starting: false });
    slow.release();
    await look;
  });

  it("is not starting when a check has already failed, even though the first look is still going", async () => {
    const chain = threeBlocks(), slow = slowReth();
    chain.items.length = 0;
    chain.commit(1, { parentHash: "66".repeat(32) });
    chain.commit(2);
    chain.commit(3);
    reth = await startFakeReth(chain.rethHandlers, { gate: slow.gate });
    ledger = await startFakeLedger(chain.items);
    const index = createChainIndex(createReth(reth.url, 2000), createLedger(ledger.url, 2000, FAKE_READER), pins, 100);
    const look = index.sync();
    await slow.arrived;
    expect(index.head()?.number).toBe(1);
    expect(index.status()).toMatchObject({ ok: false, starting: false, error: null });
    expect(index.status().problems).toEqual([expect.stringMatching(/^block 1: .*genesis/)]);
    slow.release();
    await look;
    expect(index.status()).toMatchObject({ ok: false, starting: false });
  });

  it("starts again with no error when a new run begins straight after a look that failed", async () => {
    const chain = threeBlocks(), slow = slowReth();
    let hold = false;
    reth = await startFakeReth(chain.rethHandlers, { gate: (m) => (hold ? slow.gate(m) : undefined) });
    ledger = await startFakeLedger(chain.items);
    const index = createChainIndex(createReth(reth.url, 2000), createLedger(ledger.url, 2000, FAKE_READER), pins, 100);
    chain.blocks.splice(2, 1, null as never);
    await index.sync();
    expect(index.status()).toMatchObject({ starting: false, error: expect.stringContaining("block 2") });
    chain.restart("0x" + "91".repeat(32));
    chain.add({ txs: 1 });
    hold = true;
    const look = index.sync();
    await slow.arrived;
    expect(index.status()).toMatchObject({ ok: false, starting: true, run: 2, problems: [], error: null });
    slow.release();
    await look;
    expect(index.status()).toMatchObject({ ok: true, starting: false, run: 2 });
  });

  it("is starting again when a new run begins, even after a look that failed", async () => {
    const chain = threeBlocks(), slow = slowReth();
    let hold = false;
    reth = await startFakeReth(chain.rethHandlers, { gate: (m) => (hold ? slow.gate(m) : undefined) });
    ledger = await startFakeLedger(chain.items);
    const index = createChainIndex(createReth(reth.url, 2000), createLedger(ledger.url, 2000, FAKE_READER), pins, 100);
    const missing = chain.blocks.splice(2, 1, null as never)[0]!;
    await index.sync();
    expect(index.status()).toMatchObject({ starting: false, error: expect.stringContaining("block 2") });
    chain.blocks[2] = missing;
    await index.sync();
    expect(index.status()).toMatchObject({ ok: true, starting: false, run: 1 });
    chain.restart("0x" + "91".repeat(32));
    chain.add({ txs: 1 });
    hold = true;
    const look = index.sync();
    await slow.arrived;
    expect(index.status()).toMatchObject({ ok: false, starting: true, run: 2, problems: [], error: null });
    slow.release();
    await look;
    expect(index.status()).toMatchObject({ ok: true, starting: false, run: 2 });
  });
});

describe("following the head", () => {
  it("reads only what is new, and leaves out a block that is still being proven", async () => {
    const chain = threeBlocks();
    const index = await setup(chain);
    await index.sync();
    chain.add({ txs: 1, onCanton: false });
    await index.sync();
    expect(index.head()?.number).toBe(3);
    const seen = ledger!.requests.length;
    chain.commit(4);
    chain.calls.length = 0;
    await index.sync();
    expect(index.head()?.number).toBe(4);
    expect(ledger!.requests.slice(seen).filter((r) => r.path === "/v2/updates").map((r) => r.body?.beginExclusive)).toEqual([6]);
    expect(chain.calls.filter((c) => c === "receipts")).toHaveLength(1);
  });

  it("stops at a block it cannot read, and takes it up again from there", async () => {
    const chain = threeBlocks();
    const index = await setup(chain);
    const missing = chain.blocks.splice(2, 1, null as never)[0]!;
    await index.sync();
    expect(index.head()?.number).toBe(1);
    expect(index.status()).toMatchObject({ ok: false, offset: 2, error: expect.stringContaining("block 2") });
    chain.blocks[2] = missing;
    await index.sync();
    expect(index.head()?.number).toBe(3);
    expect(index.status()).toMatchObject({ ok: true, error: null });
  });

  it("keeps polling once started, and stops when told to", async () => {
    const chain = threeBlocks();
    const index = await setup(chain);
    const stop = index.start();
    await expect.poll(() => index.head()?.number, { timeout: 3000 }).toBe(3);
    chain.add({});
    await expect.poll(() => index.head()?.number, { timeout: 3000 }).toBe(4);
    stop();
  });

  it("names the block when reth fails while that block is read", async () => {
    const chain = threeBlocks();
    reth = await startFakeReth({ ...chain.rethHandlers, eth_getBlockReceipts: () => { throw new Error("boom"); } });
    ledger = await startFakeLedger(chain.items);
    const index = createChainIndex(createReth(reth.url, 2000), createLedger(ledger.url, 2000, FAKE_READER), pins, 100);
    await index.sync();
    expect(index.head()?.number).toBe(1);
    expect(index.status()).toMatchObject({ ok: false, error: expect.stringMatching(/^block 2: /) });
  });

  it("says why it is not reading when there is no reader party", async () => {
    const index = await setup(threeBlocks(), null);
    await index.sync();
    expect(index.head()).toBeUndefined();
    expect(index.status()).toMatchObject({ ok: false, error: expect.stringContaining("READER_PARTY") });
  });
});

describe("the checks on each block", () => {
  it("turns health red, naming the block, when reth's hash and the record's hash differ", async () => {
    const chain = threeBlocks();
    chain.items.length = 0;
    chain.commit(1);
    chain.commit(2, { blockHash: "77".repeat(32) });
    chain.commit(3);
    const index = await setup(chain);
    await index.sync();
    expect(index.byNumber(2)?.hashesMatch).toBe(false);
    expect(index.byNumber(3)?.hashesMatch).toBe(true);
    expect(index.status().ok).toBe(false);
    expect(index.status().problems).toEqual([expect.stringMatching(/^block 2: .*0x7777/)]);
  });

  it("turns health red when the record's header does not hash to the block", async () => {
    const chain = new FakeChain();
    chain.add({ onCanton: false });
    chain.commit(1, { headerHex: "f9".repeat(40) });
    const index = await setup(chain);
    await index.sync();
    expect(index.byNumber(1)?.hashesMatch).toBe(false);
    expect(index.status().problems).toEqual([expect.stringMatching(/^block 1: /)]);
  });

  it("checks that block 1's record names reth's genesis as its parent, and says nothing refers to it until block 1 commits", async () => {
    const chain = new FakeChain();
    chain.add({ onCanton: false });
    const index = await setup(chain);
    await index.sync();
    expect(index.status()).toMatchObject({ ok: true, genesisReferenced: false });
    chain.commit(1, { parentHash: "66".repeat(32) });
    await index.sync();
    expect(index.status()).toMatchObject({ ok: false, genesisReferenced: false });
    expect(index.status().problems).toEqual([expect.stringMatching(/^block 1: .*genesis/)]);
  });

  it("keeps only the block that commits when a block that was still being proven is replaced by another", async () => {
    const chain = threeBlocks();
    chain.add({ txs: 2, onCanton: false }); // block 4 as reth first made it
    const index = await setup(chain);
    await index.sync();
    expect(index.head()?.number).toBe(3);
    const header = "f8".repeat(39) + "04", hash = keccak256(`0x${header}`), other = "0x" + "aa".repeat(32);
    chain.blocks[4] = { ...chain.blocks[4]!, hash, transactions: [other] };
    chain.receipts[4] = [{ transactionHash: other, status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x7", contractAddress: null, logs: [] }];
    chain.commit(4, { blockHash: hash.slice(2), headerHex: header });
    await index.sync();
    expect(index.head()).toMatchObject({ number: 4, hash, txCount: 1, hashesMatch: true });
    expect(index.byHash(hashOf(4))).toBeUndefined();
    expect(index.tx(txHash(4, 0))).toBeUndefined();
    expect(index.tx(other)).toEqual({ block: 4, index: 0 });
    expect(index.status().ok).toBe(true);
  });

  it("will not skip a block: a record that is not the next number is an error, and nothing is kept past it", async () => {
    const chain = new FakeChain();
    chain.add({ onCanton: false });
    chain.add({});
    const index = await setup(chain);
    await index.sync();
    expect(index.head()).toBeUndefined();
    expect(index.status().error).toMatch(/next block is 1/);
  });
});

describe("a new run", () => {
  it("drops everything and walks the chain again when reth's genesis changes", async () => {
    const chain = threeBlocks();
    const index = await setup(chain);
    await index.sync();
    chain.restart("0x" + "91".repeat(32));
    chain.add({ txs: 1 });
    await index.sync();
    expect(index.head()?.number).toBe(1);
    expect(index.byNumber(3)).toBeUndefined();
    expect(index.tx(txHash(2, 1))).toBeUndefined();
    expect(index.contract(TOKEN)).toBeUndefined();
    expect(index.status()).toMatchObject({ ok: true, run: 2, genesisHash: "0x" + "91".repeat(32), genesisReferenced: true });
  });

  it("walks again when the new run has the same genesis and its ledger is already as far along, because the newest block is no longer reth's", async () => {
    const chain = threeBlocks();
    const index = await setup(chain);
    await index.sync();
    chain.restart();
    chain.add({ txs: 1 });
    chain.add({ txs: 1 });
    chain.add({ txs: 1 });
    chain.blocks[3] = { ...chain.blocks[3]!, hash: "0x" + "55".repeat(32) }; // the same number, a different block
    await index.sync();
    expect(index.status().run).toBe(2);
    expect(index.byNumber(1)).toBeDefined();
  });

  it("walks again when a new run with the same genesis passes the old offset before the index has held a block", async () => {
    const chain = new FakeChain();
    chain.items.push(checkpoint(10)); // the first run's ledger has moved on to offset 10 with no block record
    const index = await setup(chain);
    await index.sync();
    expect(index.head()).toBeUndefined();
    expect(index.status()).toMatchObject({ ok: true, offset: 0 });
    chain.restart(); // the second run, same genesis, and its blocks are at offsets 2 to 12
    for (let i = 0; i < 6; i++) chain.add({ txs: 1 });
    await index.sync();
    expect(index.head()?.number).toBe(6);
    expect(index.status()).toMatchObject({ ok: true, error: null, offset: 12 });
  });

  it("walks again when the ledger end is lower than the last offset it read", async () => {
    const chain = threeBlocks();
    const index = await setup(chain);
    await index.sync();
    chain.items.length = 0;
    chain.commit(1); // reth still holds the same blocks, so only the ledger shows a new run
    await index.sync();
    expect(index.status()).toMatchObject({ run: 2, offset: 2 });
    expect(index.head()?.number).toBe(1);
  });
});
