import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import { createCustodyLimits, CUSTODY_LIMITS_FILE_MAX, CUSTODY_LIMITS_REREAD_MS, CUSTODY_LIMITS_STALE_MS, parseCustodyLimits } from "./custody-limits.ts";

const ADMIN = "admin::1220" + "00".repeat(32);
const WROTE = "2026-11-24T10:30:05Z";
const T0 = Date.parse(WROTE) + 4000;
const least = (id: string, v: unknown, admin = ADMIN) => ({ instrumentAdmin: admin, instrumentId: id, least: v });
const file = (over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, updatedAt: WROTE, pollSeconds: 10, minDeposits: [least("Amulet", "10"), least("TKB", "1")], minPayouts: [least("Amulet", "10")], maxOffers: 3, offerHours: 24, ...over });

describe("parseCustodyLimits", () => {
  it("takes the worker's limits as they are, with only the fields of the answer", () => {
    expect(parseCustodyLimits(file(), T0)).toEqual({ updatedAt: WROTE, minDeposits: [least("Amulet", "10"), least("TKB", "1")], minPayouts: [least("Amulet", "10")], maxOffers: 3, offerHours: 24 });
  });
  it("keeps a part that is off as null and a part that is on with no least amount as an empty list", () => {
    expect(parseCustodyLimits(file({ minDeposits: null, minPayouts: [], maxOffers: null }), T0)).toEqual({ updatedAt: WROTE, minDeposits: null, minPayouts: [], maxOffers: null, offerHours: 24 });
  });
  it.each([["15 minutes", 0.25, 0.25], ["a day", 24, 24], ["absent", undefined, null], ["zero", 0, null], ["negative", -1, null], ["text", "24", null], ["null", null, null], ["too large", 1e9, null]])("reads the offer time as %s", (_n, v, out) => {
    expect(parseCustodyLimits(file({ offerHours: v }), T0)?.offerHours).toBe(out);
  });
  it("accepts a cap of 0 (no limit) and decimal amounts", () => {
    expect(parseCustodyLimits(file({ maxOffers: 0, minPayouts: [least("Amulet", "0.25")] }), T0)).toMatchObject({ maxOffers: 0, minPayouts: [least("Amulet", "0.25")] });
  });
  it.each([["not JSON", "{"], ["an array", "[]"], ["null", "null"], ["another version", file({ version: 2 })], ["no version", JSON.stringify({ updatedAt: WROTE })], ["no time", file({ updatedAt: undefined })],
    ["a time that is not UTC text", file({ updatedAt: "2026-11-24 10:30:05" })], ["too long", file() + " ".repeat(CUSTODY_LIMITS_FILE_MAX)]])("gives nothing for a file that is %s", (_n, raw) => {
    expect(parseCustodyLimits(raw, T0)).toBeNull();
  });
  it("gives nothing for a file the worker wrote more than five minutes ago, or dated in the future", () => {
    expect(parseCustodyLimits(file(), Date.parse(WROTE) + CUSTODY_LIMITS_STALE_MS)).not.toBeNull();
    expect(parseCustodyLimits(file(), Date.parse(WROTE) + CUSTODY_LIMITS_STALE_MS + 1)).toBeNull();
    expect(parseCustodyLimits(file(), Date.parse(WROTE) - 60_000)).not.toBeNull();
    expect(parseCustodyLimits(file(), Date.parse(WROTE) - 60_001)).toBeNull();
  });
  it.each([["a number", 10], ["negative", "-1"], ["text", "ten"], ["an exponent", "1e3"], ["empty", ""], ["too fine", "1." + "1".repeat(21)]])("leaves a list out whole when one least amount is %s", (_n, v) => {
    expect(parseCustodyLimits(file({ minPayouts: [least("Amulet", "10"), least("TKB", v)] }), T0)).toMatchObject({ minPayouts: null, minDeposits: [least("Amulet", "10"), least("TKB", "1")] });
  });
  it("leaves a list out whole when an entry has no instrument or is not an object, and when it holds too many", () => {
    expect(parseCustodyLimits(file({ minDeposits: [{ least: "1" }] }), T0)?.minDeposits).toBeNull();
    expect(parseCustodyLimits(file({ minDeposits: [null] }), T0)?.minDeposits).toBeNull();
    expect(parseCustodyLimits(file({ minDeposits: "10" }), T0)?.minDeposits).toBeNull();
    expect(parseCustodyLimits(file({ minDeposits: Array.from({ length: 101 }, (_, i) => least(`T${i}`, "1")) }), T0)?.minDeposits).toBeNull();
  });
  it.each([["negative", -1], ["fractional", 1.5], ["text", "3"]])("has no cap when maxOffers is %s", (_n, v) => {
    expect(parseCustodyLimits(file({ maxOffers: v }), T0)?.maxOffers).toBeNull();
  });
});

