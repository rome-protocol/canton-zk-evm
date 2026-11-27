/**
 * The reads behind `GET /api/canton/deposits` and `GET /api/canton/payouts/{id}`: the gateway's open receipts (deposits it accepted that their EVM recipient has not claimed yet) and its payouts (withdrawals it owes),
 * from what the indexer keeps (`gateway_receipts`, `gateway_payouts`, `gateway_offers`). No chain or ledger is read here, and nothing here writes. Each row names its wrapped token; no Canton party is in a row.
 */
import { CUSTODY_DECIMALS, hex } from "./rest/chain-rest.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Query = (sql: string, values?: unknown[]) => Promise<Row[]>;

/** The most deposits one recipient's list holds: a recipient with more open receipts than this sees the newest. */
export const DEPOSITS_MAX = 100;

export interface DepositItem { depositId: string; token: string; symbol: string | null; instrumentId: string | null; amount: string; amountDecimals: number; createdAt: string }
/** `waiting` (owed, not offered), `offered` (an offer is open until `until`) or `paid` (`paidAt`). */
export interface PayoutStatus { id: string; status: "waiting" | "offered" | "paid"; token: string; symbol: string | null; instrumentId: string | null; amount: string; amountDecimals: number; createdAt: string; until: string | null; paidAt: string | null }

const iso = (v: string | Date | null): string | null => (v === null ? null : new Date(v).toISOString());
const named = "left join gateway_tokens g on r.erc20 = g.evm_token left join tokens tk on tk.address = r.erc20";

export function createReceiptsRest(query: Query) {
  /** The open receipts for one EVM address (lowercase, 0x and 40 hex digits), newest first. */
  async function deposits(recipient: string): Promise<DepositItem[]> {
    const rows = await query(
      `select r.deposit_id, r.erc20, r.amount::text as amount, r.created_at, g.instrument_id, tk.symbol from gateway_receipts r ${named} where r.recipient = $1 and r.archived_offset is null order by r.created_at desc, r.deposit_id limit $2`,
      [Buffer.from(recipient.slice(2), "hex"), DEPOSITS_MAX],
    );
    return rows.map((r): DepositItem => ({ depositId: hex(r.deposit_id), token: hex(r.erc20), symbol: r.symbol ?? null, instrumentId: r.instrument_id ?? null, amount: r.amount, amountDecimals: CUSTODY_DECIMALS, createdAt: iso(r.created_at)! }));
  }

  /** One payout by its id (0x and 64 hex digits): the withdrawal's id, or the deposit's id for a receipt that was returned. Null when the gateway has none with that id. */
  async function payout(id: string): Promise<PayoutStatus | null> {
    const [r] = await query(
      `select r.payout_id, r.erc20, r.amount::text as amount, r.created_at, r.paid_at, g.instrument_id, tk.symbol, (select max(o.execute_before) from gateway_offers o where o.payout_id = r.payout_id) as until
       from gateway_payouts r ${named} where r.payout_id = $1 order by r.created_at desc limit 1`,
      [Buffer.from(id.slice(2), "hex")],
    );
    if (!r) return null;
    const paidAt = iso(r.paid_at), until = paidAt === null ? iso(r.until) : null;
    return { id: hex(r.payout_id), status: paidAt !== null ? "paid" : until !== null ? "offered" : "waiting", token: hex(r.erc20), symbol: r.symbol ?? null, instrumentId: r.instrument_id ?? null, amount: r.amount, amountDecimals: CUSTODY_DECIMALS, createdAt: iso(r.created_at)!, until, paidAt };
  }

  return { deposits, payout };
}
