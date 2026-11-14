import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import { createNotices, NOTICE_FILE_MAX, NOTICE_LABEL_MAX, NOTICE_REREAD_MS, NOTICE_TEXT_MAX, NOTICE_URL_MAX, NOTICES_MAX, parseNotices } from "./notice.ts";

const T = (s: string) => Date.parse(s);
const START = "2026-11-14T09:00:00Z", END = "2026-11-14T10:00:00Z";
const file = (over: Record<string, unknown> = {}) => JSON.stringify({ text: "Upgrading the DevNet validator database. Ostia pauses for about 45 minutes.", startsAt: START, endsAt: END, ...over });
const MAJOR = { text: "This DevNet chain moves to Canton TestNet. Nothing needs doing unless you hold tokens you want to keep.", startsAt: "2026-11-13T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z", level: "major" as const, link: { url: "https://explorer.example.org/docs/move", label: "What is changing" } };
const majorFile = (over: Record<string, unknown> = {}) => ({ ...MAJOR, ...over });
const NOTICE = { text: "Upgrading the DevNet validator database. Ostia pauses for about 45 minutes.", startsAt: "2026-11-14T09:00:00.000Z", endsAt: "2026-11-14T10:00:00.000Z" };

/** A notice reader over a file that is whatever `held.text` is (undefined: not there), on a clock the test moves. */
function rig(initial?: string) {
  const held = { text: initial as string | undefined }, clock = { now: T("2026-11-14T08:00:00Z") }, reads = { n: 0 }, warned: string[] = [];
  const get = createNotices({
    file: "/var/lib/explorer/notice.json", now: () => clock.now, warn: (m) => warned.push(m),
    readFile: () => { reads.n++; if (held.text === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" }); return held.text; },
  });
  return { held, clock, reads, warned, get };
}

describe("parseNotices", () => {
  it("takes a text and two times, and gives them back in one form", () => {
    expect(parseNotices(file())).toEqual([NOTICE]);
    expect(parseNotices(file())).toEqual(parseNotices(`[${file()}]`));
    expect(parseNotices(file({ startsAt: "2026-11-14T10:00:00+01:00", endsAt: "2026-11-14T11:00:00.5+01:00" }))).toEqual([{ ...NOTICE, startsAt: "2026-11-14T09:00:00.000Z", endsAt: "2026-11-14T10:00:00.500Z" }]);
  });

  it("folds white space in the text and keeps it plain: markup is kept as the characters it is", () => {
    expect((parseNotices(file({ text: "  a\n\n b\t<b>c</b>  " })) as { text: string }[])[0]!.text).toBe("a b <b>c</b>");
  });

  it.each([
    ["not JSON", "{", /not JSON/],
    ["a number", "5", /a JSON object or a list/],
    ["null", "null", /a JSON object or a list/],
    ["a list of something that is not a notice", "[5]", /notice 1: a notice must be a JSON object/],
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
    expect(parseNotices(raw)).toMatch(why);
  });

  it("accepts a text of exactly the longest length", () => {
    expect(parseNotices(file({ text: "x".repeat(NOTICE_TEXT_MAX) }))).toMatchObject([{ text: "x".repeat(NOTICE_TEXT_MAX) }]);
  });
});

describe("parseNotices: the list form, the level and the link", () => {
  const list = (...items: unknown[]) => JSON.stringify(items);

  it("takes a list, keeps the plain form working, and an empty list is no notice", () => {
    expect(parseNotices(list(JSON.parse(file()), majorFile()))).toEqual([NOTICE, MAJOR]);
    expect(parseNotices(list())).toEqual([]);
    expect(parseNotices(file())).toEqual([NOTICE]);
  });

  it("keeps level and link only when they are there, and a notice with neither has neither key", () => {
    const [n] = parseNotices(file()) as object[];
    expect(Object.keys(n!).sort()).toEqual(["endsAt", "startsAt", "text"]);
    expect(parseNotices(file({ level: "major" }))).toEqual([{ ...NOTICE, level: "major" }]);
    expect(parseNotices(file({ link: { url: "https://example.org/a", label: "More" } }))).toEqual([{ ...NOTICE, link: { url: "https://example.org/a", label: "More" } }]);
  });

  it("refuses a level other than major, and says which notice of a list is wrong", () => {
    expect(parseNotices(file({ level: "minor" }))).toMatch(/level must be "major"/);
    expect(parseNotices(file({ level: "MAJOR" }))).toMatch(/level must be "major"/);
    expect(parseNotices(file({ level: 1 }))).toMatch(/level must be "major"/);
    expect(parseNotices(list(JSON.parse(file()), majorFile({ endsAt: "2026-11-01T00:00:00Z" })))).toMatch(/^notice 2: endsAt must be after startsAt/);
  });

  it("holds at most the most notices, and the whole file is refused when one is not valid", () => {
    expect(parseNotices(list(...Array.from({ length: NOTICES_MAX }, () => ({ text: "a", startsAt: START, endsAt: END }))))).toHaveLength(NOTICES_MAX);
    expect(parseNotices(list(...Array.from({ length: NOTICES_MAX + 1 }, () => ({ text: "a", startsAt: START, endsAt: END }))))).toMatch(/more than 5 notices/);
    expect(parseNotices(list(JSON.parse(file()), { text: "", startsAt: START, endsAt: END }))).toMatch(/^notice 2: text is empty/);
  });

  it("takes an http or https link only, as a string and never as HTML, and folds the label like the text", () => {
    const ok = (url: string) => parseNotices(file({ link: { url, label: " What\n is  changing " } })) as { link: { url: string; label: string } }[];
    expect(ok("http://example.org/move")[0]!.link).toEqual({ url: "http://example.org/move", label: "What is changing" });
    expect(ok("https://example.org/move?a=1#top")[0]!.link.url).toBe("https://example.org/move?a=1#top");
    expect(ok("HTTPS://Example.ORG")[0]!.link.url).toBe("https://example.org/");
    const bad: [string, unknown, RegExp][] = [
      ["javascript:", { url: "javascript:alert(1)", label: "x" }, /must be http or https/],
      ["data:", { url: "data:text/html,<b>x</b>", label: "x" }, /must be http or https/],
      ["ftp:", { url: "ftp://example.org/a", label: "x" }, /must be http or https/],
      ["file:", { url: "file:///etc/passwd", label: "x" }, /must be http or https/],
      ["mailto:", { url: "mailto:a@example.org", label: "x" }, /must be http or https/],
      ["a relative address", { url: "/docs/move", label: "x" }, /not an address/],
      ["a scheme-relative address", { url: "//example.org/a", label: "x" }, /not an address/],
      ["white space", { url: "https://example.org/a b", label: "x" }, /white space/],
      ["a newline", { url: "https://example.org/\nx", label: "x" }, /white space/],
      ["a tab before the scheme", { url: "\tjavascript:alert(1)", label: "x" }, /white space/],
      ["a user name", { url: "https://good.example@evil.example/", label: "x" }, /user name or password/],
      ["a password", { url: "https://u:p@example.org/", label: "x" }, /user name or password/],
      ["a url that is too long", { url: "https://example.org/" + "a".repeat(NOTICE_URL_MAX), label: "x" }, /url is longer/],
      ["a url that is not a string", { url: 5, label: "x" }, /needs a url and a label/],
      ["no label", { url: "https://example.org/" }, /needs a url and a label/],
      ["an empty label", { url: "https://example.org/", label: "  " }, /label is empty/],
      ["a label that is too long", { url: "https://example.org/", label: "x".repeat(NOTICE_LABEL_MAX + 1) }, /label is longer/],
      ["a link that is a string", "https://example.org/", /link must be an object/],
      ["a link that is null", null, /link must be an object/],
      ["a link that is a list", [], /link must be an object/],
    ];
    for (const [name, link, why] of bad) expect(parseNotices(file({ link })), name).toMatch(why);
  });

  it("keeps the label as the characters it is: markup in it is not an element", () => {
    const [n] = parseNotices(file({ link: { url: "https://example.org/", label: "<img src=x onerror=1>" } })) as { link: { label: string } }[];
    expect(n!.link.label).toBe("<img src=x onerror=1>");
  });
});

describe("createNotices", () => {
  it("is empty with no setting, and reads nothing", () => {
    let reads = 0;
    expect(createNotices({ file: null, readFile: () => { reads++; return file(); } })()).toEqual([]);
    expect(reads).toBe(0);
  });

  it("is null when the file is not there, and says nothing: that is the normal case", () => {
    const r = rig();
    expect(r.get()).toEqual([]);
    expect(r.warned).toEqual([]);
  });

  it("is null for a file that is not a notice, and says why once, not at every look", () => {
    const r = rig("{ nope");
    expect(r.get()).toEqual([]);
    r.clock.now += NOTICE_REREAD_MS;
    expect(r.get()).toEqual([]);
    expect(r.warned).toHaveLength(1);
    expect(r.warned[0]).toMatch(/not shown: the file is not JSON/);
    r.held.text = file({ text: "x".repeat(NOTICE_TEXT_MAX + 1) });
    r.clock.now += NOTICE_REREAD_MS;
    expect(r.get()).toEqual([]);
    expect(r.warned).toHaveLength(2);
  });

  it("is null for a file that cannot be read for another reason, and says so", () => {
    const warned: string[] = [];
    const get = createNotices({ file: "/n.json", warn: (m) => warned.push(m), readFile: () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); } });
    expect(get()).toEqual([]);
    expect(warned).toEqual(expect.arrayContaining([expect.stringContaining("cannot be read: permission denied")]));
  });

  it("gives the notice before it starts, while it runs, and not after it ends", () => {
    const r = rig(file());
    expect(r.get()).toEqual([NOTICE]);
    r.clock.now = T("2026-11-14T09:30:00Z");
    expect(r.get()).toEqual([NOTICE]);
    r.clock.now = T("2026-11-14T09:59:59Z");
    expect(r.get()).toEqual([NOTICE]);
    r.clock.now = T(END);
    expect(r.get()).toEqual([]);
    r.clock.now = T("2026-11-15T00:00:00Z");
    expect(r.get()).toEqual([]);
  });

  it("ends a held notice at its endsAt even between two reads of the file", () => {
    const r = rig(file());
    r.clock.now = T("2026-11-14T09:59:58.500Z");
    expect(r.get()).toEqual([NOTICE]);
    r.clock.now = T(END) + 1; // under the re-read time: the file is not read again, the end is still checked
    expect(r.get()).toEqual([]);
    expect(r.reads.n).toBe(1);
  });

  it("reads the file again after a few seconds, never at every call, and with no restart", () => {
    const r = rig();
    expect(r.get()).toEqual([]);
    r.held.text = file();
    for (let i = 0; i < 10; i++) { r.clock.now += 200; expect(r.get()).toEqual([]); }
    expect(r.reads.n).toBe(1);
    r.clock.now += NOTICE_REREAD_MS;
    expect(r.get()).toEqual([NOTICE]);
    r.held.text = file({ text: "New words." });
    r.clock.now += NOTICE_REREAD_MS;
    expect(r.get()).toMatchObject([{ text: "New words." }]);
    r.held.text = undefined; // cleared: the file is removed
    r.clock.now += NOTICE_REREAD_MS;
    expect(r.get()).toEqual([]);
    r.held.text = "{";
    r.clock.now += NOTICE_REREAD_MS;
    expect(r.get()).toEqual([]);
    expect(r.reads.n).toBe(5);
  });

  it("gives a list major first, the rest after them, each group in the file's order, and drops each at its own end", () => {
    const a = { text: "A", startsAt: START, endsAt: END }, b = { text: "B", startsAt: START, endsAt: "2026-11-14T12:00:00Z" };
    const r = rig(JSON.stringify([a, majorFile({ text: "M1" }), b, majorFile({ text: "M2", endsAt: "2026-11-14T09:30:00Z" })]));
    expect(r.get().map((n) => n.text)).toEqual(["M1", "M2", "A", "B"]);
    r.clock.now = T("2026-11-14T09:40:00Z");
    expect(r.get().map((n) => n.text)).toEqual(["M1", "A", "B"]);
    r.clock.now = T(END);
    expect(r.get().map((n) => n.text)).toEqual(["M1", "B"]);
    r.clock.now = T("2026-11-14T12:00:00Z");
    expect(r.get().map((n) => n.text)).toEqual(["M1"]);
    r.clock.now = T("2026-12-01T00:00:00Z");
    expect(r.get()).toEqual([]);
  });

  it("gives a major notice before it starts, while it runs, and not after it ends, with its link", () => {
    const r = rig(JSON.stringify(majorFile({ startsAt: "2026-11-14T09:00:00Z", endsAt: END })));
    expect(r.get()).toEqual([{ ...MAJOR, startsAt: "2026-11-14T09:00:00.000Z", endsAt: "2026-11-14T10:00:00.000Z" }]);
    r.clock.now = T("2026-11-14T09:30:00Z");
    expect(r.get()[0]).toMatchObject({ level: "major", link: MAJOR.link });
    r.clock.now = T(END);
    expect(r.get()).toEqual([]);
  });

  it("says a bad notice in a list once and shows none of the file", () => {
    const r = rig(JSON.stringify([JSON.parse(file()), majorFile({ link: { url: "javascript:alert(1)", label: "x" } })]));
    expect(r.get()).toEqual([]);
    r.clock.now += NOTICE_REREAD_MS;
    expect(r.get()).toEqual([]);
    expect(r.warned).toHaveLength(1);
    expect(r.warned[0]).toMatch(/notice 2: link url must be http or https/);
  });

  it("reads a real file, and sees it replaced by a rename the way an editor or a script does", () => {
    const dir = mkdtempSync(join(tmpdir(), "notice-"));
    try {
      const path = join(dir, "notice.json");
      let now = T("2026-11-14T08:00:00Z");
      const get = createNotices({ file: path, now: () => now });
      expect(get()).toEqual([]);
      writeFileSync(join(dir, "tmp"), file());
      renameSync(join(dir, "tmp"), path);
      now += NOTICE_REREAD_MS;
      expect(get()).toEqual([NOTICE]);
      rmSync(path);
      now += NOTICE_REREAD_MS;
      expect(get()).toEqual([]);
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

  it("carries notices (the list, major first) and notice (the first, for old clients), with the level and the link only where there are any", async () => {
    let t = T("2026-11-14T08:30:00Z");
    const list = JSON.stringify([JSON.parse(file()), majorFile({ endsAt: "2026-11-14T09:30:00Z" })]);
    const api = boot(fileIn(list), () => t);
    const body = (await api("GET", "/api/status")).body as { notice: unknown; notices: Record<string, unknown>[] };
    expect(body.notices).toHaveLength(2);
    expect(body.notices[0]).toEqual({ ...MAJOR, endsAt: "2026-11-14T09:30:00.000Z" });
    expect(body.notice).toEqual(body.notices[0]);
    expect(Object.keys(body.notices[0]!).sort()).toEqual(["endsAt", "level", "link", "startsAt", "text"]);
    expect(Object.keys(body.notices[0]!.link as object).sort()).toEqual(["label", "url"]);
    expect(body.notices[1]).toEqual(NOTICE);
    expect(Object.keys(body.notices[1]!).sort()).toEqual(["endsAt", "startsAt", "text"]);
    t = T("2026-11-14T09:45:00Z"); // the major one has ended: the slim one is the first now
    const later = (await api("GET", "/healthz")).body as { notice: unknown; notices: unknown[] };
    expect(later.notices).toEqual([NOTICE]);
    expect(later.notice).toEqual(NOTICE);
    t = T("2026-11-14T10:00:01Z");
    expect((await api("GET", "/api/status")).body).toMatchObject({ notice: null, notices: [] });
  });

  it("has notices: [] where it has notice: null, and the single form gives a list of one", async () => {
    const now = () => T("2026-11-14T08:00:00Z");
    expect((await boot(undefined, now)("GET", "/api/status")).body).toMatchObject({ notice: null, notices: [] });
    expect((await boot(fileIn("{"), now)("GET", "/api/status")).body).toMatchObject({ notice: null, notices: [] });
    expect((await boot(fileIn(file()), now)("GET", "/api/status")).body).toMatchObject({ notice: NOTICE, notices: [NOTICE] });
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
