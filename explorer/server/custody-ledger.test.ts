import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_ENDPOINTS, createLedger, CUSTODY_ENDPOINTS, READER_ENDPOINTS, GATEWAY_TOKEN_TEMPLATE, HOLDING_INTERFACE, LedgerError, type Ledger } from "./ledger.ts";
import { FAKE_GATEWAY, FAKE_READER, FAKE_REGISTRY, archivedEvent, gatewayToken, holding, holdingEvent, startFakeLedger, transaction, type ActiveContract, type FakeLedger } from "../test/fake-ledger.ts";

const TKB = "0x" + "d1".repeat(20), OTHER = "0x" + "d2".repeat(20);
const SOMEONE = "alice::1220" + "ab".repeat(32);
let fake: FakeLedger | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });

async function ledger(active: ActiveContract[], opts: { cap?: number } = {}, tokenFile: string | null = null) {
  fake = await startFakeLedger([], { ledgerEnd: 99, ...opts, active });
  return createLedger(fake.url, 2000, FAKE_GATEWAY, 100, tokenFile, CUSTODY_ENDPOINTS);
}


/** The custody as the indexer keeps it: the registered tokens at `offset`, and the holdings by the walk of the updates up to it, added up per instrument. */
async function read(l: Ledger, limit: number, offset: number) {
  const tokens = await l.gatewayTokens(limit, offset);
  const held = new Map<string, { admin: string; id: string; amount: bigint }>();
  for await (const page of l.holdingPages(0, offset)) {
    for (const c of page.changes) { if (c.kind === "archived") held.delete(c.contractId); else held.set(c.contractId, { admin: c.instrumentAdmin, id: c.instrumentId, amount: c.amount }); }
  }
  return { offset, tokens: tokens.map((t) => {
    const mine = [...held.values()].filter((h) => h.admin === t.instrumentAdmin && h.id === t.instrumentId);
    return { ...t, custody: mine.reduce((n, h) => n + h.amount, 0n), holdings: mine.length };
  }) };
}

