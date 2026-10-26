/**
 * Stage 1 of a block: everything that makes it queryable, in one database transaction with the reader's cursor (design section 4.3).
 *
 * The guard is the first read of the transaction: a block that is already there is skipped whole, because counters and balances add up
 * rather than overwrite, so `ON CONFLICT` would not make a replay harmless. Then the checks that stop the indexer at a bad block: C2 (order),
 * C1 (three hashes), C3 (the transactions) and C7 (the proof's facts). A check that fails throws before anything is written; one that
 * can only be seen after the rows are in (C3's counts) throws inside the transaction, which rolls back.
 */
import { keccak256 } from "viem";
import type { PoolClient } from "pg";
import { keyFor, type Pins } from "../config.ts";
import type { BlockRecord } from "../ledger.ts";
import { checkProofFacts, readProofFacts } from "../proof.ts";
import { setHealth } from "./health.ts";
import { decodeLeg, legHash, LEG_TOPIC, type Leg } from "./legs.ts";
import { IndexerStop, LegUndecodable } from "./errors.ts";
import type { FinalBlock, FinalReceipt } from "./reads.ts";
import { transactionHashes } from "./rlp.ts";

export interface Stage1Input {
  record: BlockRecord;
  block: FinalBlock;
  receipts: FinalReceipt[];
  /** The legs the gateway recorded in this block that could be decoded, in log order, with the place of each among the block's Leg logs and the log it came from. */
  legs: { leg: Leg; index: number; txIndex: number; logIndex: number }[];
  /** How many Leg logs the gateway wrote in this block, decodable or not: the row says what the chain says even when a Leg cannot be read. */
  legsCount: number;
  /** `legs[number]` from the gateway's storage; null when the block has no legs. */
  legsHash: string | null;
  /** reth's hash for block 0: the parent the first record must name. */
  genesisHash: string;
  participantId: string;
  /** Where the indexer began reading this participant, for a participant it has not seen before. */
  startOffset: number;
  pins: Pins;
}

export type Stage1Result = { written: true; txCount: number; logCount: number } | { written: false };

const bytea = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");
const byteaOrNull = (h: string | null): Buffer | null => (h === null ? null : bytea(h));
/** The columns a reindex recomputes: all but the block's update, record time, attempt and `indexed_at`. */
const REPLACE = ` on conflict (number) do update set hash = excluded.hash, parent_hash = excluded.parent_hash, timestamp = excluded.timestamp, fee_recipient = excluded.fee_recipient,
  gas_limit = excluded.gas_limit, gas_used = excluded.gas_used, base_fee_per_gas = excluded.base_fee_per_gas, burnt_fees = excluded.burnt_fees, priority_fees = excluded.priority_fees,
  tx_count = excluded.tx_count, log_count = excluded.log_count, size_bytes = excluded.size_bytes, state_root = excluded.state_root, transactions_root = excluded.transactions_root,
  receipts_root = excluded.receipts_root, extra_data = excluded.extra_data, legs_count = excluded.legs_count, legs_hash = excluded.legs_hash`;
const text = (n: bigint | null): string | null => (n === null ? null : n.toString());

/**
 * The gateway's `Leg` logs of a block, in log order, with the transaction and the position of each log in the block. A Leg that cannot be decoded
 * is left out of `legs` but counted in `count`, and the first such is returned as `problem`; the rest of the block's legs are still read.
 */
export function legsOf(receipts: FinalReceipt[], gateway: string, number: number): { legs: Stage1Input["legs"]; count: number; problem: LegUndecodable | null } {
  const legs: Stage1Input["legs"] = [];
  let problem: LegUndecodable | null = null;
  let count = 0;
  let logIndex = 0;
  receipts.forEach((r, txIndex) => {
    for (const log of r.logs) {
      if (log.address === gateway && log.topics[0] === LEG_TOPIC) {
        try {
          legs.push({ leg: decodeLeg(log, number), index: count, txIndex, logIndex });
        } catch (e) {
          if (!(e instanceof LegUndecodable)) throw e;
          problem ??= e;
        }
        count++;
      }
      logIndex++;
    }
  });
  return { legs, count, problem };
}

/** The reader's cursor: the offset of the newest record on this participant, and the block it made. Offsets mean nothing without their participant. */
export async function setReaderCursor(c: PoolClient, offset: number, participant: string, block: number): Promise<void> {
  await c.query(
    `insert into cursors (stream, position, detail, updated_at) values ('reader_updates', $1, $2, now())
     on conflict (stream) do update set position = excluded.position, detail = excluded.detail, updated_at = excluded.updated_at`,
    [offset, JSON.stringify({ participant, block })],
  );
}

