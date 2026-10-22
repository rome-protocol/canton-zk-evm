import type { Pool } from "pg";
import { ensurePartitions } from "../server/db/partitions.ts";
import type { BlockRecord } from "../server/ledger.ts";
import { checkProofFacts, readProofFacts } from "../server/proof.ts";
import type { Pins } from "../server/config.ts";

/** What a test says about a transaction of the fake chain, as the indexer would have stored it. */
export interface SeedTx {
  from: string; to: string | null; value: bigint; nonce: number; type: number; gas: number; input: string;
}
export interface SeedBlock {
  record: BlockRecord;
  /** reth's block: header fields as the fake chain makes them. */
  raw: Record<string, unknown>;
  receipts: Record<string, unknown>[];
}

const bytea = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");
const num = (h: unknown): number => Number(h);

/** Writes the rows the indexer's stage 1 writes for the blocks that Canton holds, straight in SQL: the tables the routes read, and nothing else. */
export async function seedBlocks(pool: Pool, blocks: SeedBlock[], txOf: (block: number, index: number) => SeedTx, pins: Pins, participant = "PAR::participant::1220" + "aa".repeat(32)): Promise<void> {
  if (blocks.length === 0) return;
  await ensurePartitions(pool, { head: Math.max(...blocks.map((b) => b.record.number)) });
  for (const { record: r, raw, receipts } of blocks) {
    const sync = (await pool.query("insert into canton_synchronizers (synchronizer_id, first_seen) values ($1, now()) on conflict (synchronizer_id) do update set synchronizer_id = excluded.synchronizer_id returning id", [r.synchronizerId])).rows[0].id;
    const tpl = (await pool.query("insert into canton_templates (package_id, module, entity) values ($1, $2, $3) on conflict (package_id, module, entity) do update set module = excluded.module returning id", [r.template.packageId, r.template.module, r.template.entity])).rows[0].id;
    const par = (await pool.query("insert into canton_participants (participant_id, first_offset, moved_in_at) values ($1, 0, now()) on conflict (participant_id) do update set participant_id = excluded.participant_id returning id", [participant])).rows[0].id;
    const parties: number[] = [];
    for (const [party, role] of [[r.operator, "operator"], [r.confirmer, "confirmer"]] as const) {
      parties.push((await pool.query("insert into canton_parties (party, role) values ($1, $2) on conflict (party) do update set role = excluded.role returning id", [party, role])).rows[0].id);
    }
    await pool.query(
      "insert into canton_updates (update_id, participant, reader_offset, record_time, effective_at, synchronizer, reader_template, signatories) values ($1, $2, $3, $4, $4, $5, $6, $7)",
      [r.updateId, par, r.offset, r.recordTime, sync, tpl, parties],
    );
    const txs = (raw.transactions as string[]).map((hash, i) => ({ hash, i, t: txOf(r.number, i), rc: receipts[i]! }));
    const logs = receipts.flatMap((rc, tx) => (rc.logs as { address: string; topics: string[]; data: string }[]).map((l) => ({ tx, l })));
    await pool.query(
      `insert into blocks (number, hash, parent_hash, timestamp, fee_recipient, gas_limit, gas_used, base_fee_per_gas, burnt_fees, priority_fees, tx_count, log_count, size_bytes,
         state_root, transactions_root, receipts_root, extra_data, legs_count, update_id, record_time, indexed_at)
       values ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, 0, 0, $9, $10, 100, $11, $12, $13, $14, 0, $15, $16, now())`,
      [r.number, bytea(raw.hash as string), bytea(raw.parentHash as string), num(raw.timestamp), bytea(raw.miner as string), num(raw.gasLimit), num(raw.gasUsed), num(raw.baseFeePerGas),
        txs.length, logs.length, bytea(raw.stateRoot as string), Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(0), r.updateId, r.recordTime],
    );
    await pool.query("insert into block_records (number, header, txs, contract_id) values ($1, $2, $3, $4)", [r.number, bytea(r.headerHex), bytea(r.txsHex), r.contractId]);
    const facts = readProofFacts(r.proofHex);
    const checked = facts && checkProofFacts(facts, pins, r.blockHash);
    await pool.query(
      "insert into proofs (number, proof, program_vk, root_c, committed_block_hash, matches_pins, matches_block) values ($1, $2, $3, $4, $5, $6, $7)",
      [r.number, bytea(r.proofHex), bytea(facts?.programVK ?? "00".repeat(32)), bytea(facts?.rootC ?? "00".repeat(32)), bytea(facts?.blockHash ?? "00".repeat(32)), !!checked && checked.programVK.ok && checked.rootC.ok, !!checked?.blockHash.ok],
    );
    for (const { hash, i, t, rc } of txs) {
      await pool.query(
        `insert into transactions (block_number, tx_index, hash, type, from_address, to_address, created_contract, nonce, value, gas_limit, effective_gas_price, gas_used, cumulative_gas_used, status, method_id, input, log_count)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, $14, $15, $16)`,
        [r.number, i, bytea(hash), t.type, bytea(t.from), t.to ? bytea(t.to) : null, rc.contractAddress ? bytea(rc.contractAddress as string) : null, t.nonce, t.value.toString(), t.gas,
          num(rc.effectiveGasPrice), num(rc.gasUsed), num(rc.status), t.input.length >= 10 ? bytea(t.input.slice(0, 10)) : null, bytea(t.input), (rc.logs as unknown[]).length],
      );
      await pool.query("insert into tx_hashes (hash, block_number, tx_index) values ($1, $2, $3)", [bytea(hash), r.number, i]);
    }
    for (const [k, { tx, l }] of logs.entries()) {
      await pool.query(
        "insert into logs (block_number, log_index, tx_index, address, topic0, topic1, topic2, topic3, data) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [r.number, k, tx, bytea(l.address), ...[0, 1, 2, 3].map((n) => (l.topics[n] ? bytea(l.topics[n]!) : null)), bytea(l.data)],
      );
    }
    await pool.query(
      "insert into cursors (stream, position, detail, updated_at) values ('reader_updates', $1, $2, now()) on conflict (stream) do update set position = excluded.position, detail = excluded.detail, updated_at = excluded.updated_at",
      [r.offset, JSON.stringify({ participant, block: r.number })],
    );
  }
}
