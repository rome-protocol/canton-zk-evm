import { describe, expect, it } from "vitest";
import type { ApiHealth, HealthCheck } from "./api.ts";
import { checksWord, stripItems } from "./strip.ts";
import { status } from "./test-utils.tsx";

const row = (id: string, over: Partial<HealthCheck> = {}): HealthCheck => ({ id, role: id.startsWith("api/") || id === "faucet" ? "api" : id.startsWith("verifier/") ? "verifier" : "indexer", status: "ok", detail: null, ...over });
const list = (checks: HealthCheck[]): ApiHealth => ({ status: "ok", starting: false, problems: [], checks });
const full = list([
  row("api/a/reth"), row("producer_alive"), row("producer_state"), row("prover"), row("C5", { value: { lagBlocks: 0, lagSeconds: 0.3 } }),
  row("faucet"), row("verifier/compilers"), row("verifier/queue"), row("C9", { value: { worstMs: 41, checked: 3 } }),
]);

describe("the health strip's names", () => {
  it("are those of screen 01 in its order, with the index lag in seconds and the clock gap in milliseconds", () => {
    expect(stripItems(status(), full).map((i) => i.text)).toEqual(["EVM node", "Canton ledger", "Producer", "Prover", "Index lag 0.3 s", "Faucet", "Verifier", "Clock gap 41 ms"]);
    expect(stripItems(status(), full).every((i) => i.dot === "ok")).toBe(true);
  });

  it("leaves out a check that is not in the list, and a number its check did not write", () => {
    const some = list([row("C5", { value: null }), row("C9", { value: { worstMs: null, checked: 0 } })]);
    expect(stripItems(status({ indexLag: null }), some).map((i) => i.text)).toEqual(["EVM node", "Canton ledger"]);
  });

  it("falls back to the status's lag in blocks while the list is unread, and names none when that is unknown too", () => {
    expect(stripItems(status({ indexLag: 2 }), undefined).map((i) => i.text)).toContain("Index lag 2 blocks");
    expect(stripItems(status({ indexLag: 1 }), undefined).map((i) => i.text)).toContain("Index lag 1 block");
    expect(stripItems(status({ indexLag: null }), undefined).map((i) => i.text)).toEqual(["EVM node", "Canton ledger"]);
  });

  it("marks a check that is not ok red, and says what it said; the producer is red when either of its rows is", () => {
    const bad = list([row("producer_alive"), row("producer_state", { status: "degraded", detail: "3 failures in a row" }), row("prover", { status: "down" })]);
    const items = stripItems(status(), bad);
    expect(items.find((i) => i.key === "producer")).toMatchObject({ dot: "bad", title: "3 failures in a row" });
    expect(items.find((i) => i.key === "prover")?.dot).toBe("bad");
  });

  it("takes the EVM node and Canton from the status", () => {
    const items = stripItems(status({ evm: false, canton: false }), full);
    expect(items.slice(0, 2).map((i) => i.dot)).toEqual(["bad", "bad"]);
  });
});

describe("the strip's count of checks", () => {
  it("counts the indexer's rows only, as the top bar does", () => {
    expect(checksWord(status(), full)).toEqual({ dot: "ok", text: "All 5 checks ok" });
  });
  it("counts the ones that are not ok, and names a failed check, and starting", () => {
    expect(checksWord(status(), list([row("C5", { status: "degraded" }), row("C9")]))).toEqual({ dot: "bad", text: "1 of 2 checks not ok" });
    expect(checksWord(status({ ok: false, problems: ["block 3"] }), full)).toEqual({ dot: "bad", text: "A check failed" });
    expect(checksWord(status({ starting: true, ok: false, problems: [] }), undefined)).toEqual({ dot: "off", text: "Starting" });
  });
  it("says only that the checks pass while the list is unread", () => {
    expect(checksWord(status(), undefined)).toEqual({ dot: "ok", text: "Checks pass" });
  });
});