/** The id of a row in a dictionary table, adding the row when it is not there. These rows are shared and never counted, so `ON CONFLICT DO NOTHING` is right. */
async function dictionary(c: PoolClient, table: string, find: string, insert: string, values: unknown[]): Promise<number> {
  const found = await c.query(`with ins as (${insert} on conflict do nothing returning id) select id from ins union all select id from ${table} where ${find} limit 1`, values);
  return found.rows[0].id as number;
}

async function writeCanton(c: PoolClient, i: Stage1Input): Promise<{ updateId: string }> {
  const r = i.record;
  const sync = await dictionary(c, "canton_synchronizers", "synchronizer_id = $1", "insert into canton_synchronizers (synchronizer_id, first_seen) values ($1, now())", [r.synchronizerId]);
  const template = await dictionary(c, "canton_templates", "package_id = $1 and module = $2 and entity = $3",
    "insert into canton_templates (package_id, module, entity) values ($1, $2, $3)", [r.template.packageId, r.template.module, r.template.entity]);
  const participant = await dictionary(c, "canton_participants", "participant_id = $1",
    "insert into canton_participants (participant_id, first_offset, moved_in_at) values ($1, $2, now())", [i.participantId, i.startOffset]);
  const roles = new Map<string, string>([[r.operator, "operator"], [r.confirmer, "confirmer"]]);
  const parties: number[] = [];
  for (const signer of r.signatories) {
    parties.push(await dictionary(c, "canton_parties", "party = $1", "insert into canton_parties (party, role) values ($1, $2)", [signer, roles.get(signer)]));
  }
  await c.query(
    `insert into canton_updates (update_id, participant, reader_offset, record_time, effective_at, synchronizer, reader_template, signatories)
     values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (update_id) do nothing`,
    [r.updateId, participant, r.offset, r.recordTime, r.effectiveAt, sync, template, parties],
  );
  await c.query("insert into meta (key, value) values ('reader_participant', $1) on conflict do nothing", [i.participantId]);
  return { updateId: r.updateId };
}

/** The block's row, from the record, reth's block and its receipts. With `replace` an existing row is recomputed in place (a reindex), keeping its update, record time, attempt and `indexed_at`. Returns the block's log count. */
export async function writeBlockRow(
  c: PoolClient,
  i: Pick<Stage1Input, "block" | "receipts" | "legsCount" | "legsHash"> & { record: Pick<BlockRecord, "number" | "headerHex" | "txsHex" | "updateId" | "recordTime"> },
  replace: boolean,
): Promise<number> {
  const { record: r, block: b, receipts } = i;
  const n = r.number;
  let gasBurnt = 0n, priority = 0n, logCount = 0;
  receipts.forEach((x) => {
    gasBurnt += b.baseFeePerGas * BigInt(x.gasUsed);
    if (x.effectiveGasPrice > b.baseFeePerGas) priority += (x.effectiveGasPrice - b.baseFeePerGas) * BigInt(x.gasUsed);
    logCount += x.logs.length;
  });
  const size = b.size ?? (r.headerHex.length + r.txsHex.length) / 2;
  await c.query(
    `insert into blocks (number, hash, parent_hash, timestamp, fee_recipient, gas_limit, gas_used, base_fee_per_gas, burnt_fees, priority_fees, tx_count, log_count, size_bytes,
       state_root, transactions_root, receipts_root, extra_data, legs_count, legs_hash, update_id, record_time, indexed_at)
     values ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, now())${replace ? REPLACE : ""}`,
    [n, bytea(b.hash), bytea(b.parentHash), b.timestamp, bytea(b.miner), b.gasLimit, b.gasUsed, b.baseFeePerGas.toString(), gasBurnt.toString(), priority.toString(), b.transactions.length, logCount, size, bytea(b.stateRoot), bytea(b.transactionsRoot), bytea(b.receiptsRoot), bytea(b.extraData), i.legsCount,
      byteaOrNull(i.legsHash), r.updateId, r.recordTime],
  );
  return logCount;
}

