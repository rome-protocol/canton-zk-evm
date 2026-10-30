import { describe, expect, it } from "vitest";
import { createTwinsRest, custodyMatched, twinMatched, twinSupplyOf, TWIN_LEGS_MAX } from "./twins-rest.ts";

const b = (n: number, len = 20) => Buffer.alloc(len, n);
const hexOf = (n: number, len = 20) => "0x" + b(n, len).toString("hex");

describe("the twin numbers", () => {
  it("takes the releases from the locks", () => {
    expect(twinSupplyOf("900", "400")).toBe("500");
    expect(twinSupplyOf("0", "0")).toBe("0");
    expect(twinSupplyOf("123456789012345678901234567890", "1")).toBe("123456789012345678901234567889");
  });

  it("matches the vaults to the twin only when the balance is known and equal", () => {
    expect(twinMatched("500", "500")).toBe(true);
    expect(twinMatched("500", "480")).toBe(false);
    expect(twinMatched("0", "0")).toBe(true);
    expect(twinMatched("500", null)).toBe(false);
  });

  it("matches a Canton token's custody (10 decimals) to its wrapped supply (the token's decimals)", () => {
    expect(custodyMatched("1230000000000", "123000000", 6)).toBe(true);
    expect(custodyMatched("1230000000000", "123000001", 6)).toBe(false);
    expect(custodyMatched("5", "5000000000000000000", 18)).toBe(false);
    expect(custodyMatched("12300000000000", "123000000000000000000", 18)).toBe(false);
    expect(custodyMatched("10000000000", "1000000000000000000", 18)).toBe(true);
    expect(custodyMatched("1230000000001", "123000000", 6)).toBe(false);
    expect(custodyMatched("10000000000", null, 6)).toBeNull();
    expect(custodyMatched("10000000000", "1000000", null)).toBeNull();
  });
});

describe("the twins overview, from the rows the indexer keeps", () => {
  const rows = (sql: string, values: unknown[]) => {
    if (sql.includes("from canton_registry where kind = 'vault'")) return [{ address: b(0xc1), code_hash: b(1, 32) }];
    if (sql.includes("from meta")) return [{ value: "7" }];
    if (sql.includes("from canton_twins w")) {
      return [
        { token: b(0xb1), decimals: 6, symbol: "TKA", name: "Token A", locked: "900", released: "400", locks: "3", releases: "1", vault_balance: "500" },
        { token: b(0xb2), decimals: 18, symbol: null, name: null, locked: "0", released: "0", locks: "0", releases: "0", vault_balance: null },
      ];
    }
    if (sql.includes("from gateway_tokens")) {
      return [{ evm_token: b(0xd1), instrument_admin: "registry::1220ff", instrument_id: "TKB", custody: "1230000000000", holdings: 3, supply: "123000000", supply_block: "7", ledger_offset: "77", read_at: "2026-10-25T10:00:00Z", symbol: "wTKB", name: "Wrapped TKB", decimals: 6 }];
    }
    if (sql.includes("from (select * from twin_legs")) {
      expect(values).toEqual([TWIN_LEGS_MAX]);
      return [
        { block_number: "9", leg_index: 0, leg_id: b(0xe1, 32), token: b(0xb1), amount: "100", hash: b(0xf1, 32), update_id: "1220aa", symbol: "TKA", is_lock: true, is_release: false },
        { block_number: "8", leg_index: 2, leg_id: b(0xe2, 32), token: b(0xb1), amount: "40", hash: null, update_id: "1220bb", symbol: "TKA", is_lock: false, is_release: true },
      ];
    }
    throw new Error("unexpected query: " + sql.slice(0, 60));
  };
  const rest = createTwinsRest(async (sql, values = []) => rows(sql, values));

  it("lists the vaults, the pinned twins with their sums, the Canton tokens with their custody and the newest legs", async () => {
    expect(await rest.overview()).toEqual({
      through: 7,
      vaults: [{ address: hexOf(0xc1), codeHash: hexOf(1, 32) }],
      twins: [
        { token: hexOf(0xb1), symbol: "TKA", name: "Token A", decimals: 6, supply: "500", vaultBalance: "500", matched: true, locks: 3, releases: 1, through: 7 },
        { token: hexOf(0xb2), symbol: null, name: null, decimals: 18, supply: "0", vaultBalance: null, matched: false, locks: 0, releases: 0, through: 7 },
      ],
      canton: [{
        token: hexOf(0xd1), symbol: "wTKB", name: "Wrapped TKB", decimals: 6, instrumentAdmin: "registry::1220ff", instrumentId: "TKB", custody: "1230000000000", custodyDecimals: 10, holdings: 3,
        supply: "123000000", supplyBlock: 7, matched: true, ledgerOffset: 77, readAt: "2026-10-25T10:00:00.000Z",
      }],
      legs: [
        { block: 9, txHash: hexOf(0xf1, 32), legId: hexOf(0xe1, 32), twin: "lock", token: hexOf(0xb1), symbol: "TKA", amount: "100", updateId: "1220aa" },
        { block: 8, txHash: null, legId: hexOf(0xe2, 32), twin: "release", token: hexOf(0xb1), symbol: "TKA", amount: "40", updateId: "1220bb" },
      ],
    });
  });

  it("answers an empty registry with empty lists and no block", async () => {
    const empty = createTwinsRest(async (sql) => (sql.includes("from meta") ? [] : []));
    expect(await empty.overview()).toEqual({ through: null, vaults: [], twins: [], canton: [], legs: [] });
  });
});
