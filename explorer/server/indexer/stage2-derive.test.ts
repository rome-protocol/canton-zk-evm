/** Stage 2's internal calls, contracts, proxies and counters, on the pinned PostgreSQL, with traces set by the tests in the shape reth gives them. */
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain, type BlockShape, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import type { TraceFrame } from "./reads.ts";

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
});

export { hexOf };
