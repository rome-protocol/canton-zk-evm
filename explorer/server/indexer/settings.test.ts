import { describe, expect, it } from "vitest";
import { IndexerSettingsError, loadIndexerSettings } from "./settings.ts";

const GW = "0x" + "9A".repeat(20);

describe("the indexer's settings", () => {
  it("defaults to stage 2 inline, and lowercases the gateway", () => {
    expect(loadIndexerSettings({ GATEWAY_ADDRESS: GW })).toEqual({ gateway: "0x" + "9a".repeat(20), derive: "inline", pollMs: 250, rethBehindMs: 10_000 });
  });
  it("takes behind and the timers", () => {
    expect(loadIndexerSettings({ GATEWAY_ADDRESS: GW, INDEX_DERIVE: "behind", INDEX_POLL_MS: "500" })).toMatchObject({ derive: "behind", pollMs: 500 });
  });
  it("refuses a missing or wrong gateway, a wrong shape and a bad number", () => {
    for (const env of [{}, { GATEWAY_ADDRESS: "0x12" }, { GATEWAY_ADDRESS: GW, INDEX_DERIVE: "later" }, { GATEWAY_ADDRESS: GW, INDEX_POLL_MS: "5" }, { GATEWAY_ADDRESS: GW, INDEX_POLL_MS: "x" }]) {
      expect(() => loadIndexerSettings(env)).toThrow(IndexerSettingsError);
    }
  });
});
