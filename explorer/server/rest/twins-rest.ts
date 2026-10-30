/**
 * The reads behind `GET /api/twins`: the chain record's registry (its vaults and pinned twins) with, for each twin, the numbers the token page's twin card has, the Canton tokens
 * with their custody read (the token page's custody card), and the newest lock and release legs. Everything is read from what the indexer already keeps (`canton_registry`,
 * `canton_twins`, `twin_totals`, `gateway_tokens`, the legs): no chain or ledger is read here. Nothing here writes.
 */
import { twinOf, TWIN_FLAGS, TWIN_FROM } from "../indexer/leg-canton.ts";
import { hex, hexOrNull } from "./chain-rest.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Query = (sql: string, values?: unknown[]) => Promise<Row[]>;

/** A Canton amount's own scale (Daml Numeric 10): the unit of a Canton token's custody. */
const CUSTODY_DECIMALS = 10;
/** How many of the newest lock and release legs are listed. */
export const TWIN_LEGS_MAX = 20;

export interface TwinVault { address: string; codeHash: string }
export interface TwinLine {
  token: string; symbol: string | null; name: string | null; decimals: number;
  /** What the twin has in issue: the locks less the releases, in the token's base units. */
  supply: string;
  /** What the registered vaults hold of the token at the block `through`; null where reth did not give it. */
  vaultBalance: string | null;
  /** True when the vaults hold exactly what the twin has in issue (both are of the block `through`); false when they differ or the balance is not known. */
  matched: boolean;
  locks: number; releases: number;
  /** The block the sums and the vaults' balance are counted to; null before the first pass. */
  through: number | null;
}
export interface TwinCanton {
  token: string; symbol: string | null; name: string | null; decimals: number | null;
  instrumentAdmin: string; instrumentId: string; custody: string; custodyDecimals: number; holdings: number;
  supply: string | null; supplyBlock: number;
  /** True when the wrapped supply equals the custody on Canton, both in the token's own decimals; null where the supply is not known. */
  matched: boolean | null;
  ledgerOffset: number; readAt: string;
}
export interface TwinLeg { block: number; txHash: string | null; legId: string; twin: "lock" | "release"; token: string; symbol: string | null; amount: string; updateId: string | null }
export interface TwinsOverview { through: number | null; vaults: TwinVault[]; twins: TwinLine[]; canton: TwinCanton[]; legs: TwinLeg[] }

/** A twin's supply (locks less releases), as a decimal string. */
export const twinSupplyOf = (locked: string, released: string): string => (BigInt(locked) - BigInt(released)).toString();

/** The vaults match the twin when both numbers are known and equal. */
export const twinMatched = (supply: string, vaultBalance: string | null): boolean => vaultBalance !== null && BigInt(vaultBalance) === BigInt(supply);

/**
 * A Canton token's custody is held in Canton's 10 decimals and its wrapped supply in the token's own: they match when the custody, cut to the token's decimals, is the supply.
 * Null when the supply or the decimals are not known.
 */
export function custodyMatched(custody: string, supply: string | null, decimals: number | null): boolean | null {
  if (supply === null || decimals === null) return null;
  const c = BigInt(custody);
  const scaled = decimals >= CUSTODY_DECIMALS ? c * 10n ** BigInt(decimals - CUSTODY_DECIMALS) : c / 10n ** BigInt(CUSTODY_DECIMALS - decimals);
  return scaled === BigInt(supply);
}

