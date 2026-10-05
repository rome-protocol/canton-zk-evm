import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED_ENDPOINTS, BLOCK_RECORD_TEMPLATE, createLedger, LedgerError } from "./ledger.ts";
import {
  checkpoint, createdEvent, FAKE_CONFIRMER, FAKE_OPERATOR, FAKE_READER, RECORD_ID, recordFields, startFakeLedger, transaction, type FakeLedger,
} from "../test/fake-ledger.ts";

let fake: FakeLedger | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });
const ledger = async (items: ReturnType<typeof transaction>[], opts: Parameters<typeof startFakeLedger>[1] = {}, party: string | null = FAKE_READER, pageSize?: number) => {
  fake = await startFakeLedger(items, opts);
  return createLedger(fake.url, 2000, party, pageSize);
};

describe("the ledger end", () => {
  it("reads the offset, and takes a ledger with no offset to be empty", async () => {
    const l = await ledger([], { ledgerEnd: 41 });
    expect(await l.ledgerEnd()).toBe(41);
    expect(await (await ledger([])).ledgerEnd()).toBe(0);
  });
});

describe("block records", () => {
  it("reads every field of a record, with its update id and record time, and the hashes as 0x", async () => {
    const l = await ledger([transaction(7, "1220" + "19".repeat(32), [createdEvent(7)], "2026-10-04T01:37:15.412Z")]);
    expect(await l.records(0, 7)).toEqual([{
      updateId: "1220" + "19".repeat(32), offset: 7, recordTime: "2026-10-04T01:37:15.412Z", chainId: 770101, number: 3,
      blockHash: "0x" + "35".repeat(32), parentHash: "0x" + "0b".repeat(32),
      headerHex: "f9".repeat(40), txsHex: "02".repeat(20), proofHex: "ee".repeat(1344), operator: FAKE_OPERATOR, confirmer: FAKE_CONFIRMER,
    }]);
  });

  it("keeps a block with no transactions, with its txsHex as the empty string the record holds", async () => {
    const l = await ledger([transaction(7, "u1", [createdEvent(7, recordFields({ txsHex: "" }))])]);
    const got = await l.records(0, 7);
    expect(got).toHaveLength(1);
    expect(got[0]!.txsHex).toBe("");
    await expect((await ledger([transaction(7, "u1", [createdEvent(7, recordFields({ txsHex: "0" }))])])).records(0, 7)).rejects.toThrow(/txsHex/);
  });

  it("asks only for the reader party and the block record template, as the ACS delta, up to the ledger end it was given", async () => {
    const l = await ledger([transaction(7, "u1", [createdEvent(7)])]);
    await l.records(4, 9);
    expect(fake!.requests).toHaveLength(2); // the second, from offset 7, comes back empty and ends the walk
    expect(fake!.requests.map((r) => r.body?.beginExclusive)).toEqual([4, 7]);
    const { method, path, body } = fake!.requests[0]!;
    expect([method, path]).toEqual(["POST", "/v2/updates"]);
    expect(body).toEqual({
      beginExclusive: 4, endInclusive: 9,
      updateFormat: { includeTransactions: {
        eventFormat: { filtersByParty: { [FAKE_READER]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: BLOCK_RECORD_TEMPLATE, includeCreatedEventBlob: false } } } }] } }, verbose: false },
        transactionShape: "TRANSACTION_SHAPE_ACS_DELTA",
      } },
    });
  });

  it("calls only the ledger end and the updates, and refuses any other endpoint before it makes a call", async () => {
    const l = await ledger([transaction(7, "u1", [createdEvent(7)])]);
    await l.ledgerEnd();
    await l.records(0, 7);
    expect(fake!.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v2/state/ledger-end", "POST /v2/updates"]);
    expect([...ALLOWED_ENDPOINTS]).toEqual(["GET /v2/state/ledger-end", "POST /v2/updates"]);
    for (const [m, p] of [["POST", "/v2/commands/submit-and-wait"], ["POST", "/v2/state/active-contracts"], ["GET", "/v2/updates"], ["POST", "/v2/updates/update-by-offset"]] as const) {
      await expect(l.call(m, p)).rejects.toThrow(/not on the list/);
    }
    expect(fake!.requests).toHaveLength(2);
  });

  it("follows the pages of an answer, in offset order, and skips checkpoints", async () => {
    const items = [1, 2, 3, 4, 5].map((n) => transaction(n * 2, `u${n}`, [createdEvent(n * 2, recordFields({ number: String(n) }))]));
    const l = await ledger([...items.slice(0, 2), checkpoint(5), ...items.slice(2)], {}, FAKE_READER, 2);
    const got = await l.records(0, 10);
    expect(got.map((r) => r.number)).toEqual([1, 2, 3, 4, 5]);
    expect(fake!.requests.map((r) => r.body?.beginExclusive)).toEqual([0, 4, 6]);
    expect(fake!.requests.every((r) => r.query.get("limit") === "2")).toBe(true);
  });

  it("keeps going when a page is shorter than the limit but records remain, as when Canton caps the limit below ours", async () => {
    const items = [1, 2, 3, 4, 5].map((n) => transaction(n, `u${n}`, [createdEvent(n, recordFields({ number: String(n) }))]));
    const l = await ledger(items, { cap: 2 }, FAKE_READER, 100);
    expect((await l.records(0, 5)).map((r) => r.number)).toEqual([1, 2, 3, 4, 5]);
    expect(fake!.requests.map((r) => r.body?.beginExclusive)).toEqual([0, 2, 4]);
  });

  it("stops at an empty answer, even when the ledger end is further on", async () => {
    const l = await ledger([transaction(2, "u1", [createdEvent(2)])]);
    expect(await l.records(0, 9)).toHaveLength(1);
    expect(fake!.requests.map((r) => r.body?.beginExclusive)).toEqual([0, 2]);
  });

  it("asks for nothing when there is nothing new", async () => {
    const l = await ledger([]);
    expect(await l.records(9, 9)).toEqual([]);
    expect(fake!.requests).toHaveLength(0);
  });

  it("keeps nothing but the block record: other contracts and archived events in the same update are ignored", async () => {
    const other = createdEvent(7, { secret: "u and v's terms" }, "abc123def456:Zk.Chain:DvpTerms");
    const archived = { ArchivedEvent: { offset: 7, nodeId: 1, contractId: "00", templateId: RECORD_ID } };
    const l = await ledger([transaction(7, "u1", [other, archived as never, createdEvent(7)])]);
    const got = await l.records(0, 7);
    expect(got).toHaveLength(1);
    expect(JSON.stringify(got)).not.toContain("terms");
  });
});

