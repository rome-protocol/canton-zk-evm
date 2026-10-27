import type { Pool } from "pg";

const hex = (b: Buffer): string => "0x" + b.toString("hex");
export const LEG_KINDS = ["", "deposit", "withdrawal", "payment"] as const;

/**
 * What Canton shows of a leg, when the leg is one side of a swap: a payment that settled a Canton venue's trade (`venue-trade`, matched by its payment id) or a deposit that redeemed a
 * funded claim (`funded-claim`, matched by its claim id). `amount` is the Canton side's, in base units of 10 decimals, and is null until the funded claim has been read; the instrument is
 * the registered token's, from the trade until then. The settling Canton update is the block's own for a payment and the claim's, which an earlier block made, for a deposit.
 * There is no party in it: the venue, the seller and the buyer's Canton side are never kept, and the viewer is shown "a Canton party".
 */
export interface LegCanton {
  role: "venue-trade" | "funded-claim";
  amount: string | null;
  instrument: { admin: string; id: string } | null;
  /** The Canton update that created the funded claim (the block that settled the trade); null while it has not been read. */
  settledUpdateId: string | null;
  /** The EVM address that claims, or claimed, the wrapped token. */
  recipient: string;
}

/** A leg of a block as the gateway recorded it, with its transaction, its block's Canton update and what Canton shows of it. A withdrawal's Canton party is not part of it. */
export interface BlockLeg {
  block: number;
  legIndex: number;
  txIndex: number;
  logIndex: number;
  kind: string;
  legId: string;
  token: string;
  account: string;
  amount: string;
  txHash: string | null;
  updateId: string | null;
  canton: LegCanton | null;
}

/**
 * A leg's own columns and the Canton side of its swap, by one join, matched the way the builder matches a request. A payment is the one that settled the trade whose `payment_block` and
 * `payment_leg_index` are its own (the venue read sets them for the first payment of the trade's id that pays the trade's token, to its payee, for its amount); the trade's claim then
 * follows. A deposit redeems the funded claim of its id only when it is for the claim's recipient, for the claim's amount and in the registered token of the claim: any party can sign a deposit under a claim's id,
 * and one that is for somebody else is a plain deposit. The claim's token to its instrument.
 */
export const LEG_CANTON_FROM = `from gateway_legs g
  left join blocks b on b.number = g.block_number
  left join transactions t on t.block_number = g.block_number and t.tx_index = g.tx_index
  left join canton_venue_trades vt on g.kind = 3 and vt.payment_block = g.block_number and vt.payment_leg_index = g.leg_index
  left join canton_funded_claims fc on fc.claim_id = case g.kind when 3 then vt.claim_id when 1 then g.leg_id end and (g.kind = 3 or (g.account = fc.recipient and g.amount = fc.amount))
  left join canton_gateway_tokens ct on ct.contract_id = coalesce(fc.gateway_token, vt.gateway_token)`;
export const LEG_CANTON_SELECT = `g.block_number, g.leg_index, g.tx_index, g.log_index, g.kind, g.leg_id, g.token, g.account, g.amount::text as amount, t.hash as tx_hash, b.update_id,
  (vt.pay_id is not null) as is_trade, (fc.claim_id is not null and (g.kind = 3 or g.token = ct.evm_token)) as is_claim, fc.amount::text as canton_amount, fc.funded_update_id, ct.instrument_admin, ct.instrument_id,
  coalesce(fc.recipient, vt.recipient) as recipient`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function blockLegOf(r: any): BlockLeg {
  const role = r.is_trade ? "venue-trade" : r.is_claim && r.kind === 1 ? "funded-claim" : null;
  return {
    block: Number(r.block_number), legIndex: r.leg_index, txIndex: r.tx_index, logIndex: r.log_index, kind: LEG_KINDS[r.kind as 1 | 2 | 3] ?? String(r.kind), legId: hex(r.leg_id), token: hex(r.token), account: hex(r.account),
    amount: r.amount, txHash: r.tx_hash ? hex(r.tx_hash) : null, updateId: r.update_id ?? null,
    canton: role && {
      role, amount: r.canton_amount ?? null, instrument: r.instrument_id ? { admin: r.instrument_admin, id: r.instrument_id } : null, settledUpdateId: r.funded_update_id ?? null, recipient: hex(r.recipient),
    },
  };
}

/** The legs a block recorded, in the order of the block's running hash, each with what Canton shows of its swap: all of them, or at most `limit` after the leg index `after`. */
export async function blockLegs(pool: Pick<Pool, "query">, number: number, { after = null, limit = null }: { after?: number | null; limit?: number | null } = {}): Promise<BlockLeg[]> {
  const { rows } = await pool.query(
    `select ${LEG_CANTON_SELECT} ${LEG_CANTON_FROM} where g.block_number = $1 and ($2::int is null or g.leg_index > $2) order by g.leg_index limit $3`,
    [number, after, limit],
  );
  return rows.map(blockLegOf);
}

/** The legs a transaction caused, in the same form: all of them, or the first `limit` (one contract call can make many legs). */
export async function txLegs(pool: Pick<Pool, "query">, txHash: string, limit: number | null = null): Promise<BlockLeg[]> {
  const { rows } = await pool.query(
    `select ${LEG_CANTON_SELECT} ${LEG_CANTON_FROM} where (g.block_number, g.tx_index) in (select block_number, tx_index from tx_hashes where hash = $1) order by g.block_number, g.leg_index limit $2`,
    [Buffer.from(txHash.replace(/^0x/, ""), "hex"), limit],
  );
  return rows.map(blockLegOf);
}
