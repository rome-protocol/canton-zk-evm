import type { Pool } from "pg";
import type { Ledger } from "../ledger.ts";
import type { FinalReads } from "./reads.ts";
import { SELECTORS, tryCall } from "./tokens.ts";

const bytea = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");
const uint = (output: string | null): bigint | null => (output !== null && /^0x[0-9a-f]{64}$/.test(output) ? BigInt(output) : null);

/**
 * One custody read, of the gateway's registered tokens and what it holds of each instrument, set against each token's supply at the SAME block. The newest indexed
 * block B of the current participant and the ledger offset of its Canton record are taken first; the holdings are read as the gateway at that offset (`ledger.gatewayCustody`) and each token's
 * `totalSupply()` at B (reth). A block's record and its legs are one Canton update, so the custody at that offset is the custody after exactly the legs up to B, the
 * same legs the supply at B counts: a deposit that lands later is in neither number. The rows are written as the whole of the table in one transaction, so a reader sees
 * one read or the one before. A read that fails writes nothing and the last rows stay, with the time they were read at. A token that is no longer registered is
 * dropped; with no token registered the table is empty. With no block indexed yet, or none whose record is on the participant now read (offsets are local to a participant, so after a reader move an older participant's offset means nothing here), there is nothing to read at, and nothing is written.
 */
export async function custodyOnce(pool: Pick<Pool, "connect" | "query">, ledger: Pick<Ledger, "gatewayCustody">, reads: Pick<FinalReads, "call">, limit: number): Promise<{ tokens: number; offset: number; block: number | null }> {
  const [at] = (await pool.query("select b.number, u.reader_offset from blocks b join canton_updates u on u.update_id = b.update_id join canton_participants p on p.id = u.participant where p.moved_out_at is null order by b.number desc limit 1")).rows;
  if (!at) return { tokens: 0, offset: 0, block: null };
  const block = Number(at.number), offset = Number(at.reader_offset);
  const { tokens } = await ledger.gatewayCustody(limit, offset);
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
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return { tokens: tokens.length, offset, block };
}
