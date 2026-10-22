import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Page } from "../api.ts";

/**
 * A list of a known length, read a page at a time. A list that runs by a whole index (a block's transactions, in order; the blocks, newest first) is paged by the key of the
 * row before the page (`cursorOf`, the index of the last row before it for a list in order), so any page can be asked for, and the last page is known from the total.
 */
export function useNumbered<T>(key: readonly unknown[], total: number, per: number, read: (after: string | null) => Promise<Page<T>>, cursorOf: (page: number, per: number) => string = (n, k) => String((n - 1) * k - 1), refetchInterval: number | false = false) {
  const pages = Math.max(1, Math.ceil(total / per));
  const id = JSON.stringify(key);
  const [ask, setAsk] = useState({ id, n: 1 });
  const asked = ask.id === id ? ask.n : 1;
  const page = Math.min(asked, pages);
  const q = useQuery({ queryKey: [...key, page], queryFn: () => read(page > 1 ? cursorOf(page, per) : null), placeholderData: keepPreviousData, refetchInterval });
  const go = (n: number) => setAsk({ id, n: Math.min(Math.max(1, n), pages) });
  return { data: q.data, error: q.error, page, pages, from: (page - 1) * per, go };
}

/** First, back, "Page n of m", forward and last. Hidden when the list fits one page, unless `always`. */
export function NumberedPager({ p, label, always = false }: { p: Pick<ReturnType<typeof useNumbered>, "page" | "pages" | "go">; label: string; always?: boolean }) {
  if (p.pages < 2 && !always) return null;
  return (
    <nav className="pager" aria-label={label}>
      <button type="button" disabled={p.page === 1} onClick={() => p.go(1)}>First</button>
      <button type="button" disabled={p.page === 1} onClick={() => p.go(p.page - 1)} aria-label="Previous page">‹</button>
      <span className="pager-n" aria-current="page">Page {p.page} of {p.pages}</span>
      <button type="button" disabled={p.page === p.pages} onClick={() => p.go(p.page + 1)} aria-label="Next page">›</button>
      <button type="button" disabled={p.page === p.pages} onClick={() => p.go(p.pages)}>Last</button>
    </nav>
  );
}
