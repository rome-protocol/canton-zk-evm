import { useQueries } from "@tanstack/react-query";
import { getContractSource } from "../api.ts";
import type { AbiEntry } from "../abi.ts";
import { labelKeys } from "../labels.ts";

/** The most contracts whose verified source one view reads (one request each, and an answer can be large; the REST limit is shared by the whole page). */
export const MAX_SOURCES = 20;

export interface Known { abi: AbiEntry[] | null }

/**
 * The verified ABI of each address given, read together (each address once, shared with the contract page's own reads). Give it only
 * addresses known to be contracts: an address with no verified source, or whose source cannot be read, has `abi` null.
 */
export function useSources(addresses: readonly (string | null | undefined)[]): Map<string, Known> {
  const keys = labelKeys(addresses);
  const reads = useQueries({
    queries: keys.map((a) => ({ queryKey: ["contract-source", a], queryFn: () => getContractSource(a), retry: false, staleTime: 60_000 })),
  });
  const out = new Map<string, Known>();
  keys.forEach((a, i) => {
    const s = reads[i]?.data;
    out.set(a, { abi: s?.verified && Array.isArray(s.abi) && s.abi.length > 0 ? (s.abi as AbiEntry[]) : null });
  });
  return out;
}
