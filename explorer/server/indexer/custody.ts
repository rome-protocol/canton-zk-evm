import type { Pool } from "pg";
import type { Ledger } from "../ledger.ts";

const bytea = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");

/**
 * One custody read: the gateway's registered tokens and what it holds of each instrument (`ledger.gatewayCustody`, read as the gateway), written as the
 * whole of the table in one transaction, so a reader sees one read or the one before. A read that fails writes nothing and the last rows stay, with the
 * time they were read at. A token that is no longer registered is dropped; with no token registered the table is empty.
 */
export async function custodyOnce(pool: Pick<Pool, "connect">, ledger: Pick<Ledger, "gatewayCustody">, limit: number): Promise<{ tokens: number; offset: number }> {
  const { offset, tokens } = await ledger.gatewayCustody(limit);
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("delete from gateway_tokens where evm_token <> all($1::bytea[])", [tokens.map((t) => bytea(t.evmToken))]);
    if (tokens.length > 0) {
      await c.query(
        `insert into gateway_tokens (evm_token, instrument_admin, instrument_id, custody, holdings, ledger_offset, read_at)
         select t.token, t.admin, t.id, t.custody::numeric, t.holdings, $6::bigint, now() from unnest($1::bytea[], $2::text[], $3::text[], $4::text[], $5::int[]) as t(token, admin, id, custody, holdings)
         on conflict (evm_token) do update set instrument_admin = excluded.instrument_admin, instrument_id = excluded.instrument_id, custody = excluded.custody,
           holdings = excluded.holdings, ledger_offset = excluded.ledger_offset, read_at = excluded.read_at`,
        [tokens.map((t) => bytea(t.evmToken)), tokens.map((t) => t.instrumentAdmin), tokens.map((t) => t.instrumentId), tokens.map((t) => t.custody.toString()), tokens.map((t) => t.holdings), offset],
      );
    }
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return { tokens: tokens.length, offset };
}
