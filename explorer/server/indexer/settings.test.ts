import { describe, expect, it } from "vitest";
import { IndexerSettingsError, loadIndexerSettings } from "./settings.ts";

const GW = "0x" + "9A".repeat(20);

describe("the indexer's settings", () => {
  it("defaults to stage 2 inline, and lowercases the gateway", () => {
    expect(loadIndexerSettings({ GATEWAY_ADDRESS: GW })).toEqual({ gateway: "0x" + "9a".repeat(20), derive: "inline", pollMs: 250, rethBehindMs: 10_000, traceTimeoutMs: 60_000, genesisFile: null, journalDir: null, producerStatusFile: null, journalMs: 1000 });
  });
  it("takes behind and the timers", () => {
    expect(loadIndexerSettings({ GATEWAY_ADDRESS: GW, INDEX_DERIVE: "behind", INDEX_POLL_MS: "500", INDEX_TRACE_TIMEOUT_MS: "90000" })).toMatchObject({ derive: "behind", pollMs: 500, traceTimeoutMs: 90_000 });
  });
  it("takes the genesis file's path", () => {
    expect(loadIndexerSettings({ GATEWAY_ADDRESS: GW, GENESIS_FILE: "/state/genesis.json" }).genesisFile).toBe("/state/genesis.json");
  });
  it("takes the producer's journal folder and status file, and how often the journal is read", () => {
    expect(loadIndexerSettings({ GATEWAY_ADDRESS: GW, JOURNAL_DIR: "/work/journal", PRODUCER_STATUS_FILE: "/work/status.json", INDEX_JOURNAL_MS: "500" })).toMatchObject({ journalDir: "/work/journal", producerStatusFile: "/work/status.json", journalMs: 500 });
    expect(() => loadIndexerSettings({ GATEWAY_ADDRESS: GW, INDEX_JOURNAL_MS: "10" })).toThrow(IndexerSettingsError);
  });
  it("refuses a missing or wrong gateway, a wrong shape and a bad number", () => {
    for (const env of [{}, { GATEWAY_ADDRESS: "0x12" }, { GATEWAY_ADDRESS: GW, INDEX_DERIVE: "later" }, { GATEWAY_ADDRESS: GW, INDEX_POLL_MS: "5" }, { GATEWAY_ADDRESS: GW, INDEX_POLL_MS: "x" }]) {
      expect(() => loadIndexerSettings(env)).toThrow(IndexerSettingsError);
    }
  });
});
