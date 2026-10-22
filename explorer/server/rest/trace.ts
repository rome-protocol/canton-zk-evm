/** A transaction's call tree from reth (`trace_transaction`, the parity format), as flat frames: a frame's `traceAddress` places it in the tree. */
import { frame } from "../indexer/reads.ts";
import type { Reth } from "../reth.ts";
import { RethError } from "../reth.ts";

/** The most frames served for one transaction; the answer says when it is cut. */
export const MAX_FRAMES = 5000;

export interface CallFrame {
  traceAddress: number[]; type: "call" | "create" | "suicide"; callType: string; from: string; to: string | null; value: string; gas: number | null; gasUsed: number | null; input: string; error: string | null;
  /** The address a creation made. */
  created: string | null;
}

export type Trace = { frames: CallFrame[]; truncated: boolean };

/** The cut, parsed traces of the last transactions asked for, per reth client: the trace of a final transaction never changes. */
export const TRACE_CACHE_MAX = 64;
const caches = new WeakMap<object, Map<string, Trace>>();

export async function traceOf(reth: Pick<Reth, "rpc">, hash: string): Promise<Trace | null> {
  const cache = caches.get(reth) ?? caches.set(reth, new Map()).get(reth)!;
  const known = cache.get(hash);
  if (known) { cache.delete(hash); cache.set(hash, known); return known; }
  const made = await fetchTrace(reth, hash);
  if (made) {
    cache.set(hash, made);
    if (cache.size > TRACE_CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  return made;
}

async function fetchTrace(reth: Pick<Reth, "rpc">, hash: string): Promise<Trace | null> {
  const result = await reth.rpc("trace_transaction", [hash]);
  if (result === null) return null;
  if (!Array.isArray(result)) throw new RethError("trace_transaction: reth sent something that is not a list");
  let parsed;
  try {
    parsed = result.flatMap((x) => { const f = frame(x); return f ? [f] : []; });
  } catch (e) {
    throw new RethError(`trace_transaction: ${(e as Error).message}`);
  }
  return {
    frames: parsed.slice(0, MAX_FRAMES).map((f) => ({
      traceAddress: f.traceAddress, type: f.type, callType: f.callType, from: f.from, to: f.to, value: f.value.toString(), gas: f.gas, gasUsed: f.gasUsed, input: f.input, error: f.error, created: f.created?.address ?? null,
    })),
    truncated: parsed.length > MAX_FRAMES,
  };
}
