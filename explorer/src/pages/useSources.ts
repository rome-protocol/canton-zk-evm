import { useQueries } from "@tanstack/react-query";
import { getContractSource } from "../api.ts";
import type { AbiEntry } from "../abi.ts";
import { labelKeys } from "../labels.ts";

/** The most contracts whose verified source one view reads (one request each, and an answer can be large; the REST limit is shared by the whole page). */
export const MAX_SOURCES = 20;

export interface Known { abi: AbiEntry[] | null }

export interface SourceReads {
  sources: Map<string, Known>;
  /** True once every read has settled, with an answer or an error. */
  ready: boolean;
  /** The addresses whose read failed. */
  failed: Set<string>;
}

/**
 * The verified ABI of each address given, read together (each address once, shared with the contract page's own reads). Give it only
 * addresses known to be contracts: an address with no verified source, or whose source cannot be read, has `abi` null.
 * `ready` and `failed` say whether the reads are done and which of them failed, for a view that must not speak before they are.
 */
export function useSourceReads(addresses: readonly (string | null | undefined)[]): SourceReads {
  const keys = labelKeys(addresses);
  const reads = useQueries({
    queries: keys.map((a) => ({ queryKey: ["contract-source", a], queryFn: () => getContractSource(a), retry: false, staleTime: 60_000 })),
  });
  const sources = new Map<string, Known>();
  const failed = new Set<string>();
  keys.forEach((a, i) => {
    const r = reads[i];
    const s = r?.data;
    if (r?.isError) failed.add(a);
    sources.set(a, { abi: s?.verified && Array.isArray(s.abi) && s.abi.length > 0 ? (s.abi as AbiEntry[]) : null });
  });
  return { sources, ready: reads.every((r) => !r.isPending), failed };
}

export const useSources = (addresses: readonly (string | null | undefined)[]): Map<string, Known> => useSourceReads(addresses).sources;
