/**
 * The contracts a block made (design section 5.2): each with its creator, the transaction and the place in its call tree, and its runtime and creation code
 * (one copy of each code, shared by clones), and the ones the block destroyed. Written by stage 2, in its transaction.
 */
import type { PoolClient } from "pg";
import { codeHash, type CreatedContract, type Destroyed } from "./calls.ts";
import type { FinalReads } from "./reads.ts";

const bytea = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");

/**
 * Writes the contracts `created` in block `n` and marks the `destroyed` ones whose code reth no longer holds at `n`. A contract that is written again
 * (the reindex, or a CREATE2 address that was destroyed and made again) takes the new creation and keeps what has been counted on it; an older creation never replaces a later one (a reindex of an earlier block).
 * An account that destroyed itself is a destroyed contract only when its code is gone: a chain that follows EIP-6780 keeps the code of a contract that
 * was not made in the same transaction.
 */
export async function writeContracts(c: Pick<PoolClient, "query">, n: number, created: CreatedContract[], destroyed: Destroyed[], reads: Pick<FinalReads, "code">): Promise<void> {
  // One row per address: when a block makes an address twice, the later creation is the contract.
  const last = new Map<string, CreatedContract>();
  for (const k of created) last.set(k.address, k);
  const made = [...last.values()];
  if (made.length > 0) {
    const codes = new Map<string, string>();
    for (const k of made) {
      codes.set(codeHash(k.runtimeCode), k.runtimeCode);
      codes.set(codeHash(k.initCode), k.initCode);
    }
    const hashes = [...codes.keys()].sort();
    await c.query(
      `insert into bytecodes (code_hash, code, size) select t.h, t.c, t.s from unnest($1::bytea[], $2::bytea[], $3::int[]) as t(h, c, s) on conflict do nothing`,
      [hashes.map(bytea), hashes.map((h) => bytea(codes.get(h)!)), hashes.map((h) => (codes.get(h)!.length - 2) / 2)],
    );
    await c.query(
      `insert into contracts (address, origin, creator, creation_block, creation_tx_index, creation_trace_address, runtime_code_hash, creation_code_hash, destroyed_block)
       select t.a, 'create', t.cr, $1::bigint, t.tx, t.path::int[], t.rh, t.ch, null
       from unnest($2::bytea[], $3::bytea[], $4::int[], $5::text[], $6::bytea[], $7::bytea[]) as t(a, cr, tx, path, rh, ch)
       on conflict (address) do update set origin = 'create', creator = excluded.creator, creation_block = excluded.creation_block, creation_tx_index = excluded.creation_tx_index,
         creation_trace_address = excluded.creation_trace_address, creation_code_hash = excluded.creation_code_hash,
         -- The verified state follows the code at the address: other code there is unverified (and loses a name that came from the source) until it is verified.
         verified_source = case when contracts.runtime_code_hash = excluded.runtime_code_hash then contracts.verified_source end,
         match_type = case when contracts.runtime_code_hash = excluded.runtime_code_hash then contracts.match_type end,
         name = case when contracts.runtime_code_hash = excluded.runtime_code_hash or contracts.verified_source is null then contracts.name end,
         runtime_code_hash = excluded.runtime_code_hash,
         destroyed_block = case when excluded.creation_block > contracts.creation_block then null else contracts.destroyed_block end
         where contracts.origin = 'create' and contracts.creation_block <= excluded.creation_block`,
      [n, made.map((k) => bytea(k.address)), made.map((k) => bytea(k.creator)), made.map((k) => k.txIndex), made.map((k) => `{${k.traceAddress.join(",")}}`),
        made.map((k) => bytea(codeHash(k.runtimeCode))), made.map((k) => bytea(codeHash(k.initCode)))],
    );
    // A clone of code that is already verified shows a similar match from the start (design 6.3, point 6): the verifier marks the clones that exist when it
    // verifies, and this marks the ones made after. A contract with a source of its own, or one already marked, is left as it is.
    await c.query(
      `update contracts c set verified_source = v.id, match_type = 'similar', name = coalesce(c.name, v.contract_name)
       from (select distinct on (runtime_code_hash) id, runtime_code_hash, contract_name from verified_sources order by runtime_code_hash, (match_type = 'full') desc, id) v
       where c.address = any($1::bytea[]) and c.runtime_code_hash = v.runtime_code_hash and c.verified_source is null
         and not exists (select 1 from verified_sources o where o.address = c.address and o.runtime_code_hash = c.runtime_code_hash)`,
      [made.map((k) => bytea(k.address))],
    );
  }
  const targets = [...new Set(destroyed.map((d) => d.address))].sort();
  if (targets.length === 0) return;
  const known = (await c.query("select encode(address, 'hex') as a from contracts where address = any($1::bytea[]) and destroyed_block is null and (origin = 'genesis' or creation_block <= $2)", [targets.map(bytea), n])).rows.map((r) => "0x" + (r.a as string));
  const gone: string[] = [];
  for (const a of known) if ((await reads.code(a, n)) === "0x") gone.push(a);
  if (gone.length > 0) await c.query("update contracts set destroyed_block = $1 where address = any($2::bytea[]) and destroyed_block is null and (origin = 'genesis' or creation_block <= $1)", [n, gone.map(bytea)]);
}

/**
 * Counts, for each contract a transaction of block `n` was sent to, the transactions and the block. A contract made in this block counts only the
 * transactions after the one that made it.
 */
export async function countInteractions(c: Pick<PoolClient, "query">, n: number): Promise<void> {
  await c.query(
    `update contracts c set interaction_count = c.interaction_count + t.n, last_interaction_block = $1
     from (
       select x.to_address, count(*) as n from transactions x join contracts k on k.address = x.to_address
       where x.block_number = $1 and (k.creation_block is distinct from $1::bigint or x.tx_index > k.creation_tx_index)
       group by x.to_address
     ) t where c.address = t.to_address`,
    [n],
  );
}