describe("when Canton's answer cannot be used", () => {
  const bad = (over: Record<string, unknown>) => ledger([transaction(7, "u1", [createdEvent(7, recordFields(over))])]);

  it("names the update and the field of a record that is malformed", async () => {
    await expect((await bad({ proofHex: undefined })).records(0, 7)).rejects.toThrow(/u1.*proofHex/);
    await expect((await bad({ blockHash: "35" })).records(0, 7)).rejects.toThrow(/blockHash/);
    await expect((await bad({ headerHex: "F9" })).records(0, 7)).rejects.toThrow(/headerHex/);
    await expect((await bad({ number: "three" })).records(0, 7)).rejects.toThrow(/number/);
    await expect((await bad({ operator: "" })).records(0, 7)).rejects.toThrow(/operator/);
  });

  it("refuses a record time that is not a time", async () => {
    const l = await ledger([transaction(7, "u1", [createdEvent(7)], "yesterday")]);
    await expect(l.records(0, 7)).rejects.toThrow(/recordTime/);
  });

  it("reports an HTTP error, and a ledger that cannot be reached", async () => {
    const down = await ledger([], { httpStatus: 503 });
    await expect(down.ledgerEnd()).rejects.toThrow(/HTTP 503/);
    await fake!.close();
    await expect(down.ledgerEnd()).rejects.toThrow(LedgerError);
  });

  it("needs the reader party, and says which setting names it", async () => {
    const l = await ledger([], {}, null);
    await expect(l.records(0, 1)).rejects.toThrow(/READER_PARTY/);
    expect(fake!.requests).toHaveLength(0);
  });
});
