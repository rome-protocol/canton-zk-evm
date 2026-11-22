import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import { createMinimums, MINIMUMS_FILE_MAX, MINIMUMS_REREAD_MS, parseMinimums } from "./minimums.ts";

const ADMIN = "admin::1220" + "00".repeat(32);
const status = (custody: unknown) => JSON.stringify({ state: "running", custody });
const entry = (floor: unknown, extra: Record<string, unknown> = {}) => ({ readAt: "2026-11-22T09:00:00Z", floor, floorDays: 30, holdings: [], ...extra });

describe("parseMinimums", () => {
  it("takes the floor of each instrument from the status file's custody section, and nothing else", () => {
    expect(parseMinimums(status({ [ADMIN]: entry("1.118016") }))).toEqual([{ instrumentAdmin: ADMIN, floor: "1.118016", readAt: "2026-11-22T09:00:00Z" }]);
  });
  it("gives none for a file with no custody section, a file that is not JSON, or one that is too long", () => {
    expect(parseMinimums(JSON.stringify({ state: "running" }))).toEqual([]);
    expect(parseMinimums("{")).toEqual([]);
    expect(parseMinimums(status([]))).toEqual([]);
    expect(parseMinimums(status({ [ADMIN]: entry("1") }) + " ".repeat(MINIMUMS_FILE_MAX))).toEqual([]);
  });
  it.each([["a number", 1.5], ["negative", "-1"], ["text", "a lot"], ["exponent", "1e3"], ["too fine", "1.12345678901"], ["empty", ""], ["null", null]])("leaves out an entry whose floor is %s", (_n, floor) => {
    expect(parseMinimums(status({ [ADMIN]: entry(floor) }))).toEqual([]);
  });
  it("keeps the good entries beside a bad one, and has a null readAt where the file gives none", () => {
    expect(parseMinimums(status({ b: entry("2"), a: { floor: "1" }, c: null }))).toEqual([{ instrumentAdmin: "a", floor: "1", readAt: null }, { instrumentAdmin: "b", floor: "2", readAt: "2026-11-22T09:00:00Z" }]);
  });
});

describe("createMinimums", () => {
  function rig(initial?: string) {
    const held = { text: initial as string | undefined }, clock = { now: 1_000_000 }, reads = { n: 0 };
    const get = createMinimums({ file: "/run/status.json", now: () => clock.now, readFile: () => { reads.n++; if (held.text === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" }); return held.text; } });
    return { held, clock, reads, get };
  }
  it("reads nothing, and gives none, when no file is set", () => {
    expect(createMinimums({ file: null, readFile: () => { throw new Error("read"); } })()).toEqual([]);
  });
  it("gives none while the file is not there, and the floor once it is", () => {
    const r = rig();
    expect(r.get()).toEqual([]);
    r.held.text = status({ [ADMIN]: entry("1.12") });
    r.clock.now += MINIMUMS_REREAD_MS;
    expect(r.get()).toMatchObject([{ floor: "1.12" }]);
  });
  it("reads the file again only when what it holds is old, so a change shows within a few seconds", () => {
    const r = rig(status({ [ADMIN]: entry("1.12") }));
    r.get(); r.get();
    expect(r.reads.n).toBe(1);
    r.held.text = status({ [ADMIN]: entry("1.2") });
    r.clock.now += MINIMUMS_REREAD_MS - 1;
    expect(r.get()).toMatchObject([{ floor: "1.12" }]);
    r.clock.now += 1;
    expect(r.get()).toMatchObject([{ floor: "1.2" }]);
  });
});

describe("GET /api/bridge/minimums", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const pins = "programVK=0x" + "cd".repeat(32) + "\nrootC=0x" + "ef".repeat(32) + "\n";
  const boot = (statusFile?: string) => createApi({
    config: loadConfig({ READER_PARTY: "reader::1220" + "ab".repeat(32), PINS_FILE: "guest.txt", ...(statusFile ? { PRODUCER_STATUS_FILE: statusFile } : {}) }, () => pins),
    reth: {} as never, ledger: {} as never, chain: {} as never,
  });
  const fileIn = (text: string) => { const d = mkdtempSync(join(tmpdir(), "status-")); dirs.push(d); const p = join(d, "status.json"); writeFileSync(p, text); return p; };

  it("lists the floors in the status file, with only the three fields", async () => {
    const a = await boot(fileIn(status({ [ADMIN]: entry("1.118016") })))("GET", "/api/bridge/minimums");
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ minimums: [{ instrumentAdmin: ADMIN, floor: "1.118016", readAt: "2026-11-22T09:00:00Z" }] });
  });
  it("answers an empty list with no setting, with no file, and with a file that holds no floor, so the page makes no check", async () => {
    for (const api of [boot(), boot("/nonexistent/status.json"), boot(fileIn(JSON.stringify({ state: "running" })))]) expect((await api("GET", "/api/bridge/minimums")).body).toEqual({ minimums: [] });
  });
  it("is a route of the description, and only GET", async () => {
    const api = boot();
    expect(api.routes).toContain("/api/bridge/minimums");
    expect((await api("POST", "/api/bridge/minimums")).status).toBe(405);
  });
});
