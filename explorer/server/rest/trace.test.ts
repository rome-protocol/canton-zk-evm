import { describe, expect, it } from "vitest";
import { RethTooBig } from "../reth.ts";
import { TRACE_CACHE_MAX, traceOf } from "./trace.ts";

const A = (c: string) => "0x" + c.repeat(40);
const raw = { type: "call", action: { callType: "call", from: A("1"), to: A("2"), value: "0x0", gas: "0x100", input: "0xa9059cbb" }, result: { gasUsed: "0x10" }, traceAddress: [], subtraces: 0 };
const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");

describe("traceOf", () => {
  it("keeps the last 64 cut traces per reth client, so the same hash is asked of reth once, and the least recently used goes first", async () => {
    const asked: string[] = [];
    const reth = { rpc: async (_m: string, p: unknown[]) => (asked.push(p[0] as string), [raw]) } as never;
    const first = await traceOf(reth, H(0));
    expect(await traceOf(reth, H(0))).toBe(first);
    expect(asked).toEqual([H(0)]);
    for (let i = 1; i < TRACE_CACHE_MAX; i++) await traceOf(reth, H(i));
    await traceOf(reth, H(0)); // H(0) is now the newest
    await traceOf(reth, H(TRACE_CACHE_MAX)); // pushes H(1) out, not H(0)
    asked.length = 0;
    await traceOf(reth, H(0));
    expect(asked).toEqual([]);
    await traceOf(reth, H(1));
    expect(asked).toEqual([H(1)]);
  });

  it("does not keep a trace reth does not hold, nor one that was too big", async () => {
    let n = 0, mode: "none" | "big" | "ok" = "none";
    const reth = { rpc: async () => { n++; if (mode === "big") throw new RethTooBig("trace_transaction", 10); return mode === "none" ? null : [raw]; } } as never;
    expect(await traceOf(reth, H(1))).toBeNull();
    mode = "big";
    await expect(traceOf(reth, H(1))).rejects.toBeInstanceOf(RethTooBig);
    mode = "ok";
    expect(await traceOf(reth, H(1))).not.toBeNull();
    expect(n).toBe(3);
  });
});
