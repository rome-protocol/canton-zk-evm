// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useBothEnds } from "./Ends.tsx";

// A list whose total grows between polls, as the transactions of a live chain do.
describe("useBothEnds on the end walk while the total grows", () => {
  const wrap = (c: QueryClient) => ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: c }, children);

  it("keeps the page count from the total at the click on Last, so the page number and what it holds agree", async () => {
    let total = 53;
    const newest = async () => ({ items: [1], next: "n", total });
    const oldest = async (_c: string | null, limit: number) => ({ items: Array.from({ length: limit }, (_, i) => i), next: "o", total });
    const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useBothEnds(["t"], 25, newest, oldest, 20), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.pages).toBe(3));
    act(() => { result.current.go(3); });
    await waitFor(() => expect(result.current.items?.length).toBe(3));
    expect(result.current.page).toBe(3);
    // Seven blocks later: 60 transactions, so a fresh count would say 3 pages still, and 76 would say 4.
    total = 76;
    await act(async () => { await c.invalidateQueries(); });
    await waitFor(() => expect(c.isFetching()).toBe(0));
    expect(result.current.pages).toBe(3);
    expect(result.current.page).toBe(3);
    expect(result.current.items?.length).toBe(3);
  });
});
