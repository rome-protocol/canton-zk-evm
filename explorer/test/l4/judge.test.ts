import { describe, expect, it } from "vitest";
import { B5_API_CALLS_BEFORE_PAINT, B5_LCP_MS, B5_SCRIPT_GZIP_BYTES, judge, median, summarize, type Run } from "./judge.ts";

const run = (over: Partial<Run> = {}): Run => ({ lcpMs: 900, fcpMs: 400, scriptGzipBytes: 150_000, scriptWireBytes: 150_000, apiBeforeFcp: 1, apiBeforeLcp: 2, apiTotal: 4, ...over });
const five = (over: Partial<Run> = {}) => Array.from({ length: 5 }, () => run(over));
const pages = (over: Partial<Record<string, Partial<Run>>> = {}) =>
  ["home", "block", "transaction", "address", "contract"].map((n) => summarize(n, `/${n}`, five(over[n] ?? {})));

describe("L4 median", () => {
  it("is the middle run, or the mean of the two middle ones", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("L4 B5", () => {
  it("passes pages inside the budgets", () => expect(judge(pages())).toEqual([]));
  it("holds LCP, script and API calls for Home, Block and Transaction", () => {
    expect(judge(pages({ home: { lcpMs: B5_LCP_MS + 1 } }))).toEqual([expect.stringContaining("home: median LCP")]);
    expect(judge(pages({ block: { scriptGzipBytes: B5_SCRIPT_GZIP_BYTES + 1 } }))).toEqual([expect.stringContaining("block: ")]);
    expect(judge(pages({ transaction: { apiBeforeFcp: B5_API_CALLS_BEFORE_PAINT + 1 } }))).toEqual([expect.stringContaining("transaction: 4 API calls")]);
  });
  it("only reports Address and Contract", () => {
    const p = pages({ address: { lcpMs: 9000 }, contract: { apiBeforeFcp: 50 } });
    expect(judge(p)).toEqual([]);
    expect(p.find((x) => x.name === "address")?.held).toBe(false);
  });
  it("holds the median, not the one slow run", () => {
    const runs = [run(), run(), run(), run({ lcpMs: 5000 }), run()];
    const p = pages().map((x) => (x.name === "home" ? summarize("home", "/", runs) : x));
    expect(judge(p)).toEqual([]);
    expect(p[0]!.worst.lcpMs).toBe(5000);
  });
  it("fails a held page that was not measured, and one with no paint", () => {
    expect(judge(pages().filter((p) => p.name !== "block"))).toEqual(["block: not measured"]);
    expect(judge(pages({ home: { lcpMs: null } })).join()).toContain("home: no largest contentful paint");
    expect(judge(pages({ home: { scriptGzipBytes: 0 } })).join()).toContain("home: no script was measured");
  });
});
