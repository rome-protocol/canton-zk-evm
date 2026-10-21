/**
 * Stage 2 of a block: what has to be worked out from its traces, behind the derive cursor (`cursors.stream = 'derive'`).
 *
 * This slice writes `tx_traces` only: each transaction's call count and the revert data of a failed one, with `Error(string)` and
 * `Panic(uint256)` decoded. The rest of the design's stage 2 (internal calls, contracts, tokens, balances) is added behind this same
 * function by the slices that follow. A transaction with no sub-call that did not fail has no row.
 */
import { decodeAbiParameters } from "viem";
import type { PoolClient } from "pg";
import { IndexerStop } from "./errors.ts";
import { clearStops } from "./health.ts";
import type { TxTrace } from "./reads.ts";

const ERROR_SELECTOR = "0x08c379a0", PANIC_SELECTOR = "0x4e487b71";
const PANIC: Record<string, string> = {
  "0x0": "generic compiler panic", "0x1": "assertion failed", "0x11": "arithmetic overflow or underflow", "0x12": "division or modulo by zero",
  "0x21": "invalid enum value", "0x22": "incorrectly encoded storage byte array", "0x31": "pop from an empty array", "0x32": "array index out of bounds",
  "0x41": "out of memory", "0x51": "call of a zero-initialised function pointer",
};

/** The reason a revert's data states, for `Error(string)` and `Panic(uint256)`; null for a custom error (decoded when served, from the ABI known then) or no data. */
export function revertReason(output: string): string | null {
  const selector = output.slice(0, 10);
  try {
    if (selector === ERROR_SELECTOR) {
      const [reason] = decodeAbiParameters([{ type: "string" }], `0x${output.slice(10)}`);
      return reason.replaceAll("\u0000", "");
    }
    if (selector === PANIC_SELECTOR) {
      const [code] = decodeAbiParameters([{ type: "uint256" }], `0x${output.slice(10)}`);
      const hex = "0x" + code.toString(16);
      return PANIC[hex] ? `Panic(${hex}): ${PANIC[hex]}` : `Panic(${hex})`;
    }
  } catch {
    // Data that starts with the selector but is not what the standard says is shown as the raw bytes, like a custom error.
  }
  return null;
}

const bytea = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");

export type Stage2Result = { derived: true; rows: number } | { derived: false };

/** The cursor of stage 2 (0 before any block). */
export async function deriveCursor(c: Pick<PoolClient, "query">): Promise<number> {
  const r = await c.query("select position from cursors where stream = 'derive'");
  return r.rowCount ? Number(r.rows[0].position) : 0;
}

/** What stage 2 derives for block `n` from its traces, checked against the transactions stage 1 holds, in the caller's transaction. */
async function deriveRows(c: Pick<PoolClient, "query">, n: number, traces: TxTrace[]) {
  // The traces must be those of the block's transactions, in order.
  const txs = (await c.query("select tx_index, hash, status from transactions where block_number = $1 order by tx_index", [n])).rows as { tx_index: number; hash: Buffer; status: number }[];
  if (txs.length !== traces.length || txs.some((t, k) => "0x" + t.hash.toString("hex") !== traces[k]!.transactionHash)) {
    throw new IndexerStop("derive", `block ${n}: reth's traces are not those of the block's ${txs.length} transactions, in order`, n, { traces: traces.length, transactions: txs.length });
  }
  return txs.flatMap((t, k) => {
    const trace = traces[k]!;
    const calls = Math.max(trace.calls - 1, 0);
    if (calls === 0 && t.status !== 0) return [];
    const data = t.status === 0 && trace.output !== "0x" ? trace.output : null;
    return [{ index: t.tx_index, calls, data, reason: data === null ? null : revertReason(data) }];
  });
}

async function insertRows(c: Pick<PoolClient, "query">, n: number, rows: Awaited<ReturnType<typeof deriveRows>>): Promise<void> {
  if (rows.length === 0) return;
  await c.query(
    `insert into tx_traces (block_number, tx_index, call_count, revert_data, revert_reason)
     select $1::bigint, t.i, t.calls, t.data, t.reason from unnest($2::int[], $3::int[], $4::bytea[], $5::text[]) as t(i, calls, data, reason)`,
    [n, rows.map((r) => r.index), rows.map((r) => r.calls), rows.map((r) => (r.data === null ? null : bytea(r.data))), rows.map((r) => r.reason)],
  );
}

/**
 * Stage 2's rows for a block the derive cursor has already passed, written again (the reindex): the block's old rows are deleted and the same
 * derivation writes the new ones, in the caller's transaction. The cursor is not touched.
 */
export async function rederive(c: Pick<PoolClient, "query">, n: number, traces: TxTrace[]): Promise<number> {
  const rows = await deriveRows(c, n, traces);
  await c.query("delete from tx_traces where block_number = $1", [n]);
  await insertRows(c, n, rows);
  return rows.length;
}

/** Stage 2 for block `n`, in the caller's database transaction. `traces` are reth's replay of the block's transactions, in order. */
export async function stage2(c: PoolClient, n: number, traces: TxTrace[]): Promise<Stage2Result> {
  // 1. Guard.
  const at = await c.query("select position from cursors where stream = 'derive' for update");
  const position = at.rowCount ? Number(at.rows[0].position) : 0;
  if (position >= n) return { derived: false };
  if (position !== n - 1) throw new IndexerStop("derive", `stage 2 is at block ${position} and was given block ${n}: it goes one block at a time`, n, { cursor: position });

  // 2 and 3. The traces must be those of the block's transactions, in order; then derive and write.
  const rows = await deriveRows(c, n, traces);
  await insertRows(c, n, rows);
  await c.query(
    `insert into cursors (stream, position, updated_at) values ('derive', $1, now())
     on conflict (stream) do update set position = excluded.position, updated_at = excluded.updated_at`,
    [n],
  );
  await clearStops(c, ["derive"]);
  await c.query("select pg_notify('derived_block', $1)", [String(n)]);
  return { derived: true, rows: rows.length };
}
