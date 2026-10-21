import { describe, expect, it } from "vitest";
import { deriveFrames, PARENT_FAILED } from "./calls.ts";
import type { TraceFrame } from "./reads.ts";

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const frame = (path: number[], over: Partial<TraceFrame> = {}): TraceFrame => ({
  traceAddress: path, type: "call", callType: "call", from: A(1), to: A(2), value: 0n, gas: 1000, gasUsed: 10, input: "0x", error: null, created: null, ...over,
});
const make = (path: number[], address: number, over: Partial<TraceFrame> = {}) =>
  frame(path, { type: "create", callType: "create", to: A(address), input: "0x6080", created: { address: A(address), code: "0x6001" }, ...over });

describe("the internal calls of a trace", () => {
  it("stores calls that move value, creations and self-destructs, and never the transaction's own call or a call that moves nothing", () => {
    const r = deriveFrames(3, true, [
      frame([], { value: 7n }),
      frame([0], { value: 5n, input: "0xa9059cbb00" }),
      frame([1], { callType: "staticcall" }),
      frame([2], { callType: "delegatecall", value: 9n }),
      frame([3], { callType: "callcode", value: 9n }),
      make([4], 0xc1),
      frame([4, 0], { type: "suicide", callType: "selfdestruct", from: A(0xc1), to: A(9), value: 2n }),
    ]);
    expect(r.calls.map((c) => [c.traceAddress.join("."), c.callType, c.value, c.txIndex])).toEqual([["0", "call", 5n, 3], ["4", "create", 0n, 3], ["4.0", "selfdestruct", 2n, 3]]);
    expect(r.calls[0]).toMatchObject({ selector: "0xa9059cbb", inputSize: 5, from: A(1), to: A(2), error: null });
    expect(r.calls[1]).toMatchObject({ selector: null, inputSize: 2, to: A(0xc1) });
    expect(r.calls[2]).toMatchObject({ from: A(0xc1), to: A(9), selector: null, inputSize: 0 });
  });

  it("keeps a failed inner call with its error, and marks what was under it as undone with it", () => {
    const r = deriveFrames(0, true, [
      frame([]),
      frame([0], { value: 1n, error: "Reverted" }),
      frame([0, 0], { value: 2n }),
      make([0, 1], 0xc2),
      frame([1], { value: 3n }),
    ]);
    expect(r.calls.map((c) => [c.traceAddress.join("."), c.error])).toEqual([["0", "Reverted"], ["0.0", PARENT_FAILED], ["0.1", PARENT_FAILED], ["1", null]]);
    expect(r.created).toEqual([]);
  });

  it("makes no contract and destroys nothing in a transaction that failed, even where its frames show no error", () => {
    const r = deriveFrames(0, false, [make([], 0xc3, { error: "Reverted", created: null }), make([0], 0xc4), frame([1], { type: "suicide", callType: "selfdestruct", from: A(5), to: A(6), value: 1n })]);
    expect(r.created).toEqual([]);
    expect(r.destroyed).toEqual([]);
    expect(r.calls.map((c) => c.error)).toEqual([PARENT_FAILED, PARENT_FAILED]);
  });
});
