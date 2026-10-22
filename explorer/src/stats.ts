import { useQuery } from "@tanstack/react-query";
import { getBlocks, getInFlight, type ApiStatus, type BlockListItem, type InFlight } from "./api.ts";

/** What the home page's number cards show. */
export interface Summary {
  /** The newest final block, and the block being proven. */
  height: number | null;
  proving: number | null;
  /** From a block's own time to Canton's record of it, over the blocks given: the middle one and the 95th percentile, in ms. Null with no blocks. */
  timeToFinal: { medianMs: number; p95Ms: number; blocks: number } | null;
  /** The transactions in those blocks. */
  transactions: { count: number; blocks: number };
  /** Transactions that are not final: in a block being made or proven, and waiting in reth's pool. Null when the in-flight route has not answered; `waiting` is null when the pool has not been counted. */
  notFinal: { inBlocks: number; waiting: number | null } | null;
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;

/**
 * The numbers from what the API gives today: the status, the newest blocks and the in-flight attempts. This is the one place that changes when the
 * stats routes (`/api/stats/summary`) arrive: they will replace the window of ten blocks with the last hour and the last day, and add the cards
 * for proof time, commit time, rate, lost transactions and success. Nothing else on the page reads a number that is not made here.
 */
export function summarize(status: ApiStatus, blocks: BlockListItem[], flight: InFlight | null): Summary {
  const times = blocks.map((b) => Math.max(0, Date.parse(b.recordTime) - b.timestamp * 1000)).sort((a, b) => a - b);
  return {
    height: status.final?.number ?? null,
    proving: status.proving?.number ?? null,
    timeToFinal: times.length ? { medianMs: percentile(times, 0.5), p95Ms: percentile(times, 0.95), blocks: times.length } : null,
    transactions: { count: blocks.reduce((n, b) => n + b.txCount, 0), blocks: blocks.length },
    notFinal: flight ? { inBlocks: flight.attempts.reduce((n, a) => n + (a.txCount ?? 0), 0), waiting: flight.poolWaiting?.waiting ?? null } : null,
  };
}

/** What a page knows of a route it reads: not answered yet, failed, or answered. */
export type Read = "loading" | "error" | "ok";
export const readOf = (q: { isError: boolean; data: unknown }): Read => (q.isError ? "error" : q.data ? "ok" : "loading");

/** How the lists are asked for: every few seconds, and not at all while the live stream is up (it says when to ask again). */
export const listPoll = (live: boolean) => (live ? false : 5000);

export const useBlocks = (limit: number, live: boolean) => useQuery({ queryKey: ["blocks", limit], queryFn: () => getBlocks(limit), refetchInterval: listPoll(live) });
export const useInFlight = (live: boolean, enabled = true) => useQuery({ queryKey: ["in-flight"], queryFn: getInFlight, refetchInterval: listPoll(live), enabled });
