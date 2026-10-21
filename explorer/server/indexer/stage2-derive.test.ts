/** Stage 2's internal calls, contracts, proxies and counters, on the pinned PostgreSQL, with traces set by the tests in the shape reth gives them. */
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain, type BlockShape, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import type { TraceFrame } from "./reads.ts";
import { EIP1822_SLOT, EIP1967_BEACON_SLOT, EIP1967_IMPLEMENTATION_SLOT } from "./proxies.ts";

const opened: Indexer[] = [];
async function inDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  await withDatabase(async (pool) => {
    try {
      await fn(pool);
    } finally {
      for (const i of opened.splice(0)) await i.close().catch(() => undefined);
    }
  });
}

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const hexOf = (b: Buffer | null) => (b === null ? null : "0x" + b.toString("hex"));
const frame = (path: number[], over: Partial<TraceFrame> = {}): TraceFrame => ({
  traceAddress: path, type: "call", callType: "call", from: A(1), to: A(2), value: 0n, gas: 1000, gasUsed: 10, input: "0x", error: null, created: null, ...over,
});
const make = (path: number[], from: number, address: number, code = "0x6001", over: Partial<TraceFrame> = {}): TraceFrame =>
  frame(path, { type: "create", callType: "create", from: A(from), to: A(address), input: "0x6080", created: { address: A(address), code }, ...over });

/** Replaces the frames of transaction `k` of block `n` of the synthetic chain. */
function setFrames(chain: SyntheticChain, n: number, k: number, frames: TraceFrame[]) {
  const t = chain.blocks[n - 1]!.traces[k]!;
  t.frames = frames;
  t.calls = frames.length;
}

