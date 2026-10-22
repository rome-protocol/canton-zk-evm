import { describe, expect, it } from "vitest";
import { BadRequest, DEFAULT_LIMIT, MAX_LIMIT, cursorOf, keyOf, limitOf, pageOf } from "./paging.ts";

describe("limit", () => {
  it("defaults, caps at 100 and refuses what is not a count", () => {
    expect(limitOf(null)).toBe(DEFAULT_LIMIT);
    expect(limitOf("7")).toBe(7);
    expect(limitOf("100")).toBe(MAX_LIMIT);
    expect(limitOf("5000")).toBe(MAX_LIMIT);
    for (const bad of ["0", "-1", "1.5", "abc", "", "01", "1e3"]) expect(() => limitOf(bad)).toThrow(BadRequest);
  });
});

describe("before", () => {
  it("is absent for the first page and has the parts the route sorts by", () => {
    expect(cursorOf(null, ["int"])).toBeNull();
    expect(cursorOf("", ["int"])).toBeNull();
    expect(cursorOf("12:3", ["int", "int"])).toEqual([12, 3]);
    expect(cursorOf("5:abc1220ff", ["int", "text"])).toEqual([5, "abc1220ff"]);
  });
  it("refuses the wrong number of parts, signs, offsets, hex prefixes and unsafe numbers", () => {
    for (const bad of ["12", "12:3:4", "-1:3", "1.5:3", "a:3", "0x10:3", "12:", "99999999999999999:1"]) expect(() => cursorOf(bad, ["int", "int"])).toThrow(BadRequest);
    expect(() => cursorOf("1:A", ["int", "text"])).toThrow(BadRequest);
    expect(() => cursorOf("1:x;drop", ["int", "text"])).toThrow(BadRequest);
  });
});

describe("a trace address part", () => {
  it("is t and the indexes, and nothing else", () => {
    expect(cursorOf("5:2:t", ["int", "int", "trace"])).toEqual([5, 2, "t"]);
    expect(cursorOf("5:2:t0-1", ["int", "int", "trace"])).toEqual([5, 2, "t0-1"]);
    for (const bad of ["5:2:0-1", "5:2:t-1", "5:2:t0-", "5:2:t0--1", "5:2:t1x", "5:2:T0"]) expect(() => cursorOf(bad, ["int", "int", "trace"])).toThrow(BadRequest);
  });
});

describe("a page", () => {
  const rows = [5, 4, 3, 2, 1].map((n) => ({ n }));
  it("has a next key only when a further row exists, and that key is the last row shown", () => {
    expect(pageOf(rows.slice(0, 3), 2, (r) => keyOf(r.n))).toEqual({ items: [{ n: 5 }, { n: 4 }], next: "4" });
    expect(pageOf(rows.slice(0, 2), 2, (r) => keyOf(r.n))).toEqual({ items: [{ n: 5 }, { n: 4 }], next: null });
    expect(pageOf([], 2, (r: { n: number }) => keyOf(r.n))).toEqual({ items: [], next: null });
  });
});
