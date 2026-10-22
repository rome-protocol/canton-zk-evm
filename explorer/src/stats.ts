import { useQuery } from "@tanstack/react-query";
import { getBlocks, getFaucetAddress, getInFlight, type ApiStatus, type BlockListItem, type InFlight } from "./api.ts";

/** The middle and the 95th percentile of some times, and how many blocks they come from. */
export interface Spread { medianMs: number; p95Ms: number; blocks: number }

/** What the home page's number cards show. */
export interface Summary {
  /** The newest final block, and the block being proven. */
  height: number | null;
  proving: number | null;
  /** From the producer's cut of a block to Canton's record time, over the blocks given that the producer's log has times for: the middle one and the 95th percentile. */
  timeToFinal: Spread | null;
  /** ZisK's time per block, from the producer's log: the middle one and the 95th percentile, in ms, over the blocks the log has a time for. */
  proofTime: Spread | null;
  /** Canton's own commit, from the producer's submit to the record time, from the producer's log: the middle one and the 95th percentile over the blocks the log has a time for. */
  commitTime: Spread | null;
  /** The transactions in those blocks. */
  transactions: { count: number; blocks: number };
  /** Transactions that are not final: in a block being made or proven, and waiting in reth's pool. Null when the in-flight route has not answered; `waiting` is null when the pool has not been counted. */
  notFinal: { inBlocks: number; waiting: number | null } | null;
}

const spread = (seconds: Array<number | null>): Spread | null => {
  const ms = seconds.flatMap((v) => (v === null ? [] : [Math.max(0, v * 1000)])).sort((a, b) => a - b);
  return ms.length ? { medianMs: Math.round(percentile(ms, 0.5)), p95Ms: Math.round(percentile(ms, 0.95)), blocks: ms.length } : null;
};
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;

/**
 * The numbers from what the API gives today: the status, the newest blocks and the in-flight attempts. This is the one place that changes when the
 * stats routes (`/api/stats/summary`) arrive: they will replace the window of ten blocks with the last hour and the last day, and add the cards
 * for proof time, commit time, rate, lost transactions and success. Nothing else on the page reads a number that is not made here.
 */
export function summarize(status: ApiStatus, blocks: BlockListItem[], flight: InFlight | null): Summary {
  return {
    height: status.final?.number ?? null,
    proving: status.proving?.number ?? null,
    timeToFinal: spread(blocks.map((b) => b.finalSeconds)),
    proofTime: spread(blocks.map((b) => b.proofSeconds)),
    commitTime: spread(blocks.map((b) => b.commitSeconds)),
    transactions: { count: blocks.reduce((n, b) => n + b.txCount, 0), blocks: blocks.length },
    notFinal: flight ? { inBlocks: flight.attempts.reduce((n, a) => n + (a.txCount ?? 0), 0), waiting: flight.poolWaiting?.waiting ?? null } : null,
  };
}

/** The proof time a block usually takes: the 10th to the 90th percentile of the served proof times, so one slow proof does not stretch it. Null under three blocks with a time. */
export const usualProof = (blocks: BlockListItem[]): { lowMs: number; highMs: number } | null => {
  const ms = blocks.flatMap((b) => (b.proofSeconds === null ? [] : [Math.max(0, b.proofSeconds * 1000)])).sort((a, b) => a - b);
  return ms.length >= 3 ? { lowMs: Math.round(percentile(ms, 0.1)), highMs: Math.round(percentile(ms, 0.9)) } : null;
};

/** What a page knows of a route it reads: not answered yet, failed, or answered. */
export type Read = "loading" | "error" | "ok";
export const readOf = (q: { isError: boolean; data: unknown }): Read => (q.isError ? "error" : q.data ? "ok" : "loading");

/** How the lists are asked for: every few seconds, and not at all while the live stream is up (it says when to ask again). */
export const listPoll = (live: boolean) => (live ? false : 5000);

export const useBlocks = (limit: number, live: boolean) => useQuery({ queryKey: ["blocks", limit], queryFn: () => getBlocks(limit), refetchInterval: listPoll(live) });
export const useInFlight = (live: boolean, enabled = true) => useQuery({ queryKey: ["in-flight"], queryFn: getInFlight, refetchInterval: listPoll(live), enabled });

/** The faucet's address, the one address the explorer knows by name; null when it has none or cannot be asked. */
export const useFaucetAddress = () => useQuery({ queryKey: ["faucet-address"], queryFn: getFaucetAddress, staleTime: 60_000, retry: false }).data ?? null;
