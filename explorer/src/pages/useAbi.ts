import { useQuery } from "@tanstack/react-query";
import { getContractSource, type ContractDetail } from "../api.ts";
import type { AbiEntry } from "../abi.ts";

const abiOf = (s: { verified: boolean; abi: unknown } | undefined): AbiEntry[] | null => (s?.verified && Array.isArray(s.abi) ? (s.abi as AbiEntry[]) : null);

/**
 * The ABIs a contract page can use: the contract's own, and for a proxy the implementation's. A proxy runs the implementation's code, so the
 * functions and events a person can call or read at the proxy's address are the implementation's. `ready` is false while either is being read.
 */
export function useAbi(c: ContractDetail) {
  const impl = c.proxy?.implementation ?? null;
  const own = useQuery({ queryKey: ["contract-source", c.address, c.matchType], queryFn: () => getContractSource(c.address) });
  const via = useQuery({ queryKey: ["contract-source", impl], queryFn: () => getContractSource(impl!), enabled: impl !== null });
  return {
    own: abiOf(own.data), implementation: abiOf(via.data), implementationAddress: impl,
    /** Every ABI known for this address, the implementation's first: what decodes a call or a log here. */
    all: [abiOf(via.data), abiOf(own.data)].flatMap((a) => (a ? [a] : [])).flat(),
    ready: !own.isLoading && (impl === null || !via.isLoading),
    error: own.error ?? via.error ?? null,
  };
}
