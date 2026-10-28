import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_ENDPOINTS, createLedger, CUSTODY_ENDPOINTS, READER_ENDPOINTS, GATEWAY_TOKEN_TEMPLATE, HOLDING_INTERFACE, LedgerError } from "./ledger.ts";
import { FAKE_GATEWAY, FAKE_READER, FAKE_REGISTRY, gatewayToken, holding, startFakeLedger, type ActiveContract, type FakeLedger } from "../test/fake-ledger.ts";

const TKB = "0x" + "d1".repeat(20), OTHER = "0x" + "d2".repeat(20);
const SOMEONE = "alice::1220" + "ab".repeat(32);
let fake: FakeLedger | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });

async function ledger(active: ActiveContract[], opts: { cap?: number } = {}, tokenFile: string | null = null) {
  fake = await startFakeLedger([], { ledgerEnd: 99, ...opts, active });
  return createLedger(fake.url, 2000, FAKE_GATEWAY, 100, tokenFile, CUSTODY_ENDPOINTS);
}

describe("the gateway's custody, read as the gateway", () => {
  it("is a client of its own with two calls, and the reader's client cannot make the contracts one", async () => {
    expect([...CUSTODY_ENDPOINTS]).toEqual(["POST /v2/state/active-contracts", "POST /v2/updates"]);
    expect([...READER_ENDPOINTS]).toEqual(["GET /v2/state/ledger-end", "POST /v2/updates", "GET /v2/parties/participant-id"]);
    expect([...ALLOWED_ENDPOINTS].sort()).toEqual([...new Set([...READER_ENDPOINTS, ...CUSTODY_ENDPOINTS])].sort());
    fake = await startFakeLedger([], { active: [] });
    // Each client reads with the rights of its own party only: the reader's refuses the contracts, the custody client refuses the ledger end and the participant's id.
    await expect(createLedger(fake.url, 2000, FAKE_READER).gatewayCustody(5, 1)).rejects.toThrow(/not on the list/);
    const custody = createLedger(fake.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS);
    await expect(custody.ledgerEnd()).rejects.toThrow(/not on the list/);
    await expect(custody.participantId()).rejects.toThrow(/not on the list/);
    // The updates call is shared, but the gateway's client never reads the block records with it.
    await expect(custody.records(0, 5)).rejects.toThrow(/not the gateway's/);
    expect(fake.requests).toEqual([]);
  });

  it("asks for the gateway party's GatewayToken contracts and Holding views only, at the offset it is given and with one call", async () => {
    const l = await ledger([gatewayToken(TKB)]);
    await l.gatewayCustody(500, 12);
    expect(fake!.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /v2/state/active-contracts"]);
    const r = fake!.requests[0]!;
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
    expect(await l.gatewayCustody(500, 12)).toEqual({ offset: 12, tokens: [] });
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
    const got = await l.gatewayCustody(500, 12);
    expect(got.offset).toBe(12);
    expect(got.tokens).toEqual([
      { evmToken: TKB, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKB", custody: 1070000000001n, holdings: 3 },
      { evmToken: OTHER, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKC", custody: 25000000000n, holdings: 1 },
    ]);
  });

  it("says zero for a registered token with no holdings, and takes the token's address in any case, with or without 0x", async () => {
    const l = await ledger([gatewayToken(TKB.slice(2).toUpperCase())]);
    expect((await l.gatewayCustody(500, 12)).tokens).toEqual([{ evmToken: TKB, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKB", custody: 0n, holdings: 0 }]);
  });

  it("keeps no owner, no contract id and no party but the instrument's admin", async () => {
    const l = await ledger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1"), holding(5, SOMEONE, "999")]);
    const text = JSON.stringify(await l.gatewayCustody(500, 12), (_, v) => (typeof v === "bigint" ? v.toString() : v));
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
      await expect((await ledger(active)).gatewayCustody(500, 12), why).rejects.toThrow(why === "registered twice" ? /twice/ : /custody|Canton sent/);
    }
  });

  it("refuses a list as long as its limit, which may be cut short, rather than show a total of part of the holdings", async () => {
    const l = await ledger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1"), holding(2, FAKE_GATEWAY, "1")]);
    await expect(l.gatewayCustody(3, 12)).rejects.toThrow(/limit/);
    expect((await l.gatewayCustody(4, 12)).tokens[0]!.custody).toBe(20000000000n);
  });

  it("refuses a list that the participant's own maximum cut short, which is why the limit asked must not be above that maximum", async () => {
    const active = [gatewayToken(TKB), ...[1, 2, 3, 4, 5].map((n) => holding(n, FAKE_GATEWAY, "1"))];
    // The participant's maximum is 3. Asked for exactly that, it sends a list as long as the limit, and that is refused, not summed into a custody that is too small.
    const capped = await ledger(active, { cap: 3 });
    await expect(capped.gatewayCustody(3, 12)).rejects.toThrow(/cut short/);
    // With room above the number of contracts, under the maximum, the whole list comes and is summed.
    const roomy = await ledger(active, { cap: 10 });
    expect((await roomy.gatewayCustody(7, 12)).tokens[0]!.custody).toBe(50000000000n);
  });

  it("counts a holding only where the instrument's admin signed it: a template of someone else's cannot claim the registry", async () => {
    const forged = holding(2, FAKE_GATEWAY, "900", FAKE_REGISTRY, "TKB", null, null, [SOMEONE, FAKE_GATEWAY]);
    const l = await ledger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1"), forged]);
    expect(await l.gatewayCustody(500, 12)).toMatchObject({ tokens: [{ custody: 10000000000n, holdings: 1 }] });
  });

  it("fails as a LedgerError when Canton does not answer, and says nothing of a token", async () => {
    fake = await startFakeLedger([], { httpStatus: 500, active: [] });
    const l = createLedger(fake.url, 2000, FAKE_GATEWAY);
    await expect(l.gatewayCustody(500, 12)).rejects.toBeInstanceOf(LedgerError);
  });

  describe("with a token file of its own", () => {
    const SECRET = "tok." + randomBytes(24).toString("hex");
    it("sends that token on its call", async () => {
      const dir = mkdtempSync(join(tmpdir(), "custody-token-")), file = join(dir, "token");
      try {
        writeFileSync(file, SECRET + "\n", { mode: 0o600 }); chmodSync(file, 0o600);
        await (await ledger([gatewayToken(TKB)], {}, file)).gatewayCustody(500, 12);
        expect(fake!.requests.map((r) => r.authorization)).toEqual([`Bearer ${SECRET}`]);
      } finally { rmSync(file, { force: true }); rmSync(dir, { recursive: true, force: true }); }   // the one file and the one folder this test made
    });
  });
});
