/**
 * The record export (design section 4.4): every stored block record, with its proof and the Canton facts the explorer keeps about it, as one
 * line of JSON each, behind a header line. `explorer reindex --records <file>` builds a fresh database from it, so Canton's pruning matters
 * only for a database that starts from nothing and has no export.
 *
 * A line holds what the indexer read from Canton and nothing else: the record (header, transactions, proof, hashes, the two signatories), the
 * update's id, record time, effective time, synchronizer and template, and the participant the offset belongs to. No observer and no party but
 * the two signatories is ever in a database, so none is in a file.
 *
 * The history of reader moves (`reader-moved`: an old participant's last offset and moved-out time, the `reader_move_N` rows of `meta`) is not in a
 * file, so a database built from one has no such trail: the participants it met read as they first were. The indexer carries on correctly without it.
 */
import { createReadStream, createWriteStream, existsSync, renameSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Pool } from "pg";
import type { BlockRecord } from "../ledger.ts";

export const RECORDS_FORMAT = "ostia-explorer-records";

export interface RecordsHeader { format: typeof RECORDS_FORMAT; version: 1; chainId: number; genesisHash: string }
/** A record, with the participant its offset belongs to and where the indexer began reading that participant. */
export interface ExportedRecord extends BlockRecord { participant: { id: string; firstOffset: number | null } }

const PAGE = 500;
const TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** A dictionary lookup that must find its row: a line with a hole in it must never reach a file that looks finished. */
function need<T>(map: Map<number, T>, id: unknown, what: string, block: number): T {
  const v = map.get(Number(id));
  if (v === undefined) throw new Error(`block ${block}: its ${what} (id ${String(id)}) is not in the database's ${what} list: the export is stopped`);
  return v;
}

/**
 * Writes the header and then every record in block order, calling `write` with each line. Reads a page at a time, so memory stays at one page.
 * The whole export is read in one repeatable-read, read-only transaction, so the dictionaries and every page are one snapshot of the database
 * while the indexer goes on writing. Returns the number of records.
 */
export async function exportRecords(pool: Pool, write: (line: string) => Promise<void>, options: { pageSize?: number } = {}): Promise<number> {
  const size = options.pageSize ?? PAGE;
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query("begin isolation level repeatable read read only");
    const meta = new Map((await c.query("select key, value from meta")).rows.map((r) => [r.key as string, r.value as string]));
    if (!meta.has("chain_id") || !meta.has("genesis_hash")) throw new Error("this database holds no chain yet: there is nothing to export");
    const header: RecordsHeader = { format: RECORDS_FORMAT, version: 1, chainId: Number(meta.get("chain_id")), genesisHash: meta.get("genesis_hash") as string };
    await write(JSON.stringify(header));
    const partyRows = (await c.query("select id, party, role from canton_parties")).rows;
    const parties = new Map<number, string>(partyRows.map((r) => [Number(r.id), r.party as string]));
    const roles = new Map<string, string>(partyRows.map((r) => [r.role as string, r.party as string]));
    const templates = new Map((await c.query("select id, package_id, module, entity from canton_templates")).rows.map((r) => [Number(r.id), { packageId: r.package_id as string, module: r.module as string, entity: r.entity as string }]));
    const synchronizers = new Map((await c.query("select id, synchronizer_id from canton_synchronizers")).rows.map((r) => [Number(r.id), r.synchronizer_id as string]));
    const participants = new Map((await c.query("select id, participant_id, first_offset from canton_participants")).rows.map((r) => [Number(r.id), { id: r.participant_id as string, firstOffset: r.first_offset === null ? null : Number(r.first_offset) }]));
    let after = -1, total = 0;
    for (;;) {
      const page = await c.query(
        `select b.number, '0x' || encode(b.hash, 'hex') as hash, '0x' || encode(b.parent_hash, 'hex') as parent, b.update_id, encode(br.header, 'hex') as header, encode(br.txs, 'hex') as txs,
           br.contract_id, encode(p.proof, 'hex') as proof, cu.participant, cu.reader_offset, to_char(cu.record_time at time zone 'UTC', ${TIMESTAMP}) as record_time,
           to_char(cu.effective_at at time zone 'UTC', ${TIMESTAMP}) as effective_at, cu.synchronizer, cu.reader_template, cu.signatories
         from blocks b join block_records br on br.number = b.number join proofs p on p.number = b.number join canton_updates cu on cu.update_id = b.update_id
         where b.number > $1 order by b.number limit $2`, [after, size]);
      for (const r of page.rows) {
        const number = Number(r.number);
        const signatories = (r.signatories as number[]).map((id) => need(parties, id, "signatory", number));
        const operator = roles.get("operator"), confirmer = roles.get("confirmer");
        if (operator === undefined || confirmer === undefined) throw new Error(`block ${number}: the database has no operator or confirmer party: the export is stopped`);
        const line: ExportedRecord = {
          updateId: r.update_id, offset: Number(r.reader_offset), recordTime: r.record_time, chainId: header.chainId, number, blockHash: r.hash, parentHash: r.parent,
          headerHex: r.header, txsHex: r.txs, proofHex: r.proof, operator, confirmer,
          synchronizerId: need(synchronizers, r.synchronizer, "synchronizer", number), effectiveAt: r.effective_at ?? r.record_time, contractId: r.contract_id,
          template: need(templates, r.reader_template, "template", number), signatories, participant: need(participants, r.participant, "participant", number),
        };
        await write(JSON.stringify(line));
        after = number;
        total++;
      }
      if (page.rows.length < size) break;
    }
    await c.query("commit");
    return total;
  } catch (e) {
    try {
      await c.query("rollback");
    } catch {
      broken = true;
    }
    throw e;
  } finally {
    c.release(broken);
  }
}

