// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { Label } from "./api.ts";
import { chunks, fetchLabels, labelKeys, labelName, MAX_LABELS, useLabels } from "./labels.ts";
import { addr, fakeApi, reply } from "./test-utils.tsx";

const label = (n: number, over: Partial<Label> = {}): Label => ({ address: addr(n), name: null, symbol: null, kind: "account", standard: null, decimals: null, verified: false, ...over });
const usd = (n = 0xcb) => label(n, { name: "Test USD", symbol: "tUSD", kind: "token", standard: "ERC-20", decimals: 6, verified: true });

/** A fake /api/labels that answers each address asked, from `known` or as an address the index holds nothing of. */
function labelsApi(known: Label[] = []) {
  return fakeApi((path) => {
    const asked = new URL(path, "http://x").searchParams.get("addresses")!.split(",");
    return reply({ items: asked.map((a) => known.find((l) => l.address === a) ?? label(0, { address: a, kind: null })) });
  });
}

const wrapper = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe("which addresses are asked for", () => {
  it("keeps each valid address once, in lowercase, and drops what is not an address", () => {
    const a = addr(1);
    expect(labelKeys([a, a.toUpperCase().replace("0X", "0x"), null, undefined, "0x12", addr(2)])).toEqual([a, addr(2)]);
  });

  it("splits a long list into calls of at most 100", () => {
    expect(MAX_LABELS).toBe(100);
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 2)).toEqual([]);
  });
});

describe("reading the labels", () => {
  it("asks once for a whole page of rows, not once per row", async () => {
    const calls = labelsApi([usd()]);
    const rows = Array.from({ length: 25 }, (_, i) => [addr(i + 1), addr(0xcb)]).flat();
    const { result } = renderHook(() => useLabels(rows), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.get(addr(0xcb))?.symbol).toBe("tUSD"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.startsWith("/api/labels?addresses=")).toBe(true);
    expect(calls[0]!.split("=")[1]!.split(",")).toHaveLength(26);
  });

  it("asks in calls of at most 100 when a page holds more addresses than that", async () => {
    const calls = labelsApi();
    const rows = Array.from({ length: 230 }, (_, i) => addr(1).slice(0, 40) + i.toString(16).padStart(2, "0"));
    const { result } = renderHook(() => useLabels(rows), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.split("=")[1]!.split(",").length).toBeLessThanOrEqual(100);
  });

  it("asks nothing for an empty page", async () => {
    const calls = labelsApi();
    const { result } = renderHook(() => useLabels([null, undefined]), { wrapper: wrapper() });
    expect(result.current.get(addr(1))).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("keeps what it has learned: a later page asks only for the addresses it has not seen", async () => {
    const calls = labelsApi([usd()]);
    const w = wrapper();
    const { result, rerender } = renderHook(({ rows }) => useLabels(rows), { wrapper: w, initialProps: { rows: [addr(1), addr(0xcb)] } });
    await waitFor(() => expect(result.current.get(addr(0xcb))).toBeDefined());
    rerender({ rows: [addr(1), addr(0xcb), addr(2)] });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toBe(`/api/labels?addresses=${addr(2)}`);
    await waitFor(() => expect(result.current.get(addr(2))).toBeDefined());
    expect(result.current.get(addr(0xcb))?.name).toBe("Test USD");
  });

  it("finds an address whatever its case, and says nothing of one it was not asked for", async () => {
    labelsApi([usd()]);
    const { result } = renderHook(() => useLabels([addr(0xcb)]), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.get(addr(0xcb).toUpperCase().replace("0X", "0x"))?.symbol).toBe("tUSD"));
    expect(result.current.get(addr(9))).toBeUndefined();
  });

  it("shows no names, and no error, when the labels cannot be read", async () => {
    fakeApi(() => reply({ error: "down" }, 503));
    const { result } = renderHook(() => useLabels([addr(1)]), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.get(addr(1))).toBeUndefined();
  });

  it("fetchLabels reports the server's words on a refusal", async () => {
    fakeApi(() => reply({ error: "addresses is 1 to 100 lowercase 0x addresses" }, 400));
    await expect(fetchLabels([addr(1)])).rejects.toThrow("addresses is 1 to 100");
  });
});

describe("a label as words", () => {
  it("is the name and the symbol, or the one it has, or nothing", () => {
    expect(labelName(usd())).toBe("Test USD (tUSD)");
    expect(labelName(label(1, { name: "Disperse" }))).toBe("Disperse");
    expect(labelName(label(1, { symbol: "OPASS" }))).toBe("OPASS");
    expect(labelName(label(1))).toBeNull();
    expect(labelName(undefined)).toBeNull();
  });
});