/** The block's fact rows: transactions, their hashes, logs and the gateway's legs. Shared by stage 1 and by a reindex, which writes the same rows again. */
export async function writeFacts(c: PoolClient, n: number, b: FinalBlock, receipts: FinalReceipt[], legs: Stage1Input["legs"]): Promise<{ rowsTx: number; rowsLogs: number }> {
  const txs = b.transactions;
  const logCount = receipts.reduce((x, y) => x + y.logs.length, 0);
  let rowsTx = 0, rowsLogs = 0;
  if (txs.length > 0) {
    const idx = txs.map((_, k) => k);
    const res = await c.query(
      `insert into transactions (block_number, tx_index, hash, type, from_address, to_address, created_contract, nonce, value, gas_limit, gas_price, max_fee_per_gas,
         max_priority_fee_per_gas, effective_gas_price, gas_used, cumulative_gas_used, status, method_id, input, access_list, authorization_list, log_count)
       select $1::bigint, t.i, t.hash, t.type, t.from_address, t.to_address, t.created, t.nonce, t.value, t.gas_limit, t.gas_price, t.max_fee, t.max_priority, t.effective,
         t.gas_used, t.cumulative, t.status, t.method_id, t.input, t.access_list::jsonb, t.authorization_list::jsonb, t.log_count
       from unnest($2::int[], $3::bytea[], $4::smallint[], $5::bytea[], $6::bytea[], $7::bytea[], $8::bigint[], $9::numeric[], $10::bigint[], $11::numeric[], $12::numeric[],
         $13::numeric[], $14::numeric[], $15::bigint[], $16::bigint[], $17::smallint[], $18::bytea[], $19::bytea[], $20::text[], $21::text[], $22::int[])
         as t(i, hash, type, from_address, to_address, created, nonce, value, gas_limit, gas_price, max_fee, max_priority, effective, gas_used, cumulative, status,
         method_id, input, access_list, authorization_list, log_count)`,
      [n, idx, txs.map((t) => bytea(t.hash)), txs.map((t) => t.type), txs.map((t) => bytea(t.from)), txs.map((t) => byteaOrNull(t.to)),
        receipts.map((x) => byteaOrNull(x.contractAddress)), txs.map((t) => t.nonce), txs.map((t) => t.value.toString()), txs.map((t) => t.gas), txs.map((t) => text(t.gasPrice)),
        txs.map((t) => text(t.maxFeePerGas)), txs.map((t) => text(t.maxPriorityFeePerGas)), receipts.map((x) => x.effectiveGasPrice.toString()), receipts.map((x) => x.gasUsed),
        receipts.map((x) => x.cumulativeGasUsed), receipts.map((x) => x.status), txs.map((t) => (t.input.length >= 10 ? bytea(t.input.slice(0, 10)) : null)),
        txs.map((t) => bytea(t.input)), txs.map((t) => (t.accessList === null ? null : JSON.stringify(t.accessList))),
        txs.map((t) => (t.authorizationList === null ? null : JSON.stringify(t.authorizationList))), receipts.map((x) => x.logs.length)],
    );
    rowsTx = res.rowCount ?? 0;
    await c.query(
      "insert into tx_hashes (hash, block_number, tx_index) select h, $1::bigint, i from unnest($2::bytea[], $3::int[]) as t(h, i)",
      [n, txs.map((t) => bytea(t.hash)), idx],
    );
  }
  if (logCount > 0) {
    const flat: { tx: number; log: FinalReceipt["logs"][number] }[] = receipts.flatMap((x, tx) => x.logs.map((log) => ({ tx, log })));
    const topic = (k: number) => flat.map((l) => byteaOrNull(l.log.topics[k] ?? null));
    const res = await c.query(
      `insert into logs (block_number, log_index, tx_index, address, topic0, topic1, topic2, topic3, data)
       select $1::bigint, t.i, t.tx, t.a, t.t0, t.t1, t.t2, t.t3, t.d from unnest($2::int[], $3::int[], $4::bytea[], $5::bytea[], $6::bytea[], $7::bytea[], $8::bytea[], $9::bytea[])
         as t(i, tx, a, t0, t1, t2, t3, d)`,
      [n, flat.map((_, k) => k), flat.map((l) => l.tx), flat.map((l) => bytea(l.log.address)), topic(0), topic(1), topic(2), topic(3), flat.map((l) => bytea(l.log.data))],
    );
    rowsLogs = res.rowCount ?? 0;
  }
  if (legs.length > 0) {
    await c.query(
      `insert into gateway_legs (block_number, leg_index, tx_index, log_index, kind, leg_id, token, account, amount, party)
       select $1::bigint, t.i, t.tx, t.log, t.kind, t.id, t.token, t.account, t.amount, t.party from unnest($2::int[], $3::int[], $4::int[], $5::smallint[], $6::bytea[], $7::bytea[], $8::bytea[], $9::numeric[], $10::text[])
         as t(i, tx, log, kind, id, token, account, amount, party)`,
      [n, legs.map((l) => l.index), legs.map((l) => l.txIndex), legs.map((l) => l.logIndex), legs.map((l) => l.leg.kind), legs.map((l) => bytea(l.leg.id)),
        legs.map((l) => bytea(l.leg.token)), legs.map((l) => bytea(l.leg.account)), legs.map((l) => l.leg.amount.toString()), legs.map((l) => (l.leg.kind === 2 ? l.leg.party : null))],
    );
  }
  return { rowsTx, rowsLogs };
}