/** Writes the export to `path`, through a partial file that is renamed when it is whole, so a failed export leaves no file that looks finished. */
export async function exportRecordsToFile(pool: Pool, path: string, options: { pageSize?: number } = {}): Promise<number> {
  if (existsSync(path)) throw new Error(`${path} is already there: an export is never written over a file`);
  const partial = `${path}.partial`;
  const out = createWriteStream(partial, { flags: "wx" });
  try {
    const written = await exportRecords(pool, async (line) => { if (!out.write(line + "\n")) await once(out, "drain"); }, options);
    out.end();
    await once(out, "finish");
    renameSync(partial, path);
    return written;
  } catch (e) {
    out.destroy();
    rmSync(partial, { force: true });
    throw e;
  }
}

const str = (v: unknown, what: string, at: number): string => (typeof v === "string" && v.length > 0 ? v : fail(at, `${what} is missing`));
const int = (v: unknown, what: string, at: number): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : fail(at, `${what} is not a whole number`));
function fail(at: number, message: string): never { throw new Error(`records file, line ${at}: ${message}`); }

function parseRecord(line: string, at: number): ExportedRecord {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return fail(at, "not JSON");
  }
  const template = (o.template ?? {}) as Record<string, unknown>, participant = (o.participant ?? {}) as Record<string, unknown>;
  const signatories = Array.isArray(o.signatories) && o.signatories.every((s) => typeof s === "string") ? (o.signatories as string[]) : fail(at, "signatories is not a list of party ids");
  return {
    updateId: str(o.updateId, "updateId", at), offset: int(o.offset, "offset", at), recordTime: str(o.recordTime, "recordTime", at), chainId: int(o.chainId, "chainId", at),
    number: int(o.number, "number", at), blockHash: str(o.blockHash, "blockHash", at), parentHash: str(o.parentHash, "parentHash", at), headerHex: str(o.headerHex, "headerHex", at),
    txsHex: typeof o.txsHex === "string" ? o.txsHex : fail(at, "txsHex is missing"), proofHex: str(o.proofHex, "proofHex", at), operator: str(o.operator, "operator", at),
    confirmer: str(o.confirmer, "confirmer", at), synchronizerId: str(o.synchronizerId, "synchronizerId", at), effectiveAt: str(o.effectiveAt, "effectiveAt", at),
    contractId: str(o.contractId, "contractId", at), signatories,
    template: { packageId: str(template.packageId, "template.packageId", at), module: str(template.module, "template.module", at), entity: str(template.entity, "template.entity", at) },
    participant: { id: str(participant.id, "participant.id", at), firstOffset: participant.firstOffset === null ? null : int(participant.firstOffset, "participant.firstOffset", at) },
  };
}

/** The header, and the records after it, read a line at a time. Throws for a file that is not an export or has a line that is not a record. */
export async function* readRecords(path: string): AsyncGenerator<RecordsHeader | ExportedRecord> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let at = 0;
  for await (const line of lines) {
    at++;
    if (line === "") continue;
    if (at === 1) {
      const h = (() => { try { return JSON.parse(line) as Partial<RecordsHeader>; } catch { return {}; } })() as Partial<RecordsHeader>;
      if (h.format !== RECORDS_FORMAT || h.version !== 1 || !Number.isSafeInteger(h.chainId) || typeof h.genesisHash !== "string") fail(1, `not an export of block records (the first line should name the format ${RECORDS_FORMAT})`);
      yield h as RecordsHeader;
    } else {
      yield parseRecord(line, at);
    }
  }
  if (at === 0) fail(1, "the file is empty");
}
