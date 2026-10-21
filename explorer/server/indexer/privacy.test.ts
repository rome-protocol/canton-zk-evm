/**
 * The privacy test (design sections 4.7 and 11): the explorer reads Canton as the reader party only, and stores nothing the reader cannot see.
 * Records are served by a stand-in Ledger API in the form Canton sends them, with the builder, the reader and an observer named in them, and
 * everything that follows (the indexer's write path, a reindex, an export and a rebuild) is searched for a party id that is not a signatory.
 */
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { makeDatabase, TEST_URL, checkRequired } from "../db/testing.ts";
import { createLedger } from "../ledger.ts";
import { CHAIN_ID, CONFIRMER, GATEWAY, OPERATOR, PINS, makeChain } from "../../test/synthetic-chain.ts";
import { FAKE_READER, RECORD_ID, startFakeLedger, transaction } from "../../test/fake-ledger.ts";
import { createIndexer } from "./indexer.ts";
import { exportRecordsToFile, readRecords } from "./records.ts";
import { reindexRange } from "./reindex.ts";

const BUILDER = "builder::1220" + "11".repeat(32);
const OBSERVER = "auditor::1220" + "77".repeat(32);
const SECOND_OBSERVER = "regulator::1220" + "88".repeat(32);

/** One of Canton's party ids: a hint, two colons and a fingerprint. Participant ids ("PAR::...") and synchronizer ids are not parties. */
const ID = /[A-Za-z][A-Za-z0-9_-]*::1220[0-9a-f]{64}/g;

describe.skipIf(!TEST_URL)("what the explorer keeps of Canton's privacy model", () => {
  checkRequired();

  it("stores no observer and no party id but the two signatories, in any table or in an export", async () => {
    const chain = makeChain([{ txs: 3 }, { txs: 5, leg: 1 }, { txs: 0 }]);
    // The update as the reader sees it: the record's own fields name the builder and the reader, and the event lists the observers.
    const items = chain.blocks.map(({ record: r }) => {
      const fields = {
        operator: OPERATOR, confirmer: CONFIRMER, builder: BUILDER, reader: FAKE_READER, chainId: String(CHAIN_ID), number: String(r.number),
        blockHash: r.blockHash.slice(2), parentHash: r.parentHash.slice(2), headerHex: r.headerHex, txsHex: r.txsHex, proofHex: r.proofHex,
      };
      const event = {
        CreatedEvent: {
          offset: r.offset, nodeId: 0, contractId: r.contractId, templateId: RECORD_ID, createdAt: r.recordTime, packageName: "canton-zk-evm", representativePackageId: "abc123def456",
          acsDelta: true, createArgument: fields, witnessParties: [FAKE_READER, OBSERVER, SECOND_OBSERVER], observers: [FAKE_READER, OBSERVER, SECOND_OBSERVER], signatories: [OPERATOR, CONFIRMER],
        },
      };
      return transaction(r.offset, r.updateId, [event], r.recordTime);
    });
    const ledger = await startFakeLedger(items);
    const db = await makeDatabase(true);
    const dir = mkdtempSync(join(tmpdir(), "explorer-privacy-"));
    const file = join(dir, "records.jsonl");
    const indexer = createIndexer({ pool: db.pool, reads: chain.reads, ledger: createLedger(ledger.url, 5000, FAKE_READER), pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
    try {
      await indexer.open();
      expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 3 });
      await reindexRange({ pool: db.pool, reads: chain.reads, gateway: GATEWAY }, 1, null);
      await exportRecordsToFile(db.pool, file);
      const exported = readFileSync(file, "utf8");

      const rebuilt = await makeDatabase(true);
      const second = createIndexer({ pool: rebuilt.pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
      try {
        await second.open();
        expect(await second.rebuild(readRecords(file))).toBe(3);
        for (const [what, text, pool] of [["the indexed database", await dump(db.pool), db.pool], ["the rebuilt database", await dump(rebuilt.pool), rebuilt.pool], ["the export", exported, null]] as const) {
          expect(forbiddenIn(text), `${what} holds a party that is not a signatory`).toEqual([]);
          expect(partiesIn(text, pool ? await ownIds(pool) : new Set<string>()).sort(), `${what}: the party ids it holds`).toEqual([CONFIRMER, OPERATOR].sort());
        }
        // The two signatories are the only parties, with their roles; nothing else was written for the others.
        for (const p of [db.pool, rebuilt.pool]) {
          expect((await p.query("select party, role from canton_parties order by role")).rows).toEqual([{ party: CONFIRMER, role: "confirmer" }, { party: OPERATOR, role: "operator" }]);
        }
      } finally {
        await second.close().catch(() => undefined);
        await rebuilt.drop();
      }
    } finally {
      await indexer.close().catch(() => undefined);
      await db.drop();
      await ledger.close();
      rmSync(file, { force: true });
      rmdirSync(dir);
    }
  }, 60_000);

  it("would see a leak: the search finds an observer kept as text, and one kept as bytes", async () => {
    const db = await makeDatabase(true);
    try {
      expect(forbiddenIn(await dump(db.pool))).toEqual([]);
      await db.pool.query("insert into meta (key, value) values ('leak', $1)", [OBSERVER]);
      await db.pool.query("insert into bytecodes (code_hash, code, size) values ($1, $2, 1)", [Buffer.alloc(32), Buffer.from(SECOND_OBSERVER)]);
      expect(forbiddenIn(await dump(db.pool))).toEqual([OBSERVER, SECOND_OBSERVER]);
      expect(partiesIn(await dump(db.pool), new Set())).toEqual([OBSERVER]); // the text one shows as a party id; the one in bytes is for the hex search
    } finally {
      await db.drop();
    }
  });
});

/** The ids that must never be stored, as written and as bytes (a bytea shows as hex in a row's text). */
function forbiddenIn(text: string): string[] {
  return [FAKE_READER, BUILDER, OBSERVER, SECOND_OBSERVER].filter((id) => text.includes(id) || text.includes(Buffer.from(id).toString("hex")));
}

/** The party ids in a text, but for the participant's and the synchronizers' ids, which the explorer keeps by design. */
function partiesIn(text: string, own: Set<string>): string[] {
  return [...new Set((text.match(ID) ?? []).filter((id) => !own.has(id) && !id.startsWith("sync::") && !id.endsWith(`::1220${"aa".repeat(32)}`)))];
}

/** Participant and synchronizer ids, which are not parties, as the database names them. */
async function ownIds(pool: Pool): Promise<Set<string>> {
  const r = await pool.query("select participant_id as id from canton_participants union select synchronizer_id from canton_synchronizers");
  return new Set(r.rows.map((x) => x.id as string));
}

/** Every row of every table of the schema, as text: the search is over what is stored, not over what a query happens to select. */
async function dump(pool: Pool): Promise<string> {
  const tables = (await pool.query("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1")).rows;
  const out: string[] = [];
  for (const { relname } of tables) {
    const rows = await pool.query(`select x::text as t from "${relname as string}" x`);
    for (const row of rows.rows) out.push(`${relname as string}: ${row.t as string}`);
  }
  return out.join("\n");
}