/**
 * The transaction's checks and writes for one block. `c` is a client inside a database transaction that the caller begins and commits,
 * so that stage 2 can share it in the `inline` shape. Throws IndexerStop for a failed check; the caller rolls back.
 */
export async function stage1(c: PoolClient, i: Stage1Input): Promise<Stage1Result> {
  const { record: r, block: b, receipts } = i;
  const n = r.number;

  // 1. Guard.
  const have = await c.query("select hash from blocks where number = $1", [n]);
  if (have.rowCount) {
    if (!(have.rows[0].hash as Buffer).equals(bytea(r.blockHash))) {
      throw new IndexerStop("C2", `block ${n} is indexed with hash 0x${(have.rows[0].hash as Buffer).toString("hex")}, but the record says ${r.blockHash}: this database belongs to another chain instance`, n);
    }
    // A replay: nothing is written and nothing moves, except that the cursor is put where this record is, so that the walk goes on past it.
    await setReaderCursor(c, r.offset, i.participantId, n);
    return { written: false };
  }

  // 2. The record. C2: number, parent, no gap.
  const last = await c.query("select number, hash from blocks order by number desc limit 1");
  const lastNumber = last.rowCount ? Number(last.rows[0].number) : 0;
  const lastHash = last.rowCount ? "0x" + (last.rows[0].hash as Buffer).toString("hex") : i.genesisHash;
  if (n !== lastNumber + 1) throw new IndexerStop("C2", `the record is for block ${n}, but the index is at ${lastNumber}: ${n > lastNumber ? "there is a gap" : "the record repeats an earlier number with no block of that number"}`, n, { expected: lastNumber + 1, got: n });
  if (r.parentHash !== lastHash) throw new IndexerStop("C2", `block ${n}: the record's parent is ${r.parentHash}, not the last indexed hash ${lastHash}`, n, { expected: lastHash, got: r.parentHash });

  // C1: reth's hash, the record's hash and the Keccak of the record's header are one hash (and so is the parent).
  const headerHash = keccak256(`0x${r.headerHex}`);
  if (b.hash !== r.blockHash || b.hash !== headerHash || b.parentHash !== r.parentHash || b.number !== n) {
    throw new IndexerStop("C1", `block ${n}: reth's hash is ${b.hash}, the record's hash is ${r.blockHash} and the header's hash is ${headerHash}`, n, { reth: b.hash, record: r.blockHash, header: headerHash });
  }

  // C3, the part that needs no rows: the record's transaction list hashes to reth's transactions, in order, and each has its receipt.
  const hashes = transactionHashes(r.txsHex, n);
  if (hashes.length !== b.transactions.length || hashes.some((h, k) => h !== b.transactions[k]!.hash)) {
    throw new IndexerStop("C3", `block ${n}: the record's ${hashes.length} transactions do not hash to reth's ${b.transactions.length}, in order`, n, { record: hashes.length, reth: b.transactions.length });
  }
  if (receipts.length !== b.transactions.length || receipts.some((x, k) => x.transactionHash !== b.transactions[k]!.hash)) {
    throw new IndexerStop("C3", `block ${n}: reth's receipts are not those of its ${b.transactions.length} transactions, in order`, n);
  }

  // C7: the program key and the ZisK release in the proof are the pins. The proof's own block hash is recorded, and C1 is what stops a wrong block.
  const facts = readProofFacts(r.proofHex);
  const key = keyFor(i.pins, n);
  const checked = facts ? checkProofFacts(facts, key, r.blockHash) : null;
  if (!facts || !checked || !checked.programVK.ok || !checked.rootC.ok) {
    throw new IndexerStop("C7", `block ${n}: ${!facts ? "the proof is not 1,344 bytes of hex" : `the proof's program key is ${facts.programVK} and its release root ${facts.rootC}, not the ${key.programVK} and ${key.rootC} pinned for this height`}`,
      n, { programVK: facts?.programVK ?? null, rootC: facts?.rootC ?? null, pinned: { programVK: key.programVK, rootC: key.rootC, fromBlock: key.fromBlock } });
  }
  const signers = new Set([r.operator, r.confirmer]);
  if (r.signatories.length !== signers.size || r.signatories.some((s) => !signers.has(s))) {
    throw new IndexerStop("record", `block ${n}: the record's signatories are not its operator and confirmer`, n);
  }

  // 3. Write.
  const { updateId } = await writeCanton(c, i);
  const logCount = await writeBlockRow(c, i, false);
  await c.query("insert into block_records (number, header, txs, contract_id) values ($1, $2, $3, $4)", [n, bytea(r.headerHex), bytea(r.txsHex), r.contractId]);
  await c.query(
    "insert into proofs (number, proof, program_vk, root_c, committed_block_hash, matches_pins, matches_block) values ($1, $2, $3, $4, $5, $6, $7)",
    [n, bytea(r.proofHex), bytea(facts.programVK), bytea(facts.rootC), byteaOrNull(facts.blockHash) ?? Buffer.alloc(32), true, checked.blockHash.ok],
  );

  const { rowsTx, rowsLogs } = await writeFacts(c, n, b, receipts, i.legs);
  const txs = b.transactions;
  if (txs.length > 0) {
    await c.query(
      `insert into tx_lifecycle (tx_hash, sender, nonce, final_block, final_at, state, updated_at)
       select h, s, nn, $1::bigint, $2::timestamptz, 'final', now() from unnest($3::bytea[], $4::bytea[], $5::bigint[]) as t(h, s, nn)
       on conflict (tx_hash) do update set sender = coalesce(tx_lifecycle.sender, excluded.sender), nonce = coalesce(tx_lifecycle.nonce, excluded.nonce),
         final_block = excluded.final_block, final_at = excluded.final_at, state = 'final', state_reason = null, updated_at = excluded.updated_at`,
      [n, r.recordTime, txs.map((t) => bytea(t.hash)), txs.map((t) => bytea(t.from)), txs.map((t) => t.nonce)],
    );
    // A transaction that never landed and has the sender and nonce of one that is final is replaced (design section 4.6), by whichever writer sees it first.
    await c.query(
      `update tx_lifecycle l set state = 'replaced', state_reason = 'another transaction from the same sender took nonce ' || t.nn, updated_at = now()
         from unnest($1::bytea[], $2::bigint[], $3::bytea[]) as t(s, nn, h)
        where l.sender = t.s and l.nonce = t.nn and l.tx_hash <> t.h and l.state <> 'final' and l.state <> 'replaced'`,
      [txs.map((t) => bytea(t.from)), txs.map((t) => t.nonce), txs.map((t) => bytea(t.hash))],
    );
  }

  // C3, the part that needs the rows: the block's counts are the rows written.
  if (rowsTx !== txs.length || rowsLogs !== logCount) {
    throw new IndexerStop("C3", `block ${n}: ${txs.length} transactions and ${logCount} logs, but ${rowsTx} and ${rowsLogs} rows were written`, n);
  }

  // 4. The cursor and the checks' rows, in the same transaction; and the word to the API, which Postgres delivers when it commits.
  await setReaderCursor(c, r.offset, i.participantId, n);
  const seen = { block: n };
  await setHealth(c, ["C1", "C2", "C3", "C7"].map((id) => ({ id, status: "ok" as const, value: seen })));
  await c.query("select pg_notify('final_block', $1)", [String(n)]);
  return { written: true, txCount: txs.length, logCount };
}