describe("createCustodyLimits", () => {
  function rig(initial?: string) {
    const held = { text: initial as string | undefined }, clock = { now: T0 }, reads = { n: 0 };
    const get = createCustodyLimits({ file: "/run/limits.json", now: () => clock.now, readFile: () => { reads.n++; if (held.text === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" }); return held.text; } });
    return { held, clock, reads, get };
  }
  it("reads nothing, and gives none, when no file is set", () => {
    expect(createCustodyLimits({ file: null, readFile: () => { throw new Error("read"); } })()).toBeNull();
  });
  it("gives none while the file is not there, and the limits once it is", () => {
    const r = rig();
    expect(r.get()).toBeNull();
    r.held.text = file();
    r.clock.now += CUSTODY_LIMITS_REREAD_MS;
    expect(r.get()).toMatchObject({ updatedAt: WROTE });
  });
  it("reads the file again only when what it holds is old, so a change shows within a few seconds", () => {
    const r = rig(file());
    r.get(); r.get();
    expect(r.reads.n).toBe(1);
    r.held.text = file({ minPayouts: [least("Amulet", "20")] });
    r.clock.now += CUSTODY_LIMITS_REREAD_MS - 1;
    expect(r.get()?.minPayouts).toEqual([least("Amulet", "10")]);
    r.clock.now += 1;
    expect(r.get()?.minPayouts).toEqual([least("Amulet", "20")]);
  });
  it("stops showing limits that nothing has refreshed for five minutes", () => {
    const r = rig(file());
    expect(r.get()).not.toBeNull();
    r.clock.now = Date.parse(WROTE) + CUSTODY_LIMITS_STALE_MS + 1;
    expect(r.get()).toBeNull();
  });
  it("shows the limits again once the worker writes a fresh file", () => {
    const r = rig(file());
    r.get();
    r.clock.now = Date.parse(WROTE) + CUSTODY_LIMITS_STALE_MS + 10_000;
    expect(r.get()).toBeNull();
    r.held.text = file({ updatedAt: new Date(r.clock.now - 2000).toISOString().replace(/\.\d+Z$/, "Z") });
    r.clock.now += CUSTODY_LIMITS_REREAD_MS;
    expect(r.get()).not.toBeNull();
  });
});

describe("GET /api/bridge/custody-limits", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const pins = "programVK=0x" + "cd".repeat(32) + "\nrootC=0x" + "ef".repeat(32) + "\n";
  const boot = (limitsFile?: string, now = () => T0) => createApi({
    config: loadConfig({ READER_PARTY: "reader::1220" + "ab".repeat(32), PINS_FILE: "guest.txt", ...(limitsFile ? { CUSTODY_LIMITS_FILE: limitsFile } : {}) }, () => pins),
    reth: {} as never, ledger: {} as never, chain: {} as never, now,
  });
  const fileIn = (text: string) => { const d = mkdtempSync(join(tmpdir(), "limits-")); dirs.push(d); const p = join(d, "custody-limits.json"); writeFileSync(p, text); return p; };

  it("serves the worker's limits, with only the fields of the answer", async () => {
    const a = await boot(fileIn(JSON.stringify({ ...JSON.parse(file()), extra: "never sent" })))("GET", "/api/bridge/custody-limits");
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ limits: { updatedAt: WROTE, minDeposits: [least("Amulet", "10"), least("TKB", "1")], minPayouts: [least("Amulet", "10")], maxOffers: 3, offerHours: 24 } });
  });
  it("answers null with no setting, with no file, with a file that is not the worker's and with a stale one, so the page makes no check", async () => {
    const later = () => Date.parse(WROTE) + CUSTODY_LIMITS_STALE_MS + 1;
    for (const api of [boot(), boot("/nonexistent/custody-limits.json"), boot(fileIn("{}")), boot(fileIn(file()), later)]) expect((await api("GET", "/api/bridge/custody-limits")).body).toEqual({ limits: null });
  });
  it("is a route of the description, and only GET", async () => {
    const api = boot();
    expect(api.routes).toContain("/api/bridge/custody-limits");
    expect((await api("POST", "/api/bridge/custody-limits")).status).toBe(405);
  });
});
