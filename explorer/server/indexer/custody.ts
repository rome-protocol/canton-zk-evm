import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ChainRegistry, Ledger, RegisteredToken } from "../ledger.ts";
import type { FinalReads } from "./reads.ts";
import { SELECTORS, tryCall } from "./tokens.ts";

const bytea = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");
/** A contract is kept by the SHA-256 of its id, so that its id is never stored. */
const contractHash = (id: string): Buffer => createHash("sha256").update(id).digest();
const uint = (output: string | null): bigint | null => (output !== null && /^0x[0-9a-f]{64}$/.test(output) ? BigInt(output) : null);

/**
 * One custody read, of the gateway's registered tokens and what it holds of each instrument, set against each token's supply at the SAME block. The newest indexed
 * block B is taken first, with the ledger offset of its Canton record; it is read only if its record is on the participant now read (`participantId`, the one the reader client
 * reports, and not marked as moved out). The registered tokens are read as the gateway at that offset (`ledger.gatewayTokens`), the holdings are brought up to that offset by the walk of the Canton
 * updates (`syncHoldings`) and each token's `totalSupply()` is read at B (reth). A block's record and its legs are one Canton update, so the custody at that offset is the custody after exactly the legs up
 * to B, the same legs the supply at B counts: a deposit that lands later is in neither number. The rows are written as the whole of the table in one transaction, so a reader sees one read or the one
 * before. A read that fails writes nothing and the last rows stay, with the time they were read at. A token that is no longer registered is dropped; with no token registered the table is empty. With no
 * block indexed yet, or the newest block's record not on the participant now read (offsets are local to a participant, so after a reader move the older participant's offset means nothing here, and it stays
 * so until the new participant has indexed a block), there is nothing to read at, and nothing is written. The registry (the chain record) is read and kept apart from this: a registry that cannot be read does not stop
 * the custody, and the custody that cannot be read does not stop the registry; the registry's failure is returned as `registryError` for the caller to say.
 */
export async function custodyOnce(pool: Pick<Pool, "connect" | "query">, ledger: Pick<Ledger, "gatewayTokens" | "holdingPages" | "chainRegistry">, reads: Pick<FinalReads, "call">, limit: number, participantId: string, chainId: number | null = null): Promise<{ tokens: number; holdings: number; offset: number; block: number | null; registryError: string | null }> {
  const [at] = (await pool.query(
    "select b.number, u.reader_offset, (p.participant_id = $1 and p.moved_out_at is null) as current from blocks b join canton_updates u on u.update_id = b.update_id join canton_participants p on p.id = u.participant order by b.number desc limit 1",
    [participantId],
  )).rows;
  if (!at || !at.current) return { tokens: 0, holdings: 0, offset: 0, block: null, registryError: null };
  const block = Number(at.number), offset = Number(at.reader_offset);
  // The registry is read, and kept, before the holdings: it is a request of its own, so the holdings (which grow with every user) cannot cut it short or fail it, and its failure does not stop the custody.
  let registryError: string | null = null;
  if (chainId !== null) {
    try {
      const registry = await ledger.chainRegistry(chainId, offset);
      if (registry) {
        const r = await pool.connect();
        try {
          await r.query("begin");
          await writeRegistry(r, registry, offset, block);
          await r.query("commit");
        } catch (e) {
          await r.query("rollback").catch(() => undefined);
          throw e;
        } finally {
          r.release();
        }
      }
    } catch (e) {
      registryError = (e as Error).message;
    }
  }
  const tokens = await ledger.gatewayTokens(limit, offset);
  await syncHoldings(pool, ledger, participantId, offset, tokens);
  const held = new Map<string, { custody: bigint; holdings: number }>();
  for (const r of (await pool.query("select instrument_admin, instrument_id, sum(amount)::text as custody, count(*)::int as holdings from gateway_holdings group by 1, 2")).rows) {
    held.set(JSON.stringify([r.instrument_admin, r.instrument_id]), { custody: BigInt(r.custody), holdings: r.holdings });
  }
  // What is open for each wrapped ERC-20: its receipts (accepted, not yet claimed) and its payouts not yet paid.
  const open = new Map<string, { receipts: string; payouts: string }>();
  for (const r of (await pool.query(
    `select encode(erc20, 'hex') as t, coalesce(sum(amount) filter (where k = 'r'), 0)::text as receipts, coalesce(sum(amount) filter (where k = 'p'), 0)::text as payouts from
       (select erc20, amount, 'r' as k from gateway_receipts union all select erc20, amount, 'p' from gateway_payouts where paid_at is null) o group by 1`)).rows) open.set("0x" + r.t, r);
  const rows = tokens.map((t) => ({ ...t, ...(held.get(JSON.stringify([t.instrumentAdmin, t.instrumentId])) ?? { custody: 0n, holdings: 0 }), ...(open.get(t.evmToken) ?? { receipts: "0", payouts: "0" }) }));
  const supplies = await Promise.all(rows.map(async (t) => uint(await tryCall(reads, t.evmToken, SELECTORS.totalSupply, block))));
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("delete from gateway_tokens where evm_token <> all($1::bytea[])", [rows.map((t) => bytea(t.evmToken))]);
    if (rows.length > 0) {
      await c.query(
        `insert into gateway_tokens (evm_token, instrument_admin, instrument_id, custody, holdings, supply, supply_block, ledger_offset, read_at, open_receipts, open_payouts)
         select t.token, t.admin, t.id, t.custody::numeric, t.holdings, t.supply::numeric, $7::bigint, $6::bigint, now(), t.receipts::numeric, t.payouts::numeric
           from unnest($1::bytea[], $2::text[], $3::text[], $4::text[], $5::int[], $8::text[], $9::text[], $10::text[]) as t(token, admin, id, custody, holdings, supply, receipts, payouts)
         on conflict (evm_token) do update set instrument_admin = excluded.instrument_admin, instrument_id = excluded.instrument_id, custody = excluded.custody,
           holdings = excluded.holdings, supply = excluded.supply, supply_block = excluded.supply_block, ledger_offset = excluded.ledger_offset, read_at = excluded.read_at,
           open_receipts = excluded.open_receipts, open_payouts = excluded.open_payouts`,
        [rows.map((t) => bytea(t.evmToken)), rows.map((t) => t.instrumentAdmin), rows.map((t) => t.instrumentId), rows.map((t) => t.custody.toString()), rows.map((t) => t.holdings), offset, block,
          supplies.map((v) => (v === null ? null : v.toString())), rows.map((t) => t.receipts), rows.map((t) => t.payouts)],
      );
    }
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return { tokens: rows.length, holdings: rows.reduce((n, t) => n + t.holdings, 0), offset, block, registryError };
}