/**
 * C10: the running leg hash worked out again from the block's decoded `Leg` events, in log order, against `legs[N]` as reth stores it. A leg that
 * cannot be decoded, or a hash that differs, is `degraded` naming the block, never a stop. A later block that agrees does not clear the report of an
 * older one: the row stays degraded until a person has looked, because one old block that disagrees is still one that disagrees.
 */
export async function checkLegs(c: PoolClient, n: number, legs: ReturnType<typeof legsOf>["legs"], onChain: string | null, problem: Error | null): Promise<void> {
  if (problem) {
    await setHealth(c, [{ id: "C10", status: "degraded", value: { block: n }, detail: problem.message }]);
    return;
  }
  if (legs.length === 0) return;
  const computed = legHash(legs.map((l) => l.leg));
  if (computed !== onChain) {
    await setHealth(c, [{ id: "C10", status: "degraded", value: { block: n, computed, onChain }, detail: `block ${n}: the leg hash worked out from its ${legs.length} Leg events is ${computed}, but the gateway's legs[${n}] is ${onChain}` }]);
    return;
  }
  const now0 = (await c.query("select status from health_checks where check_id = 'C10'")).rows[0]?.status as string | undefined;
  if (now0 !== "degraded") await setHealth(c, [{ id: "C10", status: "ok", value: { block: n } }]);
}
