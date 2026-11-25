import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import { createPaidPath, PAID_PATH_FILE_MAX, PAID_PATH_REREAD_MS, PAID_PATH_STALE_MS, parsePaidPath } from "./paid-path.ts";

const PARTY = "validator::1220" + "ab".repeat(32);
const WROTE = "2026-11-24T10:30:05Z";
const T0 = Date.parse(WROTE) + 4000;
// The numbers here are test values: the worker's settings decide the real ones.
const file = (over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, updatedAt: WROTE, price: "20", minBuy: "20", party: PARTY, state: "open", ...over });
const shown = { price: "20", minBuy: "20", party: PARTY, state: "open" };

describe("parsePaidPath", () => {
  it("takes the worker's status as it is, with only the fields of the answer", () => {
    expect(parsePaidPath(file({ extra: "never sent" }), T0)).toEqual(shown);
  });
  it("takes sold out and decimal amounts", () => {
    expect(parsePaidPath(file({ state: "sold out", price: "0.5", minBuy: "2.25" }), T0)).toEqual({ ...shown, state: "sold out", price: "0.5", minBuy: "2.25" });
  });
  it.each([["not JSON", "{"], ["an array", "[]"], ["null", "null"], ["another version", file({ version: 2 })], ["no version", JSON.stringify({ updatedAt: WROTE })], ["no time", file({ updatedAt: undefined })],
    ["a time that is not UTC text", file({ updatedAt: "2026-11-24 10:30:05" })], ["too long", file() + " ".repeat(PAID_PATH_FILE_MAX)],
    ["a price that is a number", file({ price: 20 })], ["a negative price", file({ price: "-1" })], ["a price with an exponent", file({ price: "1e3" })], ["no price", file({ price: undefined })],
    ["a least buy that is text", file({ minBuy: "ten" })], ["no least buy", file({ minBuy: undefined })], ["no party", file({ party: undefined })], ["an empty party", file({ party: "" })],
    ["a party that is too long", file({ party: "p".repeat(301) })], ["a state that is neither", file({ state: "closed" })], ["no state", file({ state: undefined })],
  ])("gives nothing for a file that is %s", (_n, raw) => {
    expect(parsePaidPath(raw, T0)).toBeNull();
  });
  it("gives nothing for a file the worker wrote more than five minutes ago, or dated in the future", () => {
    expect(parsePaidPath(file(), Date.parse(WROTE) + PAID_PATH_STALE_MS)).not.toBeNull();
    expect(parsePaidPath(file(), Date.parse(WROTE) + PAID_PATH_STALE_MS + 1)).toBeNull();
    expect(parsePaidPath(file(), Date.parse(WROTE) - 60_000)).not.toBeNull();
    expect(parsePaidPath(file(), Date.parse(WROTE) - 60_001)).toBeNull();
  });
});

describe("createPaidPath", () => {
  function rig(initial?: string) {
    const held = { text: initial as string | undefined }, clock = { now: T0 }, reads = { n: 0 };
    const get = createPaidPath({ file: "/run/buy-status.json", now: () => clock.now, readFile: () => { reads.n++; if (held.text === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" }); return held.text; } });
    return { held, clock, reads, get };
  }
  it("reads nothing, and shows none, when no file is set", () => {
    expect(createPaidPath({ file: null, readFile: () => { throw new Error("read"); } })()).toBeNull();
  });
  it("shows none while the file is not there, and the paid path once it is", () => {
    const r = rig();
    expect(r.get()).toBeNull();
    r.held.text = file();
    r.clock.now += PAID_PATH_REREAD_MS;
    expect(r.get()).toEqual(shown);
  });
  it("reads the file again only when what it holds is old, so a change shows within a few seconds", () => {
    const r = rig(file());
    r.get(); r.get();
    expect(r.reads.n).toBe(1);
    r.held.text = file({ state: "sold out" });
    r.clock.now += PAID_PATH_REREAD_MS - 1;
    expect(r.get()?.state).toBe("open");
    r.clock.now += 1;
    expect(r.get()?.state).toBe("sold out");
  });
  it("stops showing what nothing has refreshed for five minutes (the worker is off)", () => {
    const r = rig(file());
    expect(r.get()).not.toBeNull();
    r.clock.now = Date.parse(WROTE) + PAID_PATH_STALE_MS + 1;
    expect(r.get()).toBeNull();
    r.held.text = file({ updatedAt: new Date(r.clock.now - 2000).toISOString().replace(/\.\d+Z$/, "Z") });
    r.clock.now += PAID_PATH_REREAD_MS;
    expect(r.get()).not.toBeNull();
  });
});

describe("the paid path in /api/status", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const pins = "programVK=0x" + "cd".repeat(32) + "\nrootC=0x" + "ef".repeat(32) + "\n";
  const block = { number: 1, hash: "0x" + "11".repeat(32), timestamp: 1 };
  const boot = (statusFile?: string, now = () => T0) => createApi({
    config: loadConfig({ READER_PARTY: "reader::1220" + "ab".repeat(32), PINS_FILE: "guest.txt", ...(statusFile ? { PAID_PATH_FILE: statusFile } : {}) }, () => pins),
    reth: { block: async () => block } as never, ledger: { ledgerEnd: async () => 1 } as never, now,
    chain: { head: async () => undefined, latest: async () => [], indexer: async () => ({ started: true, problems: [], down: false, signers: null }), indexFacts: async () => ({ deriveCursor: null, chainInstance: null }) } as never,
  });
  const fileIn = (text: string) => { const d = mkdtempSync(join(tmpdir(), "paid-")); dirs.push(d); const p = join(d, "buy-status.json"); writeFileSync(p, text); return p; };

  it("shows the price, the least buy, the party and whether it is open or sold out", async () => {
    const a = await boot(fileIn(file({ state: "sold out" })))("GET", "/api/status");
    expect(a.status).toBe(200);
    expect((a.body as Record<string, unknown>).paidPath).toEqual({ ...shown, state: "sold out" });
  });
  it("shows nothing for it, and today's answer unchanged, with no setting, no file, a file that is not the worker's, or a stale one", async () => {
    const baseline = Object.keys((await boot()("GET", "/api/status")).body as object).sort();
    expect(baseline).not.toContain("paidPath");
    const later = () => Date.parse(WROTE) + PAID_PATH_STALE_MS + 1;
    for (const api of [boot("/nonexistent/buy-status.json"), boot(fileIn("{}")), boot(fileIn(file()), later)]) {
      expect(Object.keys((await api("GET", "/api/status")).body as object).sort()).toEqual(baseline);
    }
  });
  it("is in the load balancer's answer too, which is the same", async () => {
    const a = await boot(fileIn(file()))("GET", "/healthz");
    expect((a.body as Record<string, unknown>).paidPath).toEqual(shown);
  });
});