/**
 * Brings `gateway_holdings` (the holdings the gateway owns, a contract kept by the hash of its id) up to ledger offset `offset`, by the walk of the Canton updates after the offset the last walk reached, a page and
 * its cursor to a transaction, so that a walk that stops anywhere goes on from the cursor. The walk is of pages of any count, so that no number of holdings the gateway party can see (twin holdings of every user
 * among them) cuts or fails the read. Offsets are local to a participant: a table that was walked on another participant, or to an offset past this one, is forgotten and walked again from the start.
 */
export async function syncHoldings(pool: Pick<Pool, "connect" | "query">, ledger: Pick<Ledger, "holdingPages">, participantId: string, offset: number, tokens: Pick<RegisteredToken, "contractId" | "evmToken">[] = []): Promise<void> {
  const evm = new Map(tokens.map((t) => [t.contractId, bytea(t.evmToken)]));
  const meta = new Map<string, string>((await pool.query("select key, value from meta where key in ('holdings_participant', 'holdings_offset')")).rows.map((r) => [r.key, r.value]));
  let from = meta.get("holdings_participant") === participantId ? Number(meta.get("holdings_offset") ?? 0) : 0;
  if (from > offset) from = 0;
  const setCursor = (c: Pick<PoolClient, "query">, at: number) => c.query(
    "insert into meta (key, value) select * from unnest($1::text[], $2::text[]) on conflict (key) do update set value = excluded.value", [["holdings_participant", "holdings_offset"], [participantId, String(at)]]);
  if (from === 0 && meta.size > 0) {
    // A fresh start: nothing of an older walk stays.
    const r = await pool.connect();
    try {
      await r.query("begin");
      for (const t of ["gateway_holdings", "gateway_receipts", "gateway_payouts", "gateway_offers"]) await r.query(`delete from ${t}`);
      await setCursor(r, 0);
      await r.query("commit");
    } catch (e) {
      await r.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      r.release();
    }
  }
  for await (const page of ledger.holdingPages(from, offset)) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      for (const ch of page.changes) {
        if (ch.kind === "archived") {
          // One statement for every table a contract may be in: a payout stays, with the time it was paid.
          await c.query(
            `with h as (delete from gateway_holdings where contract_hash = $1), r as (delete from gateway_receipts where contract_hash = $1), o as (delete from gateway_offers where contract_hash = $1)
             update gateway_payouts set paid_at = $2 where contract_hash = $1`, [contractHash(ch.contractId), ch.at]);
        } else if (ch.kind === "receipt" || ch.kind === "payout") {
          const erc20 = evm.get(ch.gatewayToken);
          if (!erc20) continue; // a token no longer registered has no custody row, so no total depends on it
          if (ch.kind === "receipt") await c.query("insert into gateway_receipts (contract_hash, erc20, deposit_id, recipient, amount, created_at) values ($1, $2, $3, $4, $5, $6) on conflict do nothing", [contractHash(ch.contractId), erc20, bytea(ch.depositId), bytea(ch.recipient), ch.amount.toString(), ch.createdAt]);
          else await c.query("insert into gateway_payouts (contract_hash, erc20, payout_id, amount, created_at) values ($1, $2, $3, $4, $5) on conflict do nothing", [contractHash(ch.contractId), erc20, bytea(ch.payoutId), ch.amount.toString(), ch.createdAt]);
        } else if (ch.kind === "offer") await c.query("insert into gateway_offers (contract_hash, payout_id, execute_before) values ($1, $2, $3) on conflict do nothing", [contractHash(ch.contractId), bytea(ch.payoutId), ch.executeBefore]);
        else await c.query(
          "insert into gateway_holdings (contract_hash, instrument_admin, instrument_id, amount) values ($1, $2, $3, $4) on conflict (contract_hash) do update set instrument_admin = excluded.instrument_admin, instrument_id = excluded.instrument_id, amount = excluded.amount",
          [contractHash(ch.contractId), ch.instrumentAdmin, ch.instrumentId, ch.amount.toString()]);
      }
      await setCursor(c, page.offset);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  // The walk ended on an empty answer: nothing more is there up to `offset`.
  await setCursor(pool, offset);
}

