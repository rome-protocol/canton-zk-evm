import { useQuery } from "@tanstack/react-query";
import { getBlocks, getFaucetAddress, getInFlight, getStatsSeries, getStatsSummary, type ApiStatus, type BlockListItem, type InFlight, type StatsSeries, type StatsSummary } from "./api.ts";

/** What the home page's number cards take from the status and the in-flight route; the rest comes from the stats routes. */
export interface Summary {
  /** The newest final block, and the block being proven. */
  height: number | null;
  proving: number | null;
  /** Transactions that are not final: in a block being made or proven, and waiting in reth's pool. Null when the in-flight route has not answered; `waiting` is null when the pool has not been counted. */
  notFinal: { inBlocks: number; waiting: number | null } | null;
}

/** The middle and the 95th percentile of some times, and how many blocks they come from. */
export interface Spread { medianMs: number; p95Ms: number; blocks: number }

/** The time to final of the blocks given, from the producer's cut to Canton's record time, over those the producer's log has a time for; null when none has. Used by the lists that read the newest blocks. */
export const finalSpread = (blocks: BlockListItem[]): Spread | null => {
  const ms = blocks.flatMap((b) => (b.finalSeconds === null ? [] : [Math.max(0, b.finalSeconds * 1000)])).sort((a, b) => a - b);
  return ms.length ? { medianMs: Math.round(percentile(ms, 0.5)), p95Ms: Math.round(percentile(ms, 0.95)), blocks: ms.length } : null;
};

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;

/** The transactions that are not final yet, counted: those in blocks being proven (the attempts' counts) and those waiting in the pool (null when the pool is not counted). The in-flight route's list is capped, so its length is not a count. */
export const notFinalCounts = (flight: InFlight) => ({ inBlocks: flight.attempts.reduce((n, a) => n + (a.txCount ?? 0), 0), waiting: flight.poolWaiting?.waiting ?? null });

export const summarize = (status: ApiStatus, flight: InFlight | null): Summary => ({
  height: status.final?.number ?? null,
  proving: status.proving?.number ?? null,
  notFinal: flight ? notFinalCounts(flight) : null,
});

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

/** The hour and the day of the stats the home page's cards show, and the median time to final by the hour of the last 72 of them (the series route's 7-day window, cut). */
export const useHomeStats = () => {
  const hour = useQuery({ queryKey: ["stats-summary", "1h"], queryFn: () => getStatsSummary("1h"), refetchInterval: 30_000 });
  const day = useQuery({ queryKey: ["stats-summary", "24h"], queryFn: () => getStatsSummary("24h"), refetchInterval: 30_000 });
  const spark = useQuery({ queryKey: ["stats-series", "time_to_final_p50", "7d", "1h"], queryFn: () => getStatsSeries("time_to_final_p50", "7d", "1h"), refetchInterval: 60_000 });
  return { hour: fetched<StatsSummary>(hour), day: fetched<StatsSummary>(day), spark: fetched<StatsSeries>(spark) };
};
/** An answer and how it stands: the data is there when read, and kept while a later read fails or is under way. */
export interface Fetched<T> { data: T | null; read: Read }
const fetched = <T,>(q: { isError: boolean; data: T | undefined }): Fetched<T> => ({ data: q.data ?? null, read: readOf(q) });
