import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import { createNotice, NOTICE_FILE_MAX, NOTICE_REREAD_MS, NOTICE_TEXT_MAX, parseNotice } from "./notice.ts";

const T = (s: string) => Date.parse(s);
const START = "2026-11-14T09:00:00Z", END = "2026-11-14T10:00:00Z";
const file = (over: Record<string, unknown> = {}) => JSON.stringify({ text: "Upgrading the DevNet validator database. Ostia pauses for about 45 minutes.", startsAt: START, endsAt: END, ...over });
const NOTICE = { text: "Upgrading the DevNet validator database. Ostia pauses for about 45 minutes.", startsAt: "2026-11-14T09:00:00.000Z", endsAt: "2026-11-14T10:00:00.000Z" };

/** A notice reader over a file that is whatever `held.text` is (undefined: not there), on a clock the test moves. */
function rig(initial?: string) {
  const held = { text: initial as string | undefined }, clock = { now: T("2026-11-14T08:00:00Z") }, reads = { n: 0 }, warned: string[] = [];
  const get = createNotice({
    file: "/var/lib/explorer/notice.json", now: () => clock.now, warn: (m) => warned.push(m),
    readFile: () => { reads.n++; if (held.text === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" }); return held.text; },
  });
  return { held, clock, reads, warned, get };
}

describe("parseNotice", () => {
  it("takes a text and two times, and gives them back in one form", () => {
    expect(parseNotice(file())).toEqual(NOTICE);
    expect(parseNotice(file({ startsAt: "2026-11-14T10:00:00+01:00", endsAt: "2026-11-14T11:00:00.5+01:00" }))).toEqual({ ...NOTICE, startsAt: "2026-11-14T09:00:00.000Z", endsAt: "2026-11-14T10:00:00.500Z" });
  });

  it("folds white space in the text and keeps it plain: markup is kept as the characters it is", () => {
    expect((parseNotice(file({ text: "  a\n\n b\t<b>c</b>  " })) as { text: string }).text).toBe("a b <b>c</b>");
  });

  it.each([
    ["not JSON", "{", /not JSON/],
    ["a list", "[]", /one JSON object/],
    ["null", "null", /one JSON object/],
    ["no text", JSON.stringify({ startsAt: START, endsAt: END }), /text must be a string/],
    ["a text that is not a string", file({ text: 5 }), /text must be a string/],
    ["an empty text", file({ text: " \n " }), /text is empty/],
    ["a text that is too long", file({ text: "x".repeat(NOTICE_TEXT_MAX + 1) }), /longer than 300/],
    ["a file that is too long", file({ extra: "x".repeat(NOTICE_FILE_MAX) }), /file is longer/],
    ["no start", JSON.stringify({ text: "a", endsAt: END }), /startsAt must be/],
    ["a time with no zone", file({ startsAt: "2026-11-14T09:00:00" }), /startsAt must be/],
    ["a time that is not a date", file({ endsAt: "2026-13-45T09:00:00Z" }), /endsAt must be/],
    ["a time that is a number", file({ endsAt: 1794000000000 }), /endsAt must be/],
    ["an end that is not after the start", file({ endsAt: START }), /endsAt must be after startsAt/],
  ])("refuses %s", (_name, raw, why) => {
    expect(parseNotice(raw)).toMatch(why);
  });

  it("accepts a text of exactly the longest length", () => {
    expect(parseNotice(file({ text: "x".repeat(NOTICE_TEXT_MAX) }))).toMatchObject({ text: "x".repeat(NOTICE_TEXT_MAX) });
  });
});

describe("createNotice", () => {
  it("is null with no setting, and reads nothing", () => {
    let reads = 0;
    expect(createNotice({ file: null, readFile: () => { reads++; return file(); } })()).toBeNull();
    expect(reads).toBe(0);
  });

  it("is null when the file is not there, and says nothing: that is the normal case", () => {
    const r = rig();
    expect(r.get()).toBeNull();
    expect(r.warned).toEqual([]);
  });

  it("is null for a file that is not a notice, and says why once, not at every look", () => {
    const r = rig("{ nope");
    expect(r.get()).toBeNull();
    r.clock.now += NOTICE_REREAD_MS;
    expect(r.get()).toBeNull();
    expect(r.warned).toHaveLength(1);
    expect(r.warned[0]).toMatch(/not shown: the file is not JSON/);
    r.held.text = file({ text: "x".repeat(NOTICE_TEXT_MAX + 1) });
    r.clock.now += NOTICE_REREAD_MS;
    expect(r.get()).toBeNull();
    expect(r.warned).toHaveLength(2);
  });

  it("is null for a file that cannot be read for another reason, and says so", () => {
    const warned: string[] = [];
    const get = createNotice({ file: "/n.json", warn: (m) => warned.push(m), readFile: () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); } });
    expect(get()).toBeNull();
    expect(warned).toEqual(expect.arrayContaining([expect.stringContaining("cannot be read: permission denied")]));
  });

  it("gives the notice before it starts, while it runs, and not after it ends", () => {
    const r = rig(file());
    expect(r.get()).toEqual(NOTICE);
    r.clock.now = T("2026-11-14T09:30:00Z");
    expect(r.get()).toEqual(NOTICE);
    r.clock.now = T("2026-11-14T09:59:59Z");
    expect(r.get()).toEqual(NOTICE);
    r.clock.now = T(END);
    expect(r.get()).toBeNull();
    r.clock.now = T("2026-11-15T00:00:00Z");
    expect(r.get()).toBeNull();
  });

  it("ends a held notice at its endsAt even between two reads of the file", () => {
    const r = rig(file());
    r.clock.now = T("2026-11-14T09:59:58.500Z");
    expect(r.get()).toEqual(NOTICE);
    r.clock.now = T(END) + 1; // under the re-read time: the file is not read again, the end is still checked
    expect(r.get()).toBeNull();
    expect(r.reads.n).toBe(1);
  });

  it("reads the file again after a few seconds, never at every call, and with no restart", () => {
    const r = rig();
    expect(r.get()).toBeNull();
    r.held.text = file();
    for (let i = 0; i < 10; i++) { r.clock.now += 200; expect(r.get()).toBeNull(); }
    expect(r.reads.n).toBe(1);
    r.clock.now += NOTICE_REREAD_MS;
    expect(r.get()).toEqual(NOTICE);
    r.held.text = file({ text: "New words." });
    r.clock.now += NOTICE_REREAD_MS;
    expect(r.get()).toMatchObject({ text: "New words." });
    r.held.text = undefined; // cleared: the file is removed
    r.clock.now += NOTICE_REREAD_MS;
    expect(r.get()).toBeNull();
    r.held.text = "{";
    r.clock.now += NOTICE_REREAD_MS;
    expect(r.get()).toBeNull();
    expect(r.reads.n).toBe(5);
  });

  it("reads a real file, and sees it replaced by a rename the way an editor or a script does", () => {
    const dir = mkdtempSync(join(tmpdir(), "notice-"));
    try {
      const path = join(dir, "notice.json");
      let now = T("2026-11-14T08:00:00Z");
      const get = createNotice({ file: path, now: () => now });
      expect(get()).toBeNull();
      writeFileSync(join(dir, "tmp"), file());
      renameSync(join(dir, "tmp"), path);
      now += NOTICE_REREAD_MS;
      expect(get()).toEqual(NOTICE);
      rmSync(path);
      now += NOTICE_REREAD_MS;
      expect(get()).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("/api/status", () => {
  const dirs: string[] = [];
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const pins = "programVK=0x" + "cd".repeat(32) + "\nrootC=0x" + "ef".repeat(32) + "\n";
  const down = async () => { throw new Error("down"); };
  /** The status of an explorer whose reth, Canton and database cannot be read at all, which is what an outage looks like. */
  function boot(noticeFile: string | undefined, now: () => number) {
    const config = loadConfig({ READER_PARTY: "reader::1220" + "ab".repeat(32), PINS_FILE: "guest.txt", ...(noticeFile ? { OSTIA_NOTICE_FILE: noticeFile } : {}) }, () => pins);
    const reth = { block: async () => undefined } as never, ledger = { ledgerEnd: down } as never;
    const chain = { head: down, latest: down, indexer: down, indexFacts: down } as never;
    return createApi({ config, reth, ledger, chain, now });
  }
  const fileIn = (text: string) => { const d = mkdtempSync(join(tmpdir(), "notice-")); dirs.push(d); const p = join(d, "notice.json"); writeFileSync(p, text); return p; };

  it("has notice: null with no setting, with no file, and with a file that is not a notice; every other field is as before", async () => {
    const now = () => T("2026-11-14T08:00:00Z");
    const plain = await boot(undefined, now)("GET", "/api/status");
    expect(plain.body).toMatchObject({ notice: null });
    expect((await boot("/nonexistent/notice.json", now)("GET", "/api/status")).body).toMatchObject({ notice: null });
    const bad = await boot(fileIn("{"), now)("GET", "/api/status");
    expect(bad.body).toMatchObject({ notice: null });
    const { notice: _n, ...rest } = bad.body as Record<string, unknown>;
    const { notice: _m, ...before } = plain.body as Record<string, unknown>;
    expect(rest).toEqual(before);
  });

  it("carries the notice while it has not ended, even when the explorer answers 503 for an outage, and not after its end", async () => {
    let t = T("2026-11-14T08:30:00Z");
    const api = boot(fileIn(file()), () => t);
    const before = await api("GET", "/api/status");
    expect(before.status).toBe(503);
    expect(before.body).toMatchObject({ notice: NOTICE });
    expect(Object.keys((before.body as { notice: object }).notice).sort()).toEqual(["endsAt", "startsAt", "text"]);
    t = T("2026-11-14T09:10:00Z");
    expect((await api("GET", "/healthz")).body).toMatchObject({ notice: NOTICE });
    t = T("2026-11-14T10:00:01Z");
    expect((await api("GET", "/api/status")).body).toMatchObject({ notice: null });
  });
});
