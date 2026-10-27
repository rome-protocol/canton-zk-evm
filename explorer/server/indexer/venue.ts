import type { Pool, PoolClient } from "pg";
import type { Ledger, VenueUpdate } from "../ledger.ts";

const bytea = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");

/** The newest creation of each key: the one with the highest offset, and the later one of two in the same update. */
function newest<T extends { offset: number }>(rows: T[], key: (r: T) => string): T[] {
  const kept = new Map<string, T>();
  for (const r of rows) {
    const k = key(r), old = kept.get(k);
    if (!old || r.offset >= old.offset) kept.set(k, r);
  }
  return [...kept.values()];
}

/** One page of the gateway party's walk, written: the registered tokens first, so that a trade or a claim in the same page finds its instrument. */
async function writePage(c: PoolClient, updates: VenueUpdate[]): Promise<void> {
  // One statement cannot change a row twice, and a payment id or a claim id can be created more than once in a page (an offer made again under the same label, a retry, a replay from the
  // start after a move): each id is kept once, as the newest of its creations, which is the last one in offset order.
  const tokens = updates.flatMap((u) => u.tokens);
  const trades = [...newest(updates.flatMap((u) => u.trades.map((t) => ({ ...t, updateId: u.updateId, offset: u.offset }))), (t) => t.payId)];
  const claims = [...newest(updates.flatMap((u) => u.claims.map((x) => ({ ...x, updateId: u.updateId, offset: u.offset }))), (x) => x.claimId)];
  if (tokens.length > 0) {
    await c.query(
      `insert into canton_gateway_tokens (contract_id, evm_token, instrument_admin, instrument_id)
       select * from unnest($1::text[], $2::bytea[], $3::text[], $4::text[]) on conflict (contract_id) do nothing`,
      [tokens.map((t) => t.contractId), tokens.map((t) => bytea(t.evmToken)), tokens.map((t) => t.instrumentAdmin), tokens.map((t) => t.instrumentId)],
    );
  }
  // A trade offered again under the same label has the same payment id: the newest offer is the one kept. The payment that settled it stays matched while the terms are the same.
  if (trades.length > 0) {
    await c.query(
      `insert into canton_venue_trades as vt (pay_id, claim_id, token, payee, recipient, evm_amount, gateway_token, offered_update_id)
       select * from unnest($1::bytea[], $2::bytea[], $3::bytea[], $4::bytea[], $5::bytea[], $6::numeric[], $7::text[], $8::text[])
       on conflict (pay_id) do update set claim_id = excluded.claim_id, token = excluded.token, payee = excluded.payee, recipient = excluded.recipient, evm_amount = excluded.evm_amount,
         gateway_token = excluded.gateway_token, offered_update_id = excluded.offered_update_id,
         payment_block = case when vt.token = excluded.token and vt.payee = excluded.payee and vt.evm_amount = excluded.evm_amount then vt.payment_block end,
         payment_leg_index = case when vt.token = excluded.token and vt.payee = excluded.payee and vt.evm_amount = excluded.evm_amount then vt.payment_leg_index end`,
      [trades.map((t) => bytea(t.payId)), trades.map((t) => bytea(t.claimId)), trades.map((t) => bytea(t.token)), trades.map((t) => bytea(t.payee)), trades.map((t) => bytea(t.recipient)),
        trades.map((t) => t.amount.toString()), trades.map((t) => t.gatewayToken), trades.map((t) => t.updateId)],
    );
  }
  if (claims.length > 0) {
    await c.query(
      `insert into canton_funded_claims (claim_id, recipient, amount, gateway_token, funded_update_id)
       select * from unnest($1::bytea[], $2::bytea[], $3::numeric[], $4::text[], $5::text[])
       on conflict (claim_id) do update set recipient = excluded.recipient, amount = excluded.amount, gateway_token = excluded.gateway_token, funded_update_id = excluded.funded_update_id`,
      [claims.map((x) => bytea(x.claimId)), claims.map((x) => bytea(x.recipient)), claims.map((x) => x.amount.toString()), claims.map((x) => x.gatewayToken), claims.map((x) => x.updateId)],
    );
  }
}

/**
 * The payment that settled each trade, among the indexed legs: the first payment leg of the trade's id that pays what the trade says (its token, to its payee, for its amount), as the
 * builder settles a request only when its terms match. A payment under the id that pays something else is not the trade's, so it is no swap. Run after every read, because a payment's
 * block is indexed on its own time.
 */
export async function matchPayments(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(
    `update canton_venue_trades vt set payment_block = m.block_number, payment_leg_index = m.leg_index
     from (select t.pay_id, g.block_number, g.leg_index from canton_venue_trades t
             cross join lateral (select block_number, leg_index from gateway_legs
               where kind = 3 and leg_id = t.pay_id and token = t.token and account = t.payee and amount = t.evm_amount order by block_number, leg_index limit 1) g
            where t.payment_block is null) m
     where vt.pay_id = m.pay_id`,
  );
}

const setCursor = (c: PoolClient, participantId: string, offset: number) => c.query(
  `insert into canton_venue_cursor (participant_id, ledger_offset, read_at) values ($1, $2, now())
   on conflict (only_row) do update set participant_id = excluded.participant_id, ledger_offset = excluded.ledger_offset, read_at = excluded.read_at`,
  [participantId, offset],
);

/**
 * One read of the Canton side of the swaps: the registered tokens, the venue trades and the funded claims that the gateway party sees, from where the last read stopped up to the
 * Canton record of the newest indexed block (the same bound and the same participant check as the custody read: offsets are local to a participant, so a cursor of another participant
 * starts the walk again, which writes the same rows). A trade is offered before its payment is in a block, and its settlement (the funded claim) is created by the block's own Canton
 * update, so everything a leg of an indexed block can be matched to is at or below that offset. Each page and its cursor are written in one transaction, so a read that fails keeps
 * what it has written and the next one goes on from there. Only the contracts of this chain are read (`chainId`). What is kept is what the EVM side knows (see `VenueTradeFact`); the venue's and the seller's party are never read.
 */
export async function venueOnce(pool: Pick<Pool, "connect" | "query">, ledger: Pick<Ledger, "venuePages">, participantId: string, chainId: number): Promise<{ trades: number; claims: number; tokens: number; offset: number | null }> {
  const [at] = (await pool.query(
    "select u.reader_offset, (p.participant_id = $1 and p.moved_out_at is null) as current from blocks b join canton_updates u on u.update_id = b.update_id join canton_participants p on p.id = u.participant order by b.number desc limit 1",
    [participantId],
  )).rows;
  if (!at || !at.current) return { trades: 0, claims: 0, tokens: 0, offset: null };
  const upTo = Number(at.reader_offset);
  const [cursor] = (await pool.query("select participant_id, ledger_offset from canton_venue_cursor")).rows;
  const from = cursor && cursor.participant_id === participantId ? Number(cursor.ledger_offset) : 0;
  const done = { trades: 0, claims: 0, tokens: 0 };
  if (from >= upTo) {
    await matchPayments(pool);
    return { ...done, offset: from };
  }
  for await (const page of ledger.venuePages(from, upTo, chainId)) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await writePage(c, page.updates);
      await setCursor(c, participantId, page.offset);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    for (const u of page.updates) { done.tokens += u.tokens.length; done.trades += u.trades.length; done.claims += u.claims.length; }
  }
  // The walk ended on an empty answer: nothing more is there up to the record's offset.
  const c = await pool.connect();
  try {
    await setCursor(c, participantId, upTo);
  } finally {
    c.release();
  }
  await matchPayments(pool);
  return { ...done, offset: upTo };
}
