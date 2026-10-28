import { keccak256 } from "viem";
import type { Pool } from "pg";

const hex = (b: Buffer): string => "0x" + b.toString("hex");
export const LEG_KINDS = ["", "deposit", "withdrawal", "payment"] as const;
/** The vault's `Released(bytes32 indexed id, address indexed token, address indexed to, uint256 amount, string ref)` event: what shows that a payment of a gateway came out of the vault (gateway/Vault.sol). */
export const RELEASED_TOPIC = keccak256(new TextEncoder().encode("Released(bytes32,address,address,uint256,string)"));
const PAD = "000000000000000000000000";

/**
 * The twin legs, told by one join each, and only for a token the chain record pins as a twin (`canton_twins`: Daml takes a lock or a release for no other token). A payment INTO a registered vault is a
 * lock (an EVM token becomes its Canton twin) unless a venue's trade is behind it (that payment is a swap's, and no twin was minted); a payment OUT of one is a release (the twin is burnt and the vault
 * pays): the gateway's payment leg has the payee and not the payer, so a release is the payment that has a `Released` event of a registered vault in the same block, for the same id, token and payee.
 * `rv` is the vault a lock paid; `rl` is set for a release. Every other leg joins to nothing. `tw.decimals` is the decimals the twin is minted with on Canton, for the twin's amount (10 decimals).
 */
export const TWIN_FROM = `left join canton_twins tw on g.kind = 3 and tw.token = g.token
  left join canton_venue_trades tvt on tw.token is not null and tvt.payment_block = g.block_number and tvt.payment_leg_index = g.leg_index
  left join canton_registry rv on rv.kind = 'vault' and tw.token is not null and tvt.pay_id is null and rv.address = g.account
  left join lateral (select 1 as one from logs l join canton_registry v on v.kind = 'vault' and v.address = l.address
    where tw.token is not null and l.block_number = g.block_number and l.topic0 = decode('${RELEASED_TOPIC.slice(2)}', 'hex') and l.topic1 = g.leg_id
      and l.topic2 = decode('${PAD}', 'hex') || g.token and l.topic3 = decode('${PAD}', 'hex') || g.account limit 1) rl on true`;
export const TWIN_FLAGS = "(rv.address is not null and rl.one is null) as is_lock, (rl.one is not null) as is_release";
export const TWIN_SELECT = `${TWIN_FLAGS},
  trunc(case when rv.address is null and rl.one is null then null when tw.decimals >= 10 then div(g.amount, power(10::numeric, tw.decimals - 10)) else g.amount * power(10::numeric, 10 - tw.decimals) end)::text as twin_amount,
  (select admin from canton_registry order by address limit 1) as twin_admin`;
/** The kind of a leg is the gateway's own (deposit, withdrawal, payment); a twin leg is a payment that is also a lock or a release, told apart by `twinOf`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const legKindOf = (r: any): string => LEG_KINDS[r.kind as 1 | 2 | 3] ?? String(r.kind);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const twinOf = (r: any): "lock" | "release" | null => (r.is_release ? "release" : r.is_lock ? "lock" : null);
/** The address of the gateway that recorded a leg; null for the chain's first gateway. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const gatewayOf = (r: any): string | null => (r.gateway ? hex(r.gateway) : null);

/**
 * What Canton shows of a leg, when the leg is one side of a swap: a payment that settled a Canton venue's trade (`venue-trade`, matched by its payment id) or a deposit that redeemed a
 * funded claim (`funded-claim`, matched by its claim id). `amount` is the Canton side's, in base units of 10 decimals, and is null until the funded claim has been read; the instrument is
 * the registered token's, from the trade until then. The settling Canton update is the block's own for a payment and the claim's, which an earlier block made, for a deposit.
 * A twin leg (role lock or release) shows the Canton twin of an ERC-20: `instrument` is `erc20:<token address>`, administered by the gateway party, and `amount` is the twin's, in base units of 10 decimals
 * (scaled with the decimals the chain record pins). `recipient` is the address the leg paid: the vault for a lock, the EVM payee for a release. The settling update is the block's own.
 * There is no party in it: the venue, the seller and the buyer's Canton side are never kept, and the viewer is shown "a Canton party".
 */
export interface LegCanton {
  role: "venue-trade" | "funded-claim" | "lock" | "release";
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
  /** The gateway that recorded the leg: null for the chain's first gateway, else the registered gateway's address. */
  gateway: string | null;
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
  left join canton_gateway_tokens ct on ct.contract_id = coalesce(fc.gateway_token, vt.gateway_token)
  ${TWIN_FROM}`;
export const LEG_CANTON_SELECT = `g.block_number, g.leg_index, g.tx_index, g.log_index, g.kind, g.leg_id, g.token, g.account, g.amount::text as amount, g.gateway, t.hash as tx_hash, b.update_id,
  (vt.pay_id is not null) as is_trade, (fc.claim_id is not null and (g.kind = 3 or g.token = ct.evm_token)) as is_claim, fc.amount::text as canton_amount, fc.funded_update_id, ct.instrument_admin, ct.instrument_id,
  coalesce(fc.recipient, vt.recipient) as recipient, ${TWIN_SELECT}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function blockLegOf(r: any): BlockLeg {
  const twin = twinOf(r);
  const role = twin ?? (r.is_trade ? "venue-trade" : r.is_claim && r.kind === 1 ? "funded-claim" : null);
  return {
    block: Number(r.block_number), legIndex: r.leg_index, txIndex: r.tx_index, logIndex: r.log_index, kind: legKindOf(r), gateway: gatewayOf(r), legId: hex(r.leg_id), token: hex(r.token), account: hex(r.account),
    amount: r.amount, txHash: r.tx_hash ? hex(r.tx_hash) : null, updateId: r.update_id ?? null,
    canton: twin ? {
      role: twin, amount: r.twin_amount ?? null, instrument: r.twin_admin ? { admin: r.twin_admin, id: `erc20:${hex(r.token).slice(2)}` } : null, settledUpdateId: r.update_id ?? null, recipient: hex(r.account),
    } : role && {
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
