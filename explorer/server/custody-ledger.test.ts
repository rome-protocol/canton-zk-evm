import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_ENDPOINTS, createLedger, GATEWAY_TOKEN_TEMPLATE, HOLDING_INTERFACE, LedgerError } from "./ledger.ts";
import { FAKE_GATEWAY, FAKE_READER, FAKE_REGISTRY, gatewayToken, holding, startFakeLedger, type ActiveContract, type FakeLedger } from "../test/fake-ledger.ts";

const TKB = "0x" + "d1".repeat(20), OTHER = "0x" + "d2".repeat(20);
const SOMEONE = "alice::1220" + "ab".repeat(32);
let fake: FakeLedger | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });

async function ledger(active: ActiveContract[], opts: { ledgerEnd?: number } = {}, tokenFile: string | null = null) {
  fake = await startFakeLedger([], { ledgerEnd: 12, ...opts, active });
  return createLedger(fake.url, 2000, FAKE_GATEWAY, 100, tokenFile);
}

describe("the gateway's custody, read as the gateway", () => {
  it("is one more call than the reader makes, and the only one that asks for contracts", () => {
    expect([...ALLOWED_ENDPOINTS]).toEqual(["GET /v2/state/ledger-end", "POST /v2/updates", "GET /v2/parties/participant-id", "POST /v2/state/active-contracts"]);
  });

  it("asks for the gateway party's GatewayToken contracts and Holding views only, at the ledger end it read first", async () => {
    const l = await ledger([gatewayToken(TKB)]);
    await l.gatewayCustody(500);
    expect(fake!.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v2/state/ledger-end", "POST /v2/state/active-contracts"]);
    const r = fake!.requests[1]!;
    expect(r.query.get("limit")).toBe("500");
    expect(r.body).toEqual({
      eventFormat: { filtersByParty: { [FAKE_GATEWAY]: { cumulative: [
        { identifierFilter: { TemplateFilter: { value: { templateId: GATEWAY_TOKEN_TEMPLATE, includeCreatedEventBlob: false } } } },
        { identifierFilter: { InterfaceFilter: { value: { interfaceId: HOLDING_INTERFACE, includeInterfaceView: true, includeCreatedEventBlob: false } } } },
      ] } }, verbose: false },
      activeAtOffset: 12,
    });
    expect(JSON.stringify(r.body)).not.toContain(FAKE_READER);
  });

  it("is empty when the gateway registered no token", async () => {
    const l = await ledger([holding(1, FAKE_GATEWAY, "5.0")]);
    expect(await l.gatewayCustody(500)).toEqual({ offset: 12, tokens: [] });
  });

  it("adds up what the gateway holds of each registered instrument, in base units of 10 decimals, locked holdings included", async () => {
    const l = await ledger([
      gatewayToken(TKB), gatewayToken(OTHER, FAKE_REGISTRY, "TKC"),
      holding(1, FAKE_GATEWAY, "100.0000000000"), holding(2, FAKE_GATEWAY, "0.0000000001"), holding(3, FAKE_GATEWAY, "7", FAKE_REGISTRY, "TKB", { holders: [FAKE_GATEWAY], expiresAt: null }),
      holding(4, FAKE_GATEWAY, "2.5", FAKE_REGISTRY, "TKC"),
      holding(5, SOMEONE, "999"),                                   // someone else's, which the gateway can see: not custody
      holding(6, FAKE_GATEWAY, "50", "another-admin::1220" + "cc".repeat(32), "TKB"), // another registry's TKB: not this instrument
      holding(7, FAKE_GATEWAY, "3", FAKE_REGISTRY, "NOT-REGISTERED"),
    ]);
    const got = await l.gatewayCustody(500);
    expect(got.offset).toBe(12);
    expect(got.tokens).toEqual([
      { evmToken: TKB, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKB", custody: 1070000000001n, holdings: 3 },
      { evmToken: OTHER, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKC", custody: 25000000000n, holdings: 1 },
    ]);
  });

  it("says zero for a registered token with no holdings, and takes the token's address in any case, with or without 0x", async () => {
    const l = await ledger([gatewayToken(TKB.slice(2).toUpperCase())]);
    expect((await l.gatewayCustody(500)).tokens).toEqual([{ evmToken: TKB, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKB", custody: 0n, holdings: 0 }]);
  });

  it("keeps no owner, no contract id and no party but the instrument's admin", async () => {
    const l = await ledger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1"), holding(5, SOMEONE, "999")]);
    const text = JSON.stringify(await l.gatewayCustody(500), (_, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const secret of [FAKE_GATEWAY, SOMEONE, "00000001", "00000005"]) expect(text).not.toContain(secret);
  });

  it("refuses a total it cannot stand behind: a holding with no readable view, an amount that is not a decimal, a token it cannot read", async () => {
    const bad: [string, ActiveContract[]][] = [
      ["no readable view", [gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1", FAKE_REGISTRY, "TKB", null, "unreadable")]],
      ["is not a decimal", [gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1e3")]],
      ["is not a decimal", [gatewayToken(TKB), holding(1, FAKE_GATEWAY, "-1")]],
      ["is not a decimal", [gatewayToken(TKB), holding(1, FAKE_GATEWAY, "0.00000000001")]],
      ["is not an address", [gatewayToken("0x1234")]],
      ["has no instrument", [gatewayToken(TKB, FAKE_REGISTRY, "", {})]],
      ["has no instrument", [gatewayToken(TKB, FAKE_REGISTRY, "TKB", { instrumentId: null })]],
      ["registered twice", [gatewayToken(TKB), gatewayToken(TKB, FAKE_REGISTRY, "TKC")]],
      ["registered twice", [gatewayToken(TKB), gatewayToken(OTHER)]],   // one instrument for two tokens would be counted as backing both
    ];
    for (const [why, active] of bad) {
      await fake?.close();
      await expect((await ledger(active)).gatewayCustody(500), why).rejects.toThrow(why === "registered twice" ? /twice/ : /custody|Canton sent/);
    }
  });

  it("refuses a list as long as its limit, which may be cut short, rather than show a total of part of the holdings", async () => {
    const l = await ledger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1"), holding(2, FAKE_GATEWAY, "1")]);
    await expect(l.gatewayCustody(3)).rejects.toThrow(/limit/);
    expect((await l.gatewayCustody(4)).tokens[0]!.custody).toBe(20000000000n);
  });

  it("fails as a LedgerError when Canton does not answer, and says nothing of a token", async () => {
    fake = await startFakeLedger([], { httpStatus: 500, active: [] });
    const l = createLedger(fake.url, 2000, FAKE_GATEWAY);
    await expect(l.gatewayCustody(500)).rejects.toBeInstanceOf(LedgerError);
  });

  describe("with a token file of its own", () => {
    const SECRET = "tok." + randomBytes(24).toString("hex");
    it("sends that token on both calls", async () => {
      const dir = mkdtempSync(join(tmpdir(), "custody-token-")), file = join(dir, "token");
      try {
        writeFileSync(file, SECRET + "\n", { mode: 0o600 }); chmodSync(file, 0o600);
        await (await ledger([gatewayToken(TKB)], {}, file)).gatewayCustody(500);
        expect(fake!.requests.map((r) => r.authorization)).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
      } finally { rmSync(file, { force: true }); rmSync(dir, { recursive: true, force: true }); }   // the one file and the one folder this test made
    });
  });
});