async function setup(pool: Pool, shapes: BlockShape[]) {
  await migrate(pool);
  const chain = makeChain(shapes);
  const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
  opened.push(indexer);
  await indexer.open();
  return { chain, indexer };
}
const rows = async (pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

describe.skipIf(!TEST_URL)("stage 2's internal calls, on the pinned PostgreSQL", () => {
  checkRequired();

  it("stores the calls that move value, the creations and the self-destructs, with the error of a failed inner call", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 5 }]);
      setFrames(chain, 1, 0, [
        frame([]), frame([0], { to: A(0xa1), value: 5n, input: "0xa9059cbb00", gas: 900, gasUsed: 40 }), frame([1], { callType: "staticcall" }),
        make([2], 0xa1, 0xc1), frame([2, 0], { type: "suicide", callType: "selfdestruct", from: A(0xc1), to: A(0xa1), value: 3n }),
        frame([3], { to: A(0xa2), value: 1n, error: "out of gas" }),
      ]);
      expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 1 });
      const calls = await rows(pool, "select tx_index, trace_address::text as path, call_type, encode(from_address, 'hex') as f, encode(to_address, 'hex') as t, value::text, gas, gas_used, encode(input_selector, 'hex') as sel, input_size, error from internal_calls order by trace_address");
      expect(calls.map((c) => [c.path, c.call_type, c.value, c.error])).toEqual([
        ["{0}", "call", "5", null], ["{2}", "create", "0", null], ["{2,0}", "selfdestruct", "3", null], ["{3}", "call", "1", "out of gas"],
      ]);
      expect(calls[0]).toMatchObject({ tx_index: 0, f: A(1).slice(2), t: A(0xa1).slice(2), gas: "900", gas_used: "40", sel: "a9059cbb", input_size: 5 });
      expect(calls[1]).toMatchObject({ f: A(0xa1).slice(2), t: A(0xc1).slice(2), sel: null });
      await indexer.close();
    });
  });

  it("counts nothing twice when a block is read again", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 5 }, { txs: 5 }]);
      setFrames(chain, 1, 1, [frame([]), frame([0], { to: A(0xa1), value: 5n })]);
      setFrames(chain, 2, 0, [frame([]), make([0], 0xa1, 0xc9)]);
      await indexer.runOnce();
      const before = await rows(pool, "select block_number, tx_index, trace_address::text from internal_calls order by 1, 2, 3");
      expect(before).toHaveLength(2);
      await pool.query("update cursors set position = 0, detail = null where stream = 'reader_updates'");
      await indexer.runOnce();
      expect(await rows(pool, "select block_number, tx_index, trace_address::text from internal_calls order by 1, 2, 3")).toEqual(before);
      await indexer.close();
    });
  });

  it("makes a contract of each creation that took effect: a factory's, with the code shared by clones, and none under a failed call or in a failed transaction", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 5 }]);
      // Transaction 2 deploys a factory, which makes a contract with CREATE and a clone of it (the same code) with CREATE2.
      setFrames(chain, 1, 2, [
        make([], 0xf000, 0xfac1, "0x60016000f3"), make([0], 0xfac1, 0xc1, "0x6001600055", { callType: "create" }), make([1], 0xfac1, 0xc2, "0x6001600055", { callType: "create2" }),
      ]);
      // Transaction 3 calls a contract that reverts after making one; transaction 4 failed.
      setFrames(chain, 1, 3, [frame([]), frame([0], { error: "Reverted" }), make([0, 0], 0xa1, 0xc3)]);
      setFrames(chain, 1, 4, [frame([], { error: "Reverted" }), make([0], 0xa1, 0xc4)]);
      await indexer.runOnce();
      const made = await rows(pool, "select encode(address, 'hex') as a, origin, encode(creator, 'hex') as creator, creation_block, creation_tx_index, creation_trace_address::text as path, encode(runtime_code_hash, 'hex') as rh, encode(creation_code_hash, 'hex') as ch from contracts order by address");
      expect(made.map((m) => [m.a, m.creator, m.creation_tx_index, m.path])).toEqual([
        [A(0xc1).slice(2), A(0xfac1).slice(2), 2, "{0}"], [A(0xc2).slice(2), A(0xfac1).slice(2), 2, "{1}"], [A(0xfac1).slice(2), A(0xf000).slice(2), 2, "{}"],
      ]);
      expect(made.every((m) => m.origin === "create" && m.creation_block === "1")).toBe(true);
      expect(made[0]!.rh).toBe(made[1]!.rh);
      expect(made[0]!.rh).not.toBe(made[2]!.rh);
      const codes = await rows(pool, "select encode(code, 'hex') as code, size from bytecodes order by code");
      expect(codes.map((x) => x.code)).toEqual(["6001600055", "60016000f3", "6080"]);
      expect(codes.find((x) => x.code === "6001600055")!.size).toBe(5);
      await indexer.close();
    });
  });

  it("marks a contract destroyed only when its code is gone, and counts the transactions sent to a contract after the one that made it", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 11 }, { txs: 5 }]);
      setFrames(chain, 1, 2, [frame([]), make([0], 0xa1, 0xc001), make([1], 0xa1, 0xc003), make([2], 0xa1, 0xd1), make([3], 0xa1, 0xd2),
        frame([3, 0], { type: "suicide", callType: "selfdestruct", from: A(0xd1), to: A(0xa1), value: 1n }), frame([3, 1], { type: "suicide", callType: "selfdestruct", from: A(0xd2), to: A(0xa1), value: 1n })]);
      // After EIP-6780 the contract that was not made in the same transaction keeps its code; the other has none.
      chain.reads.liveCode[A(0xd2)] = "0x6001";
      await indexer.runOnce();
      expect(await rows(pool, "select encode(address, 'hex') as a, destroyed_block from contracts where address in ($1, $2) order by address", [Buffer.from(A(0xd1).slice(2), "hex"), Buffer.from(A(0xd2).slice(2), "hex")]))
        .toEqual([{ a: A(0xd1).slice(2), destroyed_block: "1" }, { a: A(0xd2).slice(2), destroyed_block: null }]);
      // Block 1: transaction 0 went to 0xc000, 1 to 0xc001, 3 to 0xc003 (made by transaction 2, so after it), 5 to 0xc005. Block 2: transaction 1 went to 0xc001, 3 to 0xc003.
      const counts = async () => rows(pool, "select encode(address, 'hex') as a, interaction_count, last_interaction_block from contracts where address in ($1, $2) order by address",
        [Buffer.from(A(0xc001).slice(2), "hex"), Buffer.from(A(0xc003).slice(2), "hex")]);
      expect(await counts()).toEqual([{ a: A(0xc001).slice(2), interaction_count: "1", last_interaction_block: "2" }, { a: A(0xc003).slice(2), interaction_count: "2", last_interaction_block: "2" }]);
      await indexer.close();
    });
  });

  it("counts nothing twice when a block is read again, and a reindex keeps what is counted", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 11 }, { txs: 5 }]);
      setFrames(chain, 1, 2, [frame([]), make([0], 0xa1, 0xc003)]);
      await indexer.runOnce();
      const snapshot = async () => rows(pool, "select encode(address, 'hex') as a, creation_block, interaction_count, last_interaction_block, destroyed_block from contracts order by address");
      const before = await snapshot();
      expect(before.length).toBeGreaterThan(0);
      await pool.query("update cursors set position = 0, detail = null where stream = 'reader_updates'");
      await indexer.runOnce();
      expect(await snapshot()).toEqual(before);
      await indexer.close();
    });
  });

  it("detects the proxies among the new contracts: EIP-1967, a beacon, EIP-1822 and a minimal proxy, and not a plain contract", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 5 }]);
      const word = (a: number) => "0x" + a.toString(16).padStart(64, "0");
      const minimal = "0x363d3d373d3d3d363d73" + "bc".repeat(20) + "5af43d82803e903d91602b57fd5bf3";
      setFrames(chain, 1, 2, [frame([]), make([0], 0xa1, 0xb1), make([1], 0xa1, 0xb2), make([2], 0xa1, 0xb3), make([3], 0xa1, 0xb4, minimal), make([4], 0xa1, 0xb5)]);
      chain.reads.storage[`${A(0xb1)}:${EIP1967_IMPLEMENTATION_SLOT}`] = word(0x1111);
      chain.reads.storage[`${A(0xb2)}:${EIP1967_BEACON_SLOT}`] = word(0xbeac);
      chain.reads.callResults[`${A(0xbeac)}:0x5c60da1b`] = word(0x2222);
      chain.reads.storage[`${A(0xb3)}:${EIP1822_SLOT}`] = word(0x3333);
      await indexer.runOnce();
      const proxies = async () => rows(pool, "select encode(proxy, 'hex') as p, kind, encode(implementation, 'hex') as i, encode(beacon, 'hex') as b, checked_block from proxies order by proxy");
      const found = await proxies();
      expect(found).toEqual([
        { p: A(0xb1).slice(2), kind: "eip1967", i: A(0x1111).slice(2), b: null, checked_block: "1" },
        { p: A(0xb2).slice(2), kind: "beacon", i: A(0x2222).slice(2), b: A(0xbeac).slice(2), checked_block: "1" },
        { p: A(0xb3).slice(2), kind: "eip1822", i: A(0x3333).slice(2), b: null, checked_block: "1" },
        { p: A(0xb4).slice(2), kind: "eip1167", i: "bc".repeat(20), b: null, checked_block: "1" },
      ]);
      await pool.query("update cursors set position = 0, detail = null where stream = 'reader_updates'");
      await indexer.runOnce();
      expect(await proxies()).toEqual(found);
      await indexer.close();
    });
  });

  it("records a beacon that does not answer with no implementation, and finds no proxy in a contract that a failed call undid", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 5 }]);
      const word = (a: number) => "0x" + a.toString(16).padStart(64, "0");
      setFrames(chain, 1, 2, [frame([]), make([0], 0xa1, 0xb2)]);
      setFrames(chain, 1, 4, [frame([], { error: "Reverted" }), make([0], 0xa1, 0xb9)]);
      chain.reads.storage[`${A(0xb2)}:${EIP1967_BEACON_SLOT}`] = word(0xbeac);
      chain.reads.storage[`${A(0xb9)}:${EIP1967_IMPLEMENTATION_SLOT}`] = word(0x1111);
      await indexer.runOnce();
      expect(await rows(pool, "select kind, implementation, encode(beacon, 'hex') as b from proxies")).toEqual([{ kind: "beacon", implementation: null, b: A(0xbeac).slice(2) }]);
      await indexer.close();
    });
  });
});
