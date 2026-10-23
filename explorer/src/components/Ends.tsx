import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Page } from "../api.ts";

/**
 * A list with a known last page, read from both ends. The API pages by a key (the `next` of the page before), so a page is reached by walking: from the top (newest or most
 * first) by `newest`, and the last page by reading from the other end (`oldest`, `order=asc`) with exactly what the last page holds (the total modulo the page size, or a whole
 * page when it divides), so that the two ends never overlap. From the last page, back is further along that end's key, and the rows are drawn in the list's own order.
 * `go(n)` reaches the first and last pages and the one beside this: the ones the buttons ask for. The page count is the total the server gave over the page size.
 * `firstKey`, when given, is the query key of the first page read from the top, so a caller that reads that page itself (for a total shown elsewhere) shares one read with the list.
 */
export function useBothEnds<P extends Page<unknown> & { total?: number | null }>(
  key: readonly unknown[], per: number,
  newest: (cursor: string | null, limit: number) => Promise<P>, oldest: (cursor: string | null, limit: number) => Promise<P>,
  refetchInterval: number | false = false, firstKey?: readonly unknown[],
) {
  const id = JSON.stringify(key);
  const [st, setSt] = useState<{ id: string; end: boolean; keys: Array<string | null>; lastN: number }>({ id, end: false, keys: [null], lastN: per });
  // A new list (another kind, sort, filter) starts at its first page, never at the old list's key.
  const cur = st.id === id ? st : { id, end: false, keys: [null], lastN: per };
  const at = cur.keys[cur.keys.length - 1] ?? null;
  const q = useQuery<P>({
    queryKey: firstKey && !cur.end && at === null ? firstKey : [...key, cur.end, at, cur.end ? cur.lastN : per],
    queryFn: () => (cur.end ? oldest(at, cur.keys.length === 1 ? cur.lastN : per) : newest(at, per)),
    placeholderData: keepPreviousData,
    // A page read a moment ago is not read again by the list that mounts when the total arrives (the filtered list gives way to this one): one read, not two.
    staleTime: 1000,
    refetchInterval,
  });
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / per));
  const page = cur.end ? Math.max(1, pages - cur.keys.length + 1) : cur.keys.length;
  const ready = !q.isPlaceholderData && !!q.data;
  const items = q.data ? (cur.end ? [...q.data.items].reverse() : q.data.items) as P["items"] : undefined;
  const set = (end: boolean, keys: Array<string | null>, lastN = cur.lastN) => setSt({ id, end, keys, lastN });
  const go = (n: number) => {
    if (n === 1) return set(false, [null]);
    if (!ready || n < 1 || n > pages || n === page) return undefined;
    const next = q.data?.next ?? null;
    // A page beside this one is walked to; only the last page from further off is read from the other end.
    if (n === page + 1 && (cur.end ? cur.keys.length > 1 : next !== null)) return set(cur.end, cur.end ? cur.keys.slice(0, -1) : [...cur.keys, next]);
    if (n === page - 1 && (cur.end ? next !== null : cur.keys.length > 1)) return set(cur.end, cur.end ? [...cur.keys, next] : cur.keys.slice(0, -1));
    return n === pages ? set(true, [null], total % per || per) : undefined;
  };
  return { data: q.data, items, error: q.error, page, pages, from: (page - 1) * per, go };
}
