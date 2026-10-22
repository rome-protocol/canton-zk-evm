import { describe, expect, it } from "vitest";
import { RULES, createLimiter, createLimits, isVerification } from "./limits.ts";

const clock = () => { let t = 1_000_000; return { now: () => t, advance: (ms: number) => void (t += ms) }; };

describe("a limiter", () => {
  it("lets a burst through, then says how long to wait", () => {
    const c = clock(), l = createLimiter(RULES.rest, c.now);
    for (let i = 0; i < 60; i++) expect(l.take("203.0.113.5")).toBeNull();
    expect(l.take("203.0.113.5")).toBe(1);
  });
  it("refills at the steady rate: 20 a second", () => {
    const c = clock(), l = createLimiter(RULES.rest, c.now);
    for (let i = 0; i < 60; i++) l.take("203.0.113.5");
    c.advance(1000);
    for (let i = 0; i < 20; i++) expect(l.take("203.0.113.5")).toBeNull();
    expect(l.take("203.0.113.5")).not.toBeNull();
  });
  it("counts each client apart", () => {
    const c = clock(), l = createLimiter(RULES.rest, c.now);
    for (let i = 0; i < 60; i++) l.take("203.0.113.5");
    expect(l.take("203.0.113.5")).not.toBeNull();
    expect(l.take("203.0.113.6")).toBeNull();
  });
  it("counts an IPv6 client as its whole /64, and an IPv4 address in IPv6 form as the IPv4 address", () => {
    const c = clock(), l = createLimiter(RULES.rest, c.now);
    for (let i = 0; i < 60; i++) l.take(`2001:db8:1:2:${i.toString(16)}::${i + 1}`);
    expect(l.take("2001:db8:1:2:ffff::1")).not.toBeNull();
    expect(l.take("2001:db8:1:3::1")).toBeNull();
    for (let i = 0; i < 60; i++) l.take("198.51.100.7");
    expect(l.take("::ffff:198.51.100.7")).not.toBeNull();
  });
  it("Etherscan: 10 a second, and 600 a minute", () => {
    const c = clock(), l = createLimiter(RULES.etherscan, c.now);
    for (let i = 0; i < 10; i++) expect(l.take("203.0.113.5")).toBeNull();
    expect(l.take("203.0.113.5")).toBe(1);
    // Ten a second for a minute is 600; a client that pauses to the second never goes over the minute's count.
    let taken = 10;
    for (let s = 1; s < 60; s++) { c.advance(1000); for (let i = 0; i < 10; i++) if (l.take("203.0.113.5") === null) taken++; }
    expect(taken).toBe(600);
    c.advance(1000);
    expect(l.take("203.0.113.5")).toBeNull();
  });
  it("a refused request takes nothing from the other bucket", () => {
    const c = clock(), l = createLimiter([{ capacity: 1, perSecond: 1 }, { capacity: 5, perSecond: 0.001 }], c.now);
    expect(l.take("203.0.113.5")).toBeNull();
    for (let i = 0; i < 20; i++) expect(l.take("203.0.113.5")).toBe(1);
    c.advance(1000);
    for (let i = 0; i < 4; i++) { expect(l.take("203.0.113.5")).toBeNull(); c.advance(1000); }
    expect(l.take("203.0.113.5")).not.toBeNull(); // five were taken in all
  });
  it("verification: 30 an hour, then the wait for the next one is minutes", () => {
    const c = clock(), l = createLimiter(RULES.verification, c.now);
    for (let i = 0; i < 30; i++) expect(l.take("203.0.113.5")).toBeNull();
    expect(l.take("203.0.113.5")).toBe(120);
    c.advance(120_000);
    expect(l.take("203.0.113.5")).toBeNull();
  });
  it("forgets the longest quiet clients, never the one in hand, and stays bounded", () => {
    const c = clock(), l = createLimiter(RULES.verification, c.now);
    for (let i = 0; i < 30; i++) l.take("203.0.113.5");
    // A client that keeps asking keeps its bucket, whatever a flood of new addresses does around it.
    for (let i = 0; i < 12_000; i++) {
      l.take(`10.${(i >> 8) & 255}.${i & 255}.1`);
      if (i % 100 === 0) expect(l.take("203.0.113.5")).not.toBeNull();
    }
  });
  it("createLimits makes three separate limiters", () => {
    const c = clock(), l = createLimits(c.now);
    for (let i = 0; i < 60; i++) l.rest.take("203.0.113.5");
    expect(l.rest.take("203.0.113.5")).not.toBeNull();
    expect(l.etherscan.take("203.0.113.5")).toBeNull();
    expect(l.verification.take("203.0.113.5")).toBeNull();
  });
});

describe("isVerification", () => {
  it("reads the action from the query or the form", () => {
    expect(isVerification(new URLSearchParams("module=contract&action=verifysourcecode"), undefined)).toBe(true);
    expect(isVerification(new URLSearchParams("module=contract"), "action=verifyproxycontract&address=0x1")).toBe(true);
    expect(isVerification(new URLSearchParams("module=contract&action=getabi"), "action=getabi")).toBe(false);
    expect(isVerification(new URLSearchParams(""), undefined)).toBe(false);
  });
});
