import { describe, expect, it } from "vitest";
import { RethTooBig } from "../reth.ts";
import { traceOf } from "./trace.ts";

const A = (c: string) => "0x" + c.repeat(40);
const raw = { type: "call", action: { callType: "call", from: A("1"), to: A("2"), value: "0x0", gas: "0x100", input: "0xa9059cbb" }, result: { gasUsed: "0x10" }, traceAddress: [], subtraces: 0 };
const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");

describe("traceOf", () => {
  it("keeps no copy of a trace: two requests for the same hash both go to reth", async () => {
    const asked: string[] = [];
    const reth = { rpc: async (_m: string, p: unknown[]) => (asked.push(p[0] as string), [raw]) } as never;
    const first = await traceOf(reth, H(0));
    const second = await traceOf(reth, H(0));
    expect(asked).toEqual([H(0), H(0)]);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
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
