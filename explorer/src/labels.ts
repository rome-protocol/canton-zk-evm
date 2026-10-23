import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { ApiError, type Label } from "./api.ts";

/** The most addresses one /api/labels call answers (MAX_LABELS in the server's account routes). */
export const MAX_LABELS = 100;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UNREADABLE = "The explorer cannot read the chain right now.";

/** The addresses to ask for: valid ones only, in lowercase, each once, in the order they come. */
export function labelKeys(addresses: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const a of addresses) {
    const k = a?.toLowerCase();
    if (k && ADDRESS.test(k)) seen.add(k);
  }
  return [...seen];
}

export function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** One call to GET /api/labels, for at most MAX_LABELS lowercase addresses. */
export async function fetchLabels(addresses: readonly string[]): Promise<Label[]> {
  let res: Response;
  try {
    res = await fetch(`/api/labels?addresses=${addresses.join(",")}`, { headers: { accept: "application/json" } });
  } catch {
    throw new ApiError(UNREADABLE, 0);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : UNREADABLE, res.status);
  const items = body && typeof body === "object" && "items" in body ? body.items : null;
  if (!Array.isArray(items)) throw new ApiError(UNREADABLE, res.status);
  return items as Label[];
}

/** The name a label gives an address: "Test USD (tUSD)", the one of the two it has, or null when it has neither. */
export function labelName(label: Label | null | undefined): string | null {
  if (!label) return null;
  const { name, symbol } = label;
  if (name && symbol && name !== symbol) return `${name} (${symbol})`;
  return name ?? symbol ?? null;
}

export interface Labels {
  /** What is known of an address, whatever its case; undefined until the labels have been read, or for an address that was not asked for. */
  get(address: string | null | undefined): Label | undefined;
  /** The answer has come, or has failed: the page shows what it has. */
  ready: boolean;
}

const none: Labels = { get: () => undefined, ready: false };

/**
 * The labels of every address a page of rows shows, read together: one request for the page (more only past MAX_LABELS addresses),
 * never one per row. An address read before is kept, so a page that gains a row asks only for the new address. Where the labels
 * cannot be read the cells show the short address, as they do for an address the index holds nothing of.
 */
export function useLabels(addresses: readonly (string | null | undefined)[]): Labels {
  const client = useQueryClient();
  const keys = labelKeys(addresses);
  const id = keys.join(",");
  const query = useQuery({
    queryKey: ["labels", id],
    enabled: keys.length > 0,
    staleTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const found = new Map<string, Label>();
      const missing: string[] = [];
      for (const k of keys) {
        const known = client.getQueryData<Label>(["label", k]);
        if (known) found.set(k, known); else missing.push(k);
      }
      const parts = await Promise.all(chunks(missing, MAX_LABELS).map(fetchLabels));
      for (const l of parts.flat()) {
        const k = l.address.toLowerCase();
        client.setQueryData(["label", k], l);
        found.set(k, l);
      }
      return found;
    },
  });
  const data = query.data;
  const ready = keys.length === 0 || query.isSuccess || query.isError;
  return useMemo(() => (data || ready ? { get: (a) => (a ? data?.get(a.toLowerCase()) : undefined), ready } : none), [data, ready]);
}
