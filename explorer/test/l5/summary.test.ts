import { describe, expect, it } from "vitest";
import { SKIPPED_REASON, isDoor, summarize, type Check } from "./summary.ts";

const check = (name: string, ok = true): Check => ({ name, ok, seconds: 1, detail: ok ? "ok" : "refused" });

describe("L5 probe", () => {
  it("takes a JSON reply with a hex result for the door", () => expect(isDoor(200, '{"jsonrpc":"2.0","id":83,"result":"0x1f"}')).toBe(true));
  it("does not take what the explorer answers today", () => {
    expect(isDoor(404, '{"error":"not found"}')).toBe(false);
    expect(isDoor(200, "<!doctype html><html></html>")).toBe(false);
    expect(isDoor(200, '{"status":"0","message":"NOTOK","result":"Invalid module"}')).toBe(false);
    expect(isDoor(200, '{"result":null}')).toBe(false);
  });
});

describe("L5 verdict", () => {
  it("is a skip, with its reason, when nothing ran; and never a pass", () => {
    const s = summarize(null);
    expect(s.status).toBe("skipped");
    expect(s.reason).toBe(SKIPPED_REASON);
    expect(s.status).not.toBe("passed");
  });
  it("passes only when every check passed", () => expect(summarize([check("forge"), check("hardhat")]).status).toBe("passed"));
  it("fails on one failed check, and names it", () => {
    const s = summarize([check("forge"), check("hardhat", false)]);
    expect(s.status).toBe("failed");
    expect(s.failures).toEqual(["hardhat: refused"]);
  });
  it("fails when the door answered and no check ran", () => expect(summarize([]).status).toBe("failed"));
});