describe("the gateway's custody, read as the gateway", () => {
  it("is a client of its own with two calls, and the reader's client cannot make the contracts one", async () => {
    expect([...CUSTODY_ENDPOINTS]).toEqual(["POST /v2/state/active-contracts", "POST /v2/updates"]);
    expect([...READER_ENDPOINTS]).toEqual(["GET /v2/state/ledger-end", "POST /v2/updates", "GET /v2/parties/participant-id"]);
    expect([...ALLOWED_ENDPOINTS].sort()).toEqual([...new Set([...READER_ENDPOINTS, ...CUSTODY_ENDPOINTS])].sort());
    fake = await startFakeLedger([], { active: [] });
    // Each client reads with the rights of its own party only: the reader's refuses the contracts, the custody client refuses the ledger end and the participant's id.
    await expect(createLedger(fake.url, 2000, FAKE_READER).gatewayTokens(5, 1)).rejects.toThrow(/not on the list/);
    const custody = createLedger(fake.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS);
    await expect(custody.ledgerEnd()).rejects.toThrow(/not on the list/);
    await expect(custody.participantId()).rejects.toThrow(/not on the list/);
    // The updates call is shared, but the gateway's client never reads the block records with it.
    await expect(custody.records(0, 5)).rejects.toThrow(/not the gateway's/);
    expect(fake.requests).toEqual([]);
  });

  it("asks for the gateway party's GatewayToken contracts in one call, and for the Holding views in the ACS delta of the updates, at the offsets it is given", async () => {
    const l = await ledger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1")]);
    await read(l, 500, 12);
    expect(fake!.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /v2/state/active-contracts", "POST /v2/updates", "POST /v2/updates"]);
    const [tokens, walk] = fake!.requests;
    expect(tokens!.query.get("limit")).toBe("500");
    expect(tokens!.body).toEqual({
      eventFormat: { filtersByParty: { [FAKE_GATEWAY]: { cumulative: [
        { identifierFilter: { TemplateFilter: { value: { templateId: GATEWAY_TOKEN_TEMPLATE, includeCreatedEventBlob: false } } } },
      ] } }, verbose: false },
      activeAtOffset: 12,
    });
    expect(walk!.query.get("limit")).toBe("100");
    expect(walk!.body).toEqual({
      beginExclusive: 0, endInclusive: 12,
      updateFormat: { includeTransactions: { eventFormat: { filtersByParty: { [FAKE_GATEWAY]: { cumulative: [
        { identifierFilter: { InterfaceFilter: { value: { interfaceId: HOLDING_INTERFACE, includeInterfaceView: true, includeCreatedEventBlob: false } } } },
      ] } }, verbose: false }, transactionShape: "TRANSACTION_SHAPE_ACS_DELTA" } },
    });
    expect(JSON.stringify([tokens!.body, walk!.body])).not.toContain(FAKE_READER);
  });

  it("is empty when the gateway registered no token", async () => {
    const l = await ledger([holding(1, FAKE_GATEWAY, "5.0")]);
    expect(await read(l, 500, 12)).toEqual({ offset: 12, tokens: [] });
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
    const got = await read(l, 500, 12);
    expect(got.offset).toBe(12);
    expect(got.tokens).toEqual([
      { evmToken: TKB, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKB", custody: 1070000000001n, holdings: 3 },
      { evmToken: OTHER, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKC", custody: 25000000000n, holdings: 1 },
    ]);
  });

  it("says zero for a registered token with no holdings, and takes the token's address in any case, with or without 0x", async () => {
    const l = await ledger([gatewayToken(TKB.slice(2).toUpperCase())]);
    expect((await read(l, 500, 12)).tokens).toEqual([{ evmToken: TKB, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKB", custody: 0n, holdings: 0 }]);
  });

  it("keeps no owner, no contract id and no party but the instrument's admin", async () => {
    const l = await ledger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1"), holding(5, SOMEONE, "999")]);
    const text = JSON.stringify(await read(l, 500, 12), (_, v) => (typeof v === "bigint" ? v.toString() : v));
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
      await expect(read((await ledger(active)), 500, 12), why).rejects.toThrow(why === "registered twice" ? /twice/ : /custody|Canton sent/);
    }
  });

  it("refuses a list of tokens as long as its limit, which may be cut short, rather than show part of the registry", async () => {
    const l = await ledger([gatewayToken(TKB), gatewayToken(OTHER, FAKE_REGISTRY, "TKC")]);
    await expect(l.gatewayTokens(2, 12)).rejects.toThrow(/limit/);
    expect(await l.gatewayTokens(3, 12)).toHaveLength(2);
  });

  it("refuses a list of tokens that the participant's own maximum cut short, which is why the limit asked must not be above that maximum", async () => {
    const active = [gatewayToken(TKB), gatewayToken(OTHER, FAKE_REGISTRY, "TKC"), gatewayToken("0x" + "d3".repeat(20), FAKE_REGISTRY, "TKD"), gatewayToken("0x" + "d4".repeat(20), FAKE_REGISTRY, "TKE")];
    const capped = await ledger(active, { cap: 3 });
    await expect(capped.gatewayTokens(3, 12)).rejects.toThrow(/cut short/);
    const roomy = await ledger(active, { cap: 10 });
    expect(await roomy.gatewayTokens(7, 12)).toHaveLength(4);
  });

  it("reads any number of holdings, by pages, whatever the list maximum: the twin holdings of every user cannot cut or fail it", async () => {
    const twins = Array.from({ length: 500 }, (_, i) => holding(1000 + i, SOMEONE, "1", FAKE_GATEWAY, "TWIN"));
    const mine = [1, 2, 3].map((n) => holding(n, FAKE_GATEWAY, "1"));
    const l = await ledger([gatewayToken(TKB), ...mine, ...twins], { cap: 4 });
    const got = await read(l, 3, 12);
    expect(got.tokens).toEqual([{ evmToken: TKB, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKB", custody: 30000000000n, holdings: 3 }]);
  });

  it("walks the updates in pages, and a holding that was archived is gone from the total", async () => {
    fake = await startFakeLedger([
      transaction(3, "u3", [holdingEvent(holding(1, FAKE_GATEWAY, "5"))]), transaction(5, "u5", [holdingEvent(holding(2, FAKE_GATEWAY, "7"))]),
      transaction(8, "u8", [archivedEvent(holding(1, FAKE_GATEWAY, "5").contractId)]),
    ], { ledgerEnd: 99, active: [gatewayToken(TKB)] });
    const l = createLedger(fake.url, 2000, FAKE_GATEWAY, 1, null, CUSTODY_ENDPOINTS);
    const pages: number[] = [];
    for await (const p of l.holdingPages(0, 10)) pages.push(p.offset);
    expect(pages).toEqual([3, 5, 8]);
    expect((await read(l, 500, 10)).tokens[0]).toMatchObject({ custody: 70000000000n, holdings: 1 });
    // The walk starts after the offset it is given and ends at the one it is told.
    const part: number[] = [];
    for await (const p of l.holdingPages(3, 5)) part.push(p.offset);
    expect(part).toEqual([5]);
  });

  it("counts a holding only where the instrument's admin signed it: a template of someone else's cannot claim the registry", async () => {
    const forged = holding(2, FAKE_GATEWAY, "900", FAKE_REGISTRY, "TKB", null, null, [SOMEONE, FAKE_GATEWAY]);
    const l = await ledger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1"), forged]);
    expect(await read(l, 500, 12)).toMatchObject({ tokens: [{ custody: 10000000000n, holdings: 1 }] });
  });

  it("fails as a LedgerError when Canton does not answer, and says nothing of a token", async () => {
    fake = await startFakeLedger([], { httpStatus: 500, active: [] });
    const l = createLedger(fake.url, 2000, FAKE_GATEWAY);
    await expect(read(l, 500, 12)).rejects.toBeInstanceOf(LedgerError);
  });

  describe("with a token file of its own", () => {
    const SECRET = "tok." + randomBytes(24).toString("hex");
    it("sends that token on its call", async () => {
      const dir = mkdtempSync(join(tmpdir(), "custody-token-")), file = join(dir, "token");
      try {
        writeFileSync(file, SECRET + "\n", { mode: 0o600 }); chmodSync(file, 0o600);
        await read((await ledger([gatewayToken(TKB)], {}, file)), 500, 12);
        expect(fake!.requests.map((r) => r.authorization)).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
      } finally { rmSync(file, { force: true }); rmSync(dir, { recursive: true, force: true }); }   // the one file and the one folder this test made
    });
  });
});
