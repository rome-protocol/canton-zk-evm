import type { Pool, PoolClient } from "pg";
import type { ChainRegistry, Ledger } from "../ledger.ts";
import type { FinalReads } from "./reads.ts";
import { SELECTORS, tryCall } from "./tokens.ts";

const bytea = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");
const uint = (output: string | null): bigint | null => (output !== null && /^0x[0-9a-f]{64}$/.test(output) ? BigInt(output) : null);

/**
 * One custody read, of the gateway's registered tokens and what it holds of each instrument, set against each token's supply at the SAME block. The newest indexed
 * block B is taken first, with the ledger offset of its Canton record; it is read only if its record is on the participant now read (`participantId`, the one the reader client
 * reports, and not marked as moved out). The holdings are read as the gateway at that offset (`ledger.gatewayCustody`) and each token's
 * `totalSupply()` at B (reth). A block's record and its legs are one Canton update, so the custody at that offset is the custody after exactly the legs up to B, the
 * same legs the supply at B counts: a deposit that lands later is in neither number. The rows are written as the whole of the table in one transaction, so a reader sees
 * one read or the one before. A read that fails writes nothing and the last rows stay, with the time they were read at. A token that is no longer registered is
 * dropped; with no token registered the table is empty. With no block indexed yet, or the newest block's record not on the participant now read (offsets are local to a
 * participant, so after a reader move the older participant's offset means nothing here, and it stays so until the new participant has indexed a block), there is nothing
 * to read at, and nothing is written.
 */
export async function custodyOnce(pool: Pick<Pool, "connect" | "query">, ledger: Pick<Ledger, "gatewayCustody">, reads: Pick<FinalReads, "call">, limit: number, participantId: string, chainId: number | null = null): Promise<{ tokens: number; offset: number; block: number | null }> {
  const [at] = (await pool.query(
    "select b.number, u.reader_offset, (p.participant_id = $1 and p.moved_out_at is null) as current from blocks b join canton_updates u on u.update_id = b.update_id join canton_participants p on p.id = u.participant order by b.number desc limit 1",
    [participantId],
  )).rows;
  if (!at || !at.current) return { tokens: 0, offset: 0, block: null };
  const block = Number(at.number), offset = Number(at.reader_offset);
  const { tokens, registry } = await ledger.gatewayCustody(limit, offset, chainId);
  const supplies = await Promise.all(tokens.map(async (t) => uint(await tryCall(reads, t.evmToken, SELECTORS.totalSupply, block))));
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("delete from gateway_tokens where evm_token <> all($1::bytea[])", [tokens.map((t) => bytea(t.evmToken))]);
    if (tokens.length > 0) {
      await c.query(
        `insert into gateway_tokens (evm_token, instrument_admin, instrument_id, custody, holdings, supply, supply_block, ledger_offset, read_at)
         select t.token, t.admin, t.id, t.custody::numeric, t.holdings, t.supply::numeric, $7::bigint, $6::bigint, now()
           from unnest($1::bytea[], $2::text[], $3::text[], $4::text[], $5::int[], $8::text[]) as t(token, admin, id, custody, holdings, supply)
         on conflict (evm_token) do update set instrument_admin = excluded.instrument_admin, instrument_id = excluded.instrument_id, custody = excluded.custody,
           holdings = excluded.holdings, supply = excluded.supply, supply_block = excluded.supply_block, ledger_offset = excluded.ledger_offset, read_at = excluded.read_at`,
        [tokens.map((t) => bytea(t.evmToken)), tokens.map((t) => t.instrumentAdmin), tokens.map((t) => t.instrumentId), tokens.map((t) => t.custody.toString()), tokens.map((t) => t.holdings), offset, block,
          supplies.map((v) => (v === null ? null : v.toString()))],
      );
    }
    if (registry) await writeRegistry(c, registry, offset, block);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return { tokens: tokens.length, offset, block };
}

/**
 * The chain record's registry as the read at `block` found it, written as the whole of `canton_registry` (this version of the chain has no removal, so a row that is gone means another chain
 * record, and goes). An entry the read has not seen before starts its leg index at the block of the read before (an entry was not there then, so none of its legs were, up to that block), or at 0
 * when no read was made: a gateway registered long ago is read from its first leg. An entry seen before keeps its progress.
 */
export async function writeRegistry(c: Pick<PoolClient, "query">, registry: ChainRegistry, offset: number, block: number): Promise<void> {
  const prev = (await c.query("select value from meta where key = 'registry_read_block'")).rows[0]?.value as string | undefined;
  const start = prev === undefined ? 0 : Number(prev);
  const addresses = registry.contracts.map((e) => bytea(e.address));
  await c.query("delete from canton_registry where address <> all($1::bytea[])", [addresses]);
  if (registry.contracts.length > 0) {
    await c.query(
      `insert into canton_registry (address, kind, code_hash, admin, legs_cursor, ledger_offset, read_at)
       select e.address, e.kind, e.code_hash, $4, $5, $6, now() from unnest($1::bytea[], $2::text[], $3::bytea[]) as e(address, kind, code_hash)
       on conflict (address) do update set kind = excluded.kind, code_hash = excluded.code_hash, admin = excluded.admin, ledger_offset = excluded.ledger_offset, read_at = excluded.read_at`,
      [addresses, registry.contracts.map((e) => e.kind), registry.contracts.map((e) => bytea(e.codeHash)), registry.gatewayParty, start, offset],
    );
  }
  await c.query("insert into meta (key, value) values ('registry_read_block', $1) on conflict (key) do update set value = excluded.value", [String(block)]);
}
