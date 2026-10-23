import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Page } from "../api.ts";

/**
 * Reads a list one page at a time. The API pages by a cursor (the `next` of the page before), so the pages are walked in order:
 * first, back, forward. There is no last page and no count of pages, because the server gives neither.
 */
export function usePaged<P extends Page<unknown>>(key: readonly unknown[], read: (cursor: string | null) => Promise<P>, refetchInterval: number | false = false) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  // A new list (another kind, sort, filter or address) starts at its first page, never at the old list's cursor.
  const listKey = JSON.stringify(key);
  const [seen, setSeen] = useState(listKey);
  if (seen !== listKey) { setSeen(listKey); setCursors([null]); }
  const at = seen !== listKey ? null : (cursors[cursors.length - 1] ?? null);
  const q = useQuery({ queryKey: [...key, at], queryFn: () => read(at), placeholderData: keepPreviousData, refetchInterval });
  // Placeholder data is the list before this one: its cursor belongs to that list, so it is never paged with.
  const next = q.isPlaceholderData ? null : (q.data?.next ?? null);
  return {
    data: q.data, error: q.error, isLoading: q.isLoading,
    page: seen !== listKey ? 1 : cursors.length,
    hasPrev: seen === listKey && cursors.length > 1,
    hasNext: next !== null,
    first: () => setCursors([null]),
    prev: () => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c)),
    forward: () => { if (next !== null) setCursors((c) => [...c, next]); },
  };
}

type Paged = Pick<ReturnType<typeof usePaged>, "page" | "hasPrev" | "hasNext" | "first" | "prev" | "forward">;

/** First, back, the page number and forward. Hidden when the list fits one page. */
export function Pager({ p, label }: { p: Paged; label: string }) {
  if (!p.hasPrev && !p.hasNext) return null;
  return (
    <nav className="pager" aria-label={label}>
      <button type="button" disabled={!p.hasPrev} onClick={p.first}>First</button>
      <button type="button" disabled={!p.hasPrev} onClick={p.prev} aria-label="Newer page">‹</button>
      <span className="pager-n" aria-current="page">Page {p.page}</span>
      <button type="button" disabled={!p.hasNext} onClick={p.forward} aria-label="Older page">›</button>
    </nav>
  );
}
