import { describe, expect, it } from "vitest";
import { IndexerSettingsError, loadIndexerSettings } from "./settings.ts";

const GW = "0x" + "9A".repeat(20);

describe("the indexer's settings", () => {
  it("defaults to stage 2 behind (W1 measured inline over B1), and lowercases the gateway", () => {
    expect(loadIndexerSettings({ GATEWAY_ADDRESS: GW })).toEqual({ gateway: "0x" + "9a".repeat(20), derive: "behind", pollMs: 250, rethBehindMs: 10_000, traceTimeoutMs: 60_000, readCallGas: 100_000, genesisFile: null, journalDir: null, producerStatusFile: null, journalMs: 1000, custody: null });
  });
  it("takes inline and the timers", () => {
    expect(loadIndexerSettings({ GATEWAY_ADDRESS: GW, INDEX_DERIVE: "inline", INDEX_POLL_MS: "500", INDEX_TRACE_TIMEOUT_MS: "90000", READ_CALL_GAS: "500000" })).toMatchObject({ derive: "inline", pollMs: 500, traceTimeoutMs: 90_000, readCallGas: 500_000 });
  });
  it("takes the genesis file's path", () => {
    expect(loadIndexerSettings({ GATEWAY_ADDRESS: GW, GENESIS_FILE: "/state/genesis.json" }).genesisFile).toBe("/state/genesis.json");
  });
  it("takes the producer's journal folder and status file, and how often the journal is read", () => {
    expect(loadIndexerSettings({ GATEWAY_ADDRESS: GW, JOURNAL_DIR: "/work/journal", PRODUCER_STATUS_FILE: "/work/status.json", INDEX_JOURNAL_MS: "500" })).toMatchObject({ journalDir: "/work/journal", producerStatusFile: "/work/status.json", journalMs: 500 });
    expect(() => loadIndexerSettings({ GATEWAY_ADDRESS: GW, INDEX_JOURNAL_MS: "10" })).toThrow(IndexerSettingsError);
  });
  it("takes the custody read's party and token file together, and its interval", () => {
    const party = "gateway::1220" + "cd".repeat(32);
    expect(loadIndexerSettings({ GATEWAY_ADDRESS: GW, GATEWAY_PARTY: party, GATEWAY_LEDGER_TOKEN_FILE: "/state/gateway.token" }).custody).toEqual({ party, tokenFile: "/state/gateway.token", ms: 30_000, limit: 200 });
    expect(loadIndexerSettings({ GATEWAY_ADDRESS: GW, GATEWAY_PARTY: party, GATEWAY_LEDGER_TOKEN_FILE: "/state/gateway.token", CUSTODY_MS: "5000", CUSTODY_LIMIT: "50" }).custody).toMatchObject({ ms: 5000, limit: 50 });
    // The read is the one place the explorer reads as the gateway, so it needs both, or it is off: never the reader's own token for the gateway's party.
    for (const env of [{ GATEWAY_PARTY: party }, { GATEWAY_LEDGER_TOKEN_FILE: "/state/gateway.token" }, { GATEWAY_PARTY: party, GATEWAY_LEDGER_TOKEN_FILE: "/t", CUSTODY_MS: "10" }, { GATEWAY_PARTY: party, GATEWAY_LEDGER_TOKEN_FILE: "/t", CUSTODY_LIMIT: "0" }]) {
      expect(() => loadIndexerSettings({ GATEWAY_ADDRESS: GW, ...env })).toThrow(IndexerSettingsError);
    }
  });
  it("refuses a missing or wrong gateway, a wrong shape and a bad number", () => {
    for (const env of [{}, { GATEWAY_ADDRESS: "0x12" }, { GATEWAY_ADDRESS: GW, INDEX_DERIVE: "later" }, { GATEWAY_ADDRESS: GW, INDEX_POLL_MS: "5" }, { GATEWAY_ADDRESS: GW, INDEX_POLL_MS: "x" }]) {
      expect(() => loadIndexerSettings(env)).toThrow(IndexerSettingsError);
    }
  });
});
