import { describe, expect, it } from "vitest";
import { summarize, type Check } from "./summary.ts";

const check = (name: string, ok = true): Check => ({ name, ok, seconds: 1, detail: ok ? "ok" : "refused" });

describe("L5 verdict", () => {
  it("passes only when every check passed", () => expect(summarize([check("forge"), check("hardhat")]).status).toBe("passed"));
  it("fails on one failed check, and names it", () => {
    const s = summarize([check("forge"), check("hardhat", false)]);
    expect(s.status).toBe("failed");
    expect(s.failures).toEqual(["hardhat: refused"]);
  });
  it("fails when the door answered and no check ran", () => expect(summarize([]).status).toBe("failed"));
});
