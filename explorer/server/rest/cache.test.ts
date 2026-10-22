import { describe, expect, it } from "vitest";
import { CACHE_CONTROL, cached, etagOf } from "./cache.ts";

describe("cache rules", () => {
  it("immutable is a year, composite a few seconds, a list a second", () => {
    expect(CACHE_CONTROL.immutable).toBe("public, max-age=31536000, immutable");
    expect(CACHE_CONTROL.composite).toMatch(/^public, max-age=[1-5]$/);
    expect(CACHE_CONTROL.list).toMatch(/^public, max-age=[12]$/);
  });
  it("adds the rule and a tag that follows the body, to a 200 only", () => {
    const a = cached({ status: 200, body: { n: 1 } }, "composite");
    expect(a.headers?.["cache-control"]).toBe(CACHE_CONTROL.composite);
    expect(a.headers?.etag).toBe(etagOf('{"n":1}'));
    expect(cached({ status: 200, body: { n: 2 } }, "composite").headers?.etag).not.toBe(a.headers?.etag);
    expect(cached({ status: 404, body: { error: "x" } }, "list").headers).toBeUndefined();
  });
});