/**
 * The chain record's registry as the read at `block` found it, written as the whole of `canton_registry` (this version of the chain has no removal, so a row that is gone means another chain
 * record, and goes). An entry the read has not seen before starts its leg index at the block of the read before (an entry was not there then, so none of its legs were, up to that block), or at 0
 * when no read was made: a gateway registered long ago is read from its first leg. An entry seen before keeps its progress.
 */
export async function writeRegistry(c: Pick<PoolClient, "query">, registry: ChainRegistry, offset: number, block: number): Promise<void> {
  // An entry or a pin that was not there before changes which legs count (a vault or a pin: which legs are locks and releases; a gateway: its legs
  // from the block of the read before may lie below the block the sums are counted up to): the sums over the legs are counted again.
  const known = (await c.query("select kind || ':' || encode(address, 'hex') as k from canton_registry union all select 'pin:' || encode(token, 'hex') from canton_twins")).rows.map((r) => r.k as string);
  const next = [...registry.contracts.map((e) => e.kind + ":" + e.address.slice(2)), ...registry.twins.map((t) => "pin:" + t.token.slice(2))];
  if (next.some((k) => !known.includes(k)) || known.some((k) => !next.includes(k))) {
    await resetTwinTotals(c);
    // The legs of a block that were counted under the old registry may be classified differently now (a lock or a release is told by the vault and the pins): they are counted again.
    await c.query("update canton_updates set legs_done = false where legs_done");
  }
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
  const pins = registry.twins.map((t) => bytea(t.token));
  await c.query("delete from canton_twins where token <> all($1::bytea[])", [pins]);
  if (pins.length > 0) {
    await c.query(
      `insert into canton_twins (token, decimals, ledger_offset, read_at) select t.token, t.decimals, $3, now() from unnest($1::bytea[], $2::int[]) as t(token, decimals)
       on conflict (token) do update set decimals = excluded.decimals, ledger_offset = excluded.ledger_offset, read_at = excluded.read_at`,
      [pins, registry.twins.map((t) => t.decimals), offset],
    );
  }
  await c.query("insert into meta (key, value) values ('registry_read_block', $1) on conflict (key) do update set value = excluded.value", [String(block)]);
}

/** Forgets the twin sums and the lock and release legs counted with them, so that they are counted again from the first block (the next pass of `twinTotalsOnce`). */
export async function resetTwinTotals(c: Pick<PoolClient, "query">): Promise<void> {
  await c.query("delete from twin_legs");
  await c.query("delete from twin_totals");
  await c.query("delete from meta where key = 'twin_totals_block'");
}
