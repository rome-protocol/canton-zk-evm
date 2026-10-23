import { describe, expect, it } from "vitest";
import { summarize, type Check } from "./summary.ts";

const check = (name: string, ok = true): Check => ({ name, ok, seconds: 1, detail: ok ? "ok" : "refused" });
const skip = (name: string, module = "contract"): Check => ({ name, ok: true, seconds: 0, detail: "skipped", skipped: module });

describe("L5 verdict", () => {
  it("passes only when every check passed", () => expect(summarize([check("proxy"), check("balance")]).status).toBe("passed"));
  it("fails on one failed check, and names it", () => {
    const s = summarize([check("proxy"), check("balance", false)]);
    expect(s.status).toBe("failed");
    expect(s.failures).toEqual(["balance: refused"]);
  });
  it("fails when the door answered and no check ran", () => expect(summarize([]).status).toBe("failed"));
  it("is partial, never passed, when the contract module's checks are skipped; the skips name the module", () => {
    const s = summarize([check("proxy"), skip("forge verify-contract")]);
    expect(s.status).toBe("partial");
    expect(s.failures).toEqual([]);
    expect(s.skipped).toEqual(["forge verify-contract: SKIPPED, the contract module is not in the door"]);
  });
  it("a failure still fails the job beside a skip", () => expect(summarize([check("proxy", false), skip("hardhat verify")]).status).toBe("failed"));
  it("is skipped, not passed, when every check was skipped", () => expect(summarize([skip("a"), skip("b")]).status).toBe("skipped"));
});