export function createTwinsRest(query: Query) {
  async function vaults(): Promise<TwinVault[]> {
    return (await query("select address, code_hash from canton_registry where kind = 'vault' order by address")).map((r) => ({ address: hex(r.address), codeHash: hex(r.code_hash) }));
  }

  /** Each pinned twin with its sums. A twin with no leg yet has supply 0 and no vault balance; `through` is the block of the last pass of the indexer. */
  async function twins(): Promise<{ through: number | null; lines: TwinLine[] }> {
    const [m] = await query("select value from meta where key = 'twin_totals_block'");
    const through = m?.value == null ? null : Number(m.value);
    const rows = await query(
      `select w.token, w.decimals, tk.symbol, tk.name, coalesce(t.locked, 0)::text as locked, coalesce(t.released, 0)::text as released, coalesce(t.locks, 0) as locks, coalesce(t.releases, 0) as releases,
         t.vault_balance::text as vault_balance
       from canton_twins w left join twin_totals t on t.token = w.token left join tokens tk on tk.address = w.token order by w.token`,
    );
    const lines = rows.map((r): TwinLine => {
      const supply = twinSupplyOf(r.locked, r.released), vaultBalance: string | null = r.vault_balance ?? null;
      return {
        token: hex(r.token), symbol: r.symbol ?? null, name: r.name ?? null, decimals: Number(r.decimals), supply, vaultBalance, matched: twinMatched(supply, vaultBalance),
        locks: Number(r.locks), releases: Number(r.releases), through,
      };
    });
    return { through, lines };
  }

  /** The Canton tokens the gateway registered, each with its custody on Canton and its wrapped supply, both read at one block. */
  async function canton(): Promise<TwinCanton[]> {
    const rows = await query(
      `select g.evm_token, g.instrument_admin, g.instrument_id, g.custody::text as custody, g.holdings, g.supply::text as supply, g.supply_block, g.ledger_offset, g.read_at, tk.symbol, tk.name, tk.decimals
       from gateway_tokens g left join tokens tk on tk.address = g.evm_token order by g.instrument_id, g.evm_token`,
    );
    return rows.map((r): TwinCanton => {
      const decimals = r.decimals == null ? null : Number(r.decimals), supply: string | null = r.supply ?? null;
      return {
        token: hex(r.evm_token), symbol: r.symbol ?? null, name: r.name ?? null, decimals, instrumentAdmin: r.instrument_admin, instrumentId: r.instrument_id, custody: r.custody, custodyDecimals: CUSTODY_DECIMALS,
        holdings: Number(r.holdings), supply, supplyBlock: Number(r.supply_block), matched: custodyMatched(r.custody, supply, decimals), ledgerOffset: Number(r.ledger_offset), readAt: new Date(r.read_at).toISOString(),
      };
    });
  }

  /**
   * The newest lock and release legs: the payment legs of a pinned twin token that paid into a registered vault (a lock) or came out of one (a release), told by the same join as the legs list.
   * The legs are picked newest first from the payments of the pinned tokens, and the read stops at the limit.
   */
  async function legs(limit = TWIN_LEGS_MAX): Promise<TwinLeg[]> {
    const rows = await query(
      `select g.block_number, g.leg_index, g.leg_id, g.token, g.amount::text as amount, t.hash, b.update_id, tk.symbol, ${TWIN_FLAGS}
       from (select * from gateway_legs where kind = 3 and token in (select token from canton_twins) order by block_number desc, leg_index desc) g
         left join transactions t on t.block_number = g.block_number and t.tx_index = g.tx_index
         left join blocks b on b.number = g.block_number
         left join tokens tk on tk.address = g.token ${TWIN_FROM}
       where rv.address is not null or rl.one is not null order by g.block_number desc, g.leg_index desc limit $1`,
      [limit],
    );
    return rows.map((r): TwinLeg => ({
      block: Number(r.block_number), txHash: hexOrNull(r.hash), legId: hex(r.leg_id), twin: twinOf(r)!, token: hex(r.token), symbol: r.symbol ?? null, amount: r.amount, updateId: r.update_id ?? null,
    }));
  }

  async function overview(): Promise<TwinsOverview> {
    const [v, t, c, l] = await Promise.all([vaults(), twins(), canton(), legs()]);
    return { through: t.through, vaults: v, twins: t.lines, canton: c, legs: l };
  }

  return { overview, vaults, twins, canton, legs };
}
