import { useQuery } from "@tanstack/react-query";

/** Where the explorer serves the check's .wasm file from. */
export const VERIFY_MODULE_URL = "/verify/zk_explorer_verify.wasm";

/** The size of the file in bytes, from the answer to a HEAD request, or undefined when the server does not say. Nothing is downloaded. */
export async function readModuleSize(url: string, fetcher: typeof fetch = (...args) => fetch(...args)): Promise<number | undefined> {
  try {
    const res = await fetcher(url, { method: "HEAD" });
    const length = res.ok ? res.headers.get("content-length") : null;
    return length !== null && /^\d+$/.test(length) && Number(length) > 0 ? Number(length) : undefined;
  } catch {
    return undefined;
  }
}

/** The file's size, asked once for the whole visit. */
export function useModuleSize(url: string): number | undefined {
  // A query's answer cannot be undefined, so "not known" is null in the cache.
  return useQuery({ queryKey: ["verify-module-size", url], queryFn: async () => (await readModuleSize(url)) ?? null, staleTime: Infinity, retry: false }).data ?? undefined;
}
