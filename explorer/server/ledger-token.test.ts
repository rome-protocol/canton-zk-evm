import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger, LedgerError, readLedgerToken } from "./ledger.ts";
import { FAKE_READER, startFakeLedger, type FakeLedger } from "../test/fake-ledger.ts";

const SECRET = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvc3RpYS1yZWFkZXIifQ.c2lnbmF0dXJlLXNlY3JldA";
let dir = "", file = "", fake: FakeLedger | undefined;
const put = (text: string, mode = 0o600) => { writeFileSync(file, text, { mode }); chmodSync(file, mode); };
const messageOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return ""; };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ledger-token-")); file = join(dir, "token"); });
afterEach(async () => {
  await fake?.close(); fake = undefined;
  rmSync(file, { force: true }); rmSync(dir, { recursive: true, force: true });   // the one file and the one folder this test made
  vi.restoreAllMocks();
});

describe("the Ledger API token", () => {
  it("is sent as a bearer token on every call when a token file is set", async () => {
    put(SECRET + "\n");
    fake = await startFakeLedger([], { ledgerEnd: 3 });
    const l = createLedger(fake.url, 2000, FAKE_READER, 100, file);
    await l.ledgerEnd(); await l.participantId(); await l.records(0, 3);
    expect(fake.requests.length).toBeGreaterThanOrEqual(3);
    for (const r of fake.requests) expect(r.authorization).toBe(`Bearer ${SECRET}`);
  });

  it("sends no Authorization header when no token file is set", async () => {
    fake = await startFakeLedger([], { ledgerEnd: 3 });
    const l = createLedger(fake.url, 2000, FAKE_READER);
    await l.ledgerEnd(); await l.participantId();
    expect(fake.requests.map((r) => r.authorization)).toEqual([null, null]);
  });

  it("is read again on each call, so a refreshed file is picked up", async () => {
    put("first.token.value");
    fake = await startFakeLedger([], { ledgerEnd: 1 });
    const l = createLedger(fake.url, 2000, FAKE_READER, 100, file);
    await l.ledgerEnd();
    put("second.token.value");
    await l.ledgerEnd();
    expect(fake.requests.map((r) => r.authorization)).toEqual(["Bearer first.token.value", "Bearer second.token.value"]);
  });

  it("is refused from a file that the group or others can read, and nothing is sent", async () => {
    put(SECRET, 0o640);
    fake = await startFakeLedger([], { ledgerEnd: 1 });
    const l = createLedger(fake.url, 2000, FAKE_READER, 100, file);
    const msg = await messageOf(l.ledgerEnd());
    expect(msg).toMatch(/LEDGER_TOKEN_FILE .* owner only \(chmod 600\)/);
    expect(msg).not.toContain(SECRET);
    expect(fake.requests).toEqual([]);
    chmodSync(file, 0o604);
    await expect(l.ledgerEnd()).rejects.toThrow(LedgerError);
  });

  it("is refused when the file is missing, empty or holds more than a token, without showing what it holds", async () => {
    expect(() => readLedgerToken(join(dir, "nothing"))).toThrow(/cannot be read/);
    put("   \n");
    expect(() => readLedgerToken(file)).toThrow(/one token/);
    put(`${SECRET}\nX-Injected: yes`);
    const msg = await messageOf(Promise.resolve().then(() => readLedgerToken(file)));
    expect(msg).toMatch(/one token and nothing else/);
    expect(msg).not.toContain(SECRET);
  });

  it("never appears in an error or a log line, when Canton refuses it or cannot be reached", async () => {
    put(SECRET);
    const logged: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a) => { logged.push(a.join(" ")); });
    fake = await startFakeLedger([], { httpStatus: 401 });
    const refused = await messageOf(createLedger(fake.url, 2000, FAKE_READER, 100, file).ledgerEnd());
    expect(refused).toMatch(/HTTP 401/);
    const down = await messageOf(createLedger("http://127.0.0.1:1", 500, FAKE_READER, 100, file).ledgerEnd());
    expect(down).toMatch(/cannot read Canton/);
    for (const text of [refused, down, ...logged]) { expect(text).not.toContain(SECRET); expect(text).not.toContain("Bearer"); }
  });
});
