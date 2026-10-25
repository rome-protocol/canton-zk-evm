import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./config.ts";
import { gatewayLedgerFromConfig, ledgerFromConfig } from "./ledger-config.ts";
import { FAKE_GATEWAY, FAKE_READER, startFakeLedger, type FakeLedger } from "../test/fake-ledger.ts";

const SECRET = "tok." + randomBytes(24).toString("hex");   // made for each run
let dir = "", file = "", fake: FakeLedger | undefined;
const put = (text: string, mode = 0o600) => { writeFileSync(file, text, { mode }); chmodSync(file, mode); };
const settings = (url: string, ledgerTokenFile: string | null) => ({ ledgerUrl: url, rpcTimeoutMs: 2000, readerParty: FAKE_READER, ledgerTokenFile });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ledger-config-")); file = join(dir, "token"); });
afterEach(async () => { await fake?.close(); fake = undefined; rmSync(file, { force: true }); rmSync(dir, { recursive: true, force: true }); });

describe("the Ledger API client the server and the indexer build from the settings", () => {
  it("carries LEDGER_TOKEN_FILE on every call, and no header without it", async () => {
    put(SECRET);
    fake = await startFakeLedger([], { ledgerEnd: 3 });
    const withToken = ledgerFromConfig(settings(fake.url, file));
    await withToken.ledgerEnd(); await withToken.participantId();
    const without = ledgerFromConfig(settings(fake.url, null));
    await without.ledgerEnd();
    expect(fake.requests.map((r) => r.authorization)).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`, null]);
  });

  it("stops at start for a token file that is open to others, missing, empty or malformed, and the message names the variable and not the token", () => {
    put(SECRET, 0o640);
    for (const bad of [() => put(SECRET, 0o640), () => rmSync(file), () => put("  \n"), () => put(`${SECRET}\nX-Injected: yes`)]) {
      bad();
      let msg = "";
      try { ledgerFromConfig(settings("http://127.0.0.1:1", file)); } catch (e) { expect(e).toBeInstanceOf(ConfigError); msg = (e as Error).message; }
      expect(msg).toContain("LEDGER_TOKEN_FILE");
      expect(msg).not.toContain(SECRET);
    }
  });

  it("still reads the file on every call after it passed the check at start", async () => {
    put("first.token.value");
    fake = await startFakeLedger([], { ledgerEnd: 1 });
    const l = ledgerFromConfig(settings(fake.url, file));
    await l.ledgerEnd();
    put("second.token.value");
    await l.ledgerEnd();
    expect(fake.requests.map((r) => r.authorization)).toEqual(["Bearer first.token.value", "Bearer second.token.value"]);
  });

  it("builds the custody read's client for the gateway party with its own token file, and refuses a file open to others without printing it", async () => {
    put(SECRET);
    fake = await startFakeLedger([], { ledgerEnd: 9, active: [] });
    const ledger = gatewayLedgerFromConfig({ ledgerUrl: fake.url, rpcTimeoutMs: 2000 }, { party: FAKE_GATEWAY, tokenFile: file });
    expect(await ledger.gatewayCustody(10, 9)).toEqual({ offset: 9, tokens: [] });
    expect(fake.requests.every((r) => r.authorization === `Bearer ${SECRET}`)).toBe(true);
    put(SECRET, 0o640);
    let message = "";
    try { gatewayLedgerFromConfig({ ledgerUrl: fake.url, rpcTimeoutMs: 2000 }, { party: FAKE_GATEWAY, tokenFile: file }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("GATEWAY_LEDGER_TOKEN_FILE");
    expect(message).not.toContain(SECRET);
  });

  it("is the only way the server's and the indexer's entry points build their ledger", () => {
    for (const entry of ["main.ts", "indexer/cli.ts"]) {
      const text = readFileSync(new URL(entry, import.meta.url), "utf8");
      expect(text, entry).toContain("ledgerFromConfig(config)");
      expect(text, entry).not.toMatch(/\bcreateLedger\(/);
    }
  });
});
