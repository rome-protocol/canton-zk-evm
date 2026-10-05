import { describe, expect, it, vi } from "vitest";
import { readModuleSize, VERIFY_MODULE_URL } from "./module-size.ts";

const answer = (status: number, headers: Record<string, string> = {}) => vi.fn(async () => new Response(null, { status, headers }));

describe("the check's file size", () => {
  it("is where the explorer serves the file", () => {
    expect(VERIFY_MODULE_URL).toBe("/verify/zk_explorer_verify.wasm");
  });

  it("asks with a HEAD, so nothing is downloaded, and reads the length", async () => {
    const fetcher = answer(200, { "content-length": "170260" });
    expect(await readModuleSize("/x.wasm", fetcher)).toBe(170260);
    expect(fetcher).toHaveBeenCalledWith("/x.wasm", { method: "HEAD" });
  });

  it("does not know the size when there is no length, a bad one, a zero, or an error status", async () => {
    expect(await readModuleSize("/x.wasm", answer(200))).toBeUndefined();
    expect(await readModuleSize("/x.wasm", answer(200, { "content-length": "many" }))).toBeUndefined();
    expect(await readModuleSize("/x.wasm", answer(200, { "content-length": "0" }))).toBeUndefined();
    expect(await readModuleSize("/x.wasm", answer(404, { "content-length": "9" }))).toBeUndefined();
  });

  it("does not know the size when the server cannot be reached", async () => {
    expect(await readModuleSize("/x.wasm", vi.fn(async () => { throw new TypeError("offline"); }))).toBeUndefined();
  });
});
