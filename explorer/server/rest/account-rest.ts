/**
 * The reads behind the REST routes of addresses, contracts, tokens and gateway legs (design 6.1), as the indexer's rows hold them. Nothing here writes.
 * Lists take a keyset (the parts of the last row's sort key) and a limit, and are asked for one row more than they show. Most of what is read here is written
 * by stage 2 (the counters, the contracts, the tokens and their transfers) or by the background check of balances behind it, so a list is complete only up to the
 * derive cursor: `derivedThrough` gives the cursor and the head, and the routes say so.
 */
import type { Pool } from "pg";
import { ChainDbError } from "../chain-db.ts";
import { gatewayOf, legKindOf, twinOf, TWIN_FROM, TWIN_SELECT } from "../indexer/leg-canton.ts";
import { addressOfKey, bytes, hex, hexOrNull, isoTime, MS, txSelect, US, type TxListItem, txItem, withTokenMoves } from "./chain-rest.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Key = (number | string)[];
/** A Canton amount's own scale (Daml Numeric 10): the unit of `canton.custody`. */
const CUSTODY_DECIMALS = 10;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * A swap a Canton venue made with the EVM: the venue's trade, settled by the buyer's payment in a block (its Canton update made the funded claim), and, once the buyer has claimed the
 * wrapped token, the deposit that redeemed it. Canton parties are never part of it: `canton.recipient` is the EVM address that claims. `canton.amount` is null until the funded claim has been read, and the
 * instrument is the registered token's, from the trade, until then.
 */
export interface SwapEvm { token: string; symbol: string | null; decimals: number | null; payer: string | null; payee: string; amount: string }
export interface SwapCanton { amount: string | null; instrument: { admin: string; id: string } | null; recipient: string; updateId: string | null }
export interface SwapPayment { block: number; txHash: string | null; legIndex: number; updateId: string; recordTime: string }
export interface SwapClaim { block: number; txHash: string | null; legIndex: number; updateId: string; recordTime: string }
/** The Canton update that offered the trade, before any payment. */
export interface SwapOffer { updateId: string }
export interface SwapItem { payId: string; claimId: string; status: "settled" | "claimed"; offer: SwapOffer; evm: SwapEvm; canton: SwapCanton; payment: SwapPayment; claim: SwapClaim | null }

export type AddressSort = "balance" | "txs";
export type ContractSort = "interactions" | "newest" | "oldest";
export type TokenSort = "holders" | "transfers" | "newest";

/** Which of an address's transactions a list keeps: all, the ones it sent, or the ones it received (as recipient or as the contract a transaction created). */
export type TxDirection = "all" | "sent" | "received";
export const TX_DIRECTIONS: readonly TxDirection[] = ["all", "sent", "received"];
export interface AddressItem { address: string; kind: string; balance: string | null; balanceBlock: number | null; txCount: number }
export interface Funding { from: string; txHash: string; block: number; timestamp: number; value: string }
export interface AddressDetail {
  address: string; kind: string; sentCount: number; receivedCount: number; internalCount: number; tokenTransferCount: number; erc20TransferCount: number | null; nftTransferCount: number | null; firstSeenBlock: number | null; firstSeenTimestamp: number | null; lastActiveBlock: number | null; lastActiveTimestamp: number | null;
  /** The ERC-20 transfers its Token transfers list holds and the NFT transfers its NFT transfers list holds (each transfer once, a transfer to itself too), counted up to a ceiling: null when there are more than that. They count derived rows, so they are exact once `derived` is true; while it is false they hold only the blocks derived so far. `tokenTransferCount` counts every standard together. */
  /** The contracts it made (as the direct caller of the creation). */
  createdCount: number;
  /** True when `createdCount` stopped at its ceiling: the address made more. */
  createdCountCapped: boolean;
  /** Who sent it its first coin, when the index can say: null when it holds no such transaction, or the address was there before it (a genesis balance, a call inside another transaction, or a token transfer that reached it first). */
  fundedBy: Funding | null;
  token: { name: string | null; symbol: string | null; decimals: number | null } | null; createdBy: { txHash: string | null; block: number } | null;
}
export interface AddressInternalItem {
  txHash: string; block: number; txIndex: number; traceAddress: number[]; callType: string; from: string; to: string | null; value: string; gas: number | null; gasUsed: number | null;
  selector: string | null; inputSize: number | null; error: string | null;
}
/** A log a contract wrote, with the transaction it is in and that transaction's method (the first 4 bytes of its input, null when it has none). A transaction that creates a contract has no method, because its input is init code; `creation` says so. */
export interface ContractEventItem { txHash: string; block: number; txIndex: number; logIndex: number; /** The block's time, epoch seconds. */ timestamp: number; address: string; topics: string[]; data: string; method: string | null; creation: boolean }
/** `methodId` and `timestamp` are the transaction's (the method is null for a creation, whose first four bytes of input are code, and `creation` says so, as a call with no input has a null method too); `standard` is the token's, null when the explorer has no row for it. */
export interface TokenTransferItem {
  txHash: string; block: number; txIndex: number; logIndex: number; batchIndex: number; methodId: string | null; creation: boolean; timestamp: number; token: string; standard: string | null; from: string; to: string; amount: string | null; tokenId: string | null;
}
export const TOKEN_STANDARDS = ["ERC-20", "ERC-721", "ERC-1155"] as const;
export type TokenStandard = (typeof TOKEN_STANDARDS)[number];
/** What makes a transfer of a standard, in its columns (the indexer writes only transfers of the standard a token is known by): the predicate of that standard's partial indexes, which a query must repeat to use them. */
const STANDARD_COLUMNS: Record<TokenStandard | NftGroup, string> = { "ERC-20": "x.token_id is null", "ERC-721": "x.amount is null", "ERC-1155": "x.amount is not null and x.token_id is not null", nft: "x.token_id is not null" };
/** The transfers an address list keeps: those of one token and/or one standard (or the NFT group). */
export interface TransferFilter { token?: string | null; standard?: TokenStandard | NftGroup | null }
/** The two NFT standards as one filter of an address's transfers: a transfer with a token id, whichever of them it is. */
export type NftGroup = "nft";
/** What an address holds of a token (of one id for an NFT), as of `updatedBlock`, the block it last moved. */
export interface Holding { token: string; standard: string; name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null; tokenId: string; value: string; updatedBlock: number }
export interface CoinPoint { block: number; balance: string }
/** Shown with a partial match: the library lets the metadata (the CBOR at the end of the code, and of any contract embedded in it) differ from the compile. */
export const PARTIAL_MATCH_NOTE = "Partial match: the metadata differs from this compile. Code that reads its own or another contract's code (type(X).creationCode/runtimeCode, codecopy, extcodecopy, address(this).code) may act differently from this source's compile; only a full match is byte-for-byte.";
export const matchNote = (matchType: string | null): string | null => (matchType === "partial" ? PARTIAL_MATCH_NOTE : null);

export interface ContractItem {
  address: string; name: string | null; origin: string; creator: string | null; creationBlock: number | null; creationTxIndex: number | null;
  /** When its creation's block was made (ISO), null for a contract the explorer did not see made; `compilerVersion` is its verified source's, null while it has none. */
  createdAt: string | null; compilerVersion: string | null;
  interactionCount: number; verified: boolean; matchType: string | null; codeSize: number;
  destroyedBlock: number | null;
  /** The token standard when the contract is a token. The balance and the counts are the explorer's copy, as of `balanceBlock`; a contract it has not seen move has none. */
  standard: string | null; balance: string | null; balanceBlock: number | null; txCount: number; internalCount: number;
}
export interface ContractDetail extends ContractItem {
  creationTxHash: string | null; lastInteractionBlock: number | null; codeHash: string; code: string;
  /** How many logs it wrote, counted up to EVENT_COUNT_CAP; `eventCountCapped` says the count stopped there. */
  eventCount: number; eventCountCapped: boolean;
  /** `kind` is eip1967, eip1822, beacon, eip1167 or trex. `beacon` is the beacon of a beacon proxy, and for trex (ERC-3643 and ONCHAINID proxies) the implementation authority that names the implementation. */
  proxy: { kind: string; implementation: string | null; beacon: string | null; checkedBlock: number } | null;
  verification: {
    language: string; compilerVersion: string; codeFormat: string; contractPath: string; contractName: string; optimizerEnabled: boolean | null; optimizerRuns: number | null; evmVersion: string | null;
    license: string | null; verifiedAt: string; matchNote: string | null;
    /** How it was verified (the Etherscan-compatible API or /api/verify) and the tool its submitter named: null for a source verified before this was kept, or by the operator. */
    method: string | null; tool: string | null;
  } | null;
}
export interface SourceDetail {
  matchType: string; language: string; compilerVersion: string; codeFormat: string; contractPath: string; contractName: string; optimizerEnabled: boolean | null; optimizerRuns: number | null;
  evmVersion: string | null; license: string | null; settings: unknown; files: { path: string; content: string }[]; abi: unknown; constructorArgs: string | null; libraries: unknown; verifiedAt: string; matchNote: string | null; method: string | null; tool: string | null;
}
export interface TokenItem {
  address: string; standard: string; name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null; holderCount: number; transferCount: number; firstTransferBlock: number;
  gatewayWrapped: boolean; metadataStatus: string;
  /** Who made the token's contract, in which block and when; none of the three where the explorer saw no creation (a contract of the genesis state). */
  creator: string | null; creationBlock: number | null; createdAt: string | null; verified: boolean;
}
/**
 * The gateway's custody of a registered token on Canton (`gateway_tokens`): base units of 10 decimals, and the token's own `supply` (its base units) read at the same
 * block, `supplyBlock`, as the custody (at the ledger offset of that block's record), so the two are set against each other with nothing between them. `supply` is
 * null when the token did not answer at that block. `readAt` is when the read was made.
 */
export interface CantonCustody { instrumentAdmin: string; instrumentId: string; custody: string; custodyDecimals: number; holdings: number; supply: string | null; supplyBlock: number; ledgerOffset: number; readAt: string }
/**
 * The Canton twin of an ERC-20 a registered vault holds: `supply` is what the twin has in issue (the locks into a registered vault less the releases out of one, in the token's base units), `vaultBalance` what the
 * registered vaults held of the token at the block `through`, the same block the sums are counted to (null where reth did not give it), `locks` and `releases` the legs counted. The sums are kept by the indexer, once per leg, and count the legs up to the block `through` (null before the first pass).
 */
export interface TwinSupply { supply: string; vaultBalance: string | null; locks: number; releases: number; through: number | null }
export interface TokenDetail extends TokenItem { totalSupplyBlock: number | null; balanceMode: string; canton: CantonCustody | null; twin: TwinSupply | null }
export interface HolderItem { holder: string; tokenId: string; value: string; updatedBlock: number }
export interface LegListItem { block: number; txHash: string | null; legIndex: number; txIndex: number; logIndex: number; kind: string; gateway: string | null; twin: "lock" | "release" | null; legId: string; token: string; account: string; amount: string; party: string | null }
/** What is known of an address for showing it by name; a null name is a name nothing holds, and `kind` is "account" for an address no contract or token row names. */
export interface LabelItem { address: string; name: string | null; symbol: string | null; kind: "token" | "contract" | "account" | null; standard: string | null; decimals: number | null; verified: boolean }
export interface NameMatch { kind: "token" | "contract"; name: string | null; symbol: string | null; address: string }

export type AccountRest = ReturnType<typeof createAccountRest>;

/** The filters of the two lists of an address's transfers, as the address detail counts them and as the tests plan them. */
export const ERC20_TRANSFERS = "x.token_id is null";
export const NFT_TRANSFERS = "x.token_id is not null";

/** The transfers of an address in one list (one standard group), counted to the ceiling $3 from each side: a transfer to itself is once, as the list shows it. */
export const transferCountSql = (filter: string) =>
  `(select count(*) from (select 1 from (
      (select x.block_number, x.log_index, x.batch_index from token_transfers x where x.from_address = q.address and ${filter} limit $3)
      union (select x.block_number, x.log_index, x.batch_index from token_transfers x where x.to_address = q.address and ${filter} limit $3)
    ) u limit $3) k)`;

export function createAccountRest(pool: Pool) {
  async function query(sql: string, values: unknown[] = []): Promise<Row[]> {
    try {
      return (await pool.query(sql, values)).rows;
    } catch (e) {
      throw new ChainDbError(`the database cannot be read: ${(e as Error).message}`);
    }
  }

  /** The newest final block and the block stage 2 has derived up to: the lists below hold every block up to the second, so they are complete when it has reached the first. */
  async function derivedThrough(): Promise<{ head: number | null; cursor: number }> {
    const [h] = await query("select number from blocks order by number desc limit 1");
    const [c] = await query("select position from cursors where stream = 'derive'");
    return { head: h ? Number(h.number) : null, cursor: c ? Number(c.position) : 0 };
  }

  const addressItem = (r: Row): AddressItem => ({
    address: hex(r.address), kind: r.is_token ? "token" : r.is_contract ? "contract" : "account", balance: r.balance, balanceBlock: num(r.coin_balance_block), txCount: Number(r.tx_count),
  });

  /** The addresses list. By balance: the database's copy, newest first by value, only accounts that hold something. By transactions: sent and received. */
  async function addresses(sort: AddressSort, before: Key | null, limit: number): Promise<AddressItem[]> {
    const [first, second] = before ?? [null, null];
    const from = "from addresses a left join tokens tk on tk.address = a.address";
    const select = "a.address, a.is_contract, (tk.address is not null) as is_token, a.coin_balance::text as balance, a.coin_balance_block, (a.sent_count + a.received_count) as tx_count";
    const rows = sort === "balance"
      ? await query(
        `select ${select} ${from} where a.coin_balance > 0 and ($1::numeric is null or (a.coin_balance, a.address) < ($1::numeric, $2::bytea)) order by a.coin_balance desc, a.address desc limit $3`,
        [first, second === null ? null : bytes(second as string), limit + 1],
      )
      : await query(
        `select ${select} ${from} where ($1::bigint is null or ((a.sent_count + a.received_count), a.address) < ($1::bigint, $2::bytea)) order by (a.sent_count + a.received_count) desc, a.address desc limit $3`,
        [first, second === null ? null : bytes(second as string), limit + 1],
      );
    return rows.map(addressItem);
  }

  /**
   * The labels of the addresses, in the order asked: a token's name and symbol and its standard, else a contract's name (from its verified source, else the token's) and whether its source is
   * verified, and the token's decimals. One read for all of them, by keys (the contracts, the tokens, the addresses, and the creations of final transactions); nothing is guessed: an address the index holds nothing of has a null kind.
   */
  async function labels(addresses: string[]): Promise<LabelItem[]> {
    const rows = await query(
      `select q.address, tk.name as token_name, tk.symbol, tk.standard, tk.decimals, c.name as contract_name, (c.verified_source is not null) as verified, tk.address is not null as is_token, c.address is not null as is_contract,
         ad.address is not null as is_seen, ad.is_contract as seen_contract,
         exists (select 1 from transactions t where t.created_contract = q.address) as is_created
       from unnest($1::bytea[]) with ordinality as q(address, ord) left join contracts c on c.address = q.address left join tokens tk on tk.address = q.address left join addresses ad on ad.address = q.address
       order by q.ord`,
      [addresses.map(bytes)],
    );
    // A kind is only said where the database holds it: a token, a contract (derived, or named by a final creation that stage 2 has not reached), an address it has seen. Else null.
    return rows.map((r): LabelItem => ({
      address: hex(r.address), name: r.token_name ?? r.contract_name, symbol: r.symbol,
      kind: r.is_token ? "token" : r.is_contract || r.seen_contract || r.is_created ? "contract" : r.is_seen ? "account" : null,
      standard: r.standard, decimals: num(r.decimals), verified: r.verified === true,
    }));
  }

  /** The most contracts of an address that are counted: a factory that made more says `createdCountCapped`, so that its page does not cost a count of millions. */
  const CREATED_COUNT_CAP = 100_000;
  /** The most transfers of one list that are counted for the tabs of an address: past it the count is not given. */
  const TRANSFER_COUNT_CAP = 10_000;

  /** A count that stopped at the ceiling is not a count. */
  const within = (n: unknown, cap: number): number | null => (Number(n) > cap ? null : Number(n));

  /** What the database holds of an address: the counters, the kind, the token it is and the transaction that made it. Undefined for an address nothing has touched. */
  async function address(a: string, createdCap = CREATED_COUNT_CAP, transferCap = TRANSFER_COUNT_CAP): Promise<AddressDetail | undefined> {
    // The funder is the first transaction that sent it value, and only when that is in the block the address first appeared in: an address that was there before it (a
    // genesis balance, a call inside another transaction) was funded some other way, which this index does not hold. The times are those of the blocks of the counters.
    const [r] = await query(
      `select ad.sent_count, ad.received_count, ad.internal_count, ad.token_transfer_count, ad.first_seen_block, ad.last_active_block, ad.is_contract,
         tk.address is not null as is_token, tk.name, tk.symbol, tk.decimals, c.address is not null as has_contract, c.creation_block,
         (select t.hash from transactions t where t.block_number = c.creation_block and t.tx_index = c.creation_tx_index) as creation_tx,
         (select extract(epoch from b.timestamp)::bigint from blocks b where b.number = ad.first_seen_block) as first_ts,
         (select extract(epoch from b.timestamp)::bigint from blocks b where b.number = ad.last_active_block) as last_ts,
         (select count(*) from (select 1 from contracts k where k.creator = q.address limit $2) k) as created_count,
         ${transferCountSql(ERC20_TRANSFERS)} as erc20_count, ${transferCountSql(NFT_TRANSFERS)} as nft_count,
         f.from_address as fund_from, f.hash as fund_tx, f.block_number as fund_block, f.value as fund_value, f.ts as fund_ts
       from (select $1::bytea as address) q left join addresses ad on ad.address = q.address left join contracts c on c.address = q.address left join tokens tk on tk.address = q.address
         left join lateral (select t.from_address, t.hash, t.block_number, t.value::text as value, extract(epoch from b.timestamp)::bigint as ts
           from transactions t join blocks b on b.number = t.block_number where t.to_address = q.address and t.block_number = ad.first_seen_block and t.value > 0 and t.status = 1 order by t.tx_index limit 1) f
           on true`,
      [bytes(a), createdCap + 1, transferCap + 1],
    );
    if (!r || (r.sent_count === null && !r.has_contract)) return undefined;
    return {
      address: a, kind: r.is_token ? "token" : r.is_contract || r.has_contract ? "contract" : "account", sentCount: Number(r.sent_count ?? 0), receivedCount: Number(r.received_count ?? 0),
      internalCount: Number(r.internal_count ?? 0), tokenTransferCount: Number(r.token_transfer_count ?? 0), erc20TransferCount: within(r.erc20_count, transferCap), nftTransferCount: within(r.nft_count, transferCap), firstSeenBlock: num(r.first_seen_block), firstSeenTimestamp: num(r.first_ts), lastActiveBlock: num(r.last_active_block), lastActiveTimestamp: num(r.last_ts),
      createdCount: Math.min(Number(r.created_count), createdCap), createdCountCapped: Number(r.created_count) > createdCap,
      fundedBy: r.fund_tx === null ? null : { from: hex(r.fund_from), txHash: hex(r.fund_tx), block: Number(r.fund_block), timestamp: Number(r.fund_ts), value: r.fund_value },
      token: r.is_token ? { name: r.name, symbol: r.symbol, decimals: num(r.decimals) } : null,
      createdBy: r.creation_block === null || r.creation_block === undefined ? null : { txHash: hexOrNull(r.creation_tx), block: Number(r.creation_block) },
    };
  }

  /**
   * The transactions an address sent, received or was made by, newest first, after the key (block, index). `direction` keeps the ones it sent (it is the sender), or the ones it
   * received (it is the recipient, or the contract the transaction created); "all" is every one of them.
   */
  async function addressTxs(a: string, before: Key | null, limit: number, direction: TxDirection = "all", moves = true): Promise<TxListItem[]> {
    const [bn, ix] = before ?? [null, null];
    const side = (column: string) =>
      `(select block_number, tx_index from transactions where ${column} = $1 and ($2::bigint is null or (block_number, tx_index) < ($2::bigint, $3::int)) order by block_number desc, tx_index desc limit $4)`;
    const columns = { all: ["from_address", "to_address", "created_contract"], sent: ["from_address"], received: ["to_address", "created_contract"] }[direction];
    const rows = await query(
      `with k as (${columns.map(side).join(" union ")})
       select ${txSelect} from k join transactions t on t.block_number = k.block_number and t.tx_index = k.tx_index join blocks b on b.number = t.block_number
       order by t.block_number desc, t.tx_index desc limit $4`,
      [bytes(a), bn, ix, limit + 1],
    );
    return moves ? withTokenMoves(query, rows.map(txItem)) : rows.map(txItem);
  }

  /** The internal calls an address is the caller or the callee of, newest first, after the key (block, index, trace address). */
  async function addressInternal(a: string, before: Key | null, limit: number): Promise<AddressInternalItem[]> {
    const [bn, ix, trace] = before ?? [null, null, null];
    const side = (column: string) =>
      `(select block_number, tx_index, trace_address from internal_calls where ${column} = $1
         and ($2::bigint is null or (block_number, tx_index, trace_address) < ($2::bigint, $3::int, $5::int[])) order by block_number desc, tx_index desc, trace_address desc limit $4)`;
    const rows = await query(
      `with k as (${side("from_address")} union ${side("to_address")})
       select ic.block_number, ic.tx_index, ic.trace_address, ic.call_type, ic.from_address, ic.to_address, ic.value::text as value, ic.gas, ic.gas_used, ic.input_selector, ic.input_size, ic.error, t.hash
       from k join internal_calls ic on ic.block_number = k.block_number and ic.tx_index = k.tx_index and ic.trace_address = k.trace_address
         join transactions t on t.block_number = ic.block_number and t.tx_index = ic.tx_index
       order by ic.block_number desc, ic.tx_index desc, ic.trace_address desc limit $4`,
      [bytes(a), bn, ix, limit + 1, trace === null ? null : addressOfKey(trace as string)],
    );
    return rows.map((r) => ({
      txHash: hex(r.hash), block: Number(r.block_number), txIndex: r.tx_index, traceAddress: r.trace_address, callType: r.call_type, from: hex(r.from_address), to: hexOrNull(r.to_address), value: r.value,
      gas: r.gas === null ? null : Number(r.gas), gasUsed: r.gas_used === null ? null : Number(r.gas_used), selector: hexOrNull(r.input_selector), inputSize: r.input_size, error: r.error,
    }));
  }

  /** The logs written by one contract, newest first, after the key (block, log index); `topic0` keeps one kind of event. The indexes are (address, block, log index) and (address, topic0, block, log index). */
  async function contractEvents(a: string, topic0: string | null, before: Key | null, limit: number): Promise<ContractEventItem[]> {
    const [bn, li] = before ?? [null, null];
    const rows = await query(
      `select l.block_number, l.log_index, l.tx_index, l.address, l.topic0, l.topic1, l.topic2, l.topic3, l.data, t.hash, t.method_id, t.to_address, extract(epoch from b.timestamp)::bigint as ts
       from logs l join transactions t on t.block_number = l.block_number and t.tx_index = l.tx_index join blocks b on b.number = l.block_number
       where l.address = $1 and ($2::bytea is null or l.topic0 = $2) and ($3::bigint is null or (l.block_number, l.log_index) < ($3::bigint, $4::int))
       order by l.block_number desc, l.log_index desc limit $5`,
      [bytes(a), topic0 === null ? null : bytes(topic0), bn, li, limit + 1],
    );
    return rows.map((r) => ({
      txHash: hex(r.hash), block: Number(r.block_number), txIndex: r.tx_index, logIndex: r.log_index, timestamp: Number(r.ts), address: hex(r.address),
      topics: [r.topic0, r.topic1, r.topic2, r.topic3].flatMap((t, i, all) => (t !== null && all.slice(0, i).every((x) => x !== null) ? [hex(t)] : [])), data: hex(r.data), method: r.to_address === null ? null : hexOrNull(r.method_id), creation: r.to_address === null,
    }));
  }

  const transferSelect = `x.block_number, x.log_index, x.batch_index, x.tx_index, x.token, x.from_address, x.to_address, x.amount::text as amount, x.token_id::text as token_id, t.hash,
    t.method_id, t.to_address as tx_to, extract(epoch from b.timestamp)::bigint as ts, tk.standard`;
  // One join each for the transaction, its block and the token, whatever the page's size.
  const transferJoins = `join transactions t on t.block_number = x.block_number and t.tx_index = x.tx_index join blocks b on b.number = x.block_number left join tokens tk on tk.address = x.token`;
  const transferItem = (r: Row): TokenTransferItem => ({
    txHash: hex(r.hash), block: Number(r.block_number), txIndex: r.tx_index, logIndex: r.log_index, batchIndex: r.batch_index, methodId: r.tx_to === null ? null : hexOrNull(r.method_id), creation: r.tx_to === null, timestamp: Number(r.ts),
    token: hex(r.token), standard: r.standard, from: hex(r.from_address), to: hex(r.to_address), amount: r.amount, tokenId: r.token_id,
  });

  /** The token transfers an address sent or received (of one token and/or standard, when asked), newest first, after the key (block, log, batch). */
  async function addressTransfers(a: string, before: Key | null, limit: number, filter: TransferFilter = {}): Promise<TokenTransferItem[]> {
    const [bn, li, bi] = before ?? [null, null, null];
    const values: unknown[] = [bytes(a), bn, li, limit + 1, bi];
    const more = [filter.token ? (values.push(bytes(filter.token)), `and x.token = $${values.length}`) : "", filter.standard ? `and ${STANDARD_COLUMNS[filter.standard]}` : ""].join(" ");
    const side = (column: string) =>
      `(select x.block_number, x.log_index, x.batch_index from token_transfers x where x.${column} = $1 ${more}
         and ($2::bigint is null or (x.block_number, x.log_index, x.batch_index) < ($2::bigint, $3::int, $5::int)) order by x.block_number desc, x.log_index desc, x.batch_index desc limit $4)`;
    const rows = await query(
      `with k as (${side("from_address")} union ${side("to_address")})
       select ${transferSelect} from k join token_transfers x on x.block_number = k.block_number and x.log_index = k.log_index and x.batch_index = k.batch_index
         ${transferJoins}
       order by x.block_number desc, x.log_index desc, x.batch_index desc limit $4`,
      values,
    );
    return rows.map(transferItem);
  }

  /** The transfers of every token (of one standard, when asked), newest first, after the key (block, log, batch). */
  async function allTransfers(standard: TokenStandard | null, before: Key | null, limit: number): Promise<TokenTransferItem[]> {
    const [bn, li, bi] = before ?? [null, null, null];
    const rows = await query(
      `with k as (select x.block_number, x.log_index, x.batch_index from token_transfers x where ${standard ? STANDARD_COLUMNS[standard] : "true"}
         and ($1::bigint is null or (x.block_number, x.log_index, x.batch_index) < ($1::bigint, $2::int, $4::int)) order by x.block_number desc, x.log_index desc, x.batch_index desc limit $3)
       select ${transferSelect} from k join token_transfers x on x.block_number = k.block_number and x.log_index = k.log_index and x.batch_index = k.batch_index
         ${transferJoins}
       order by x.block_number desc, x.log_index desc, x.batch_index desc`,
      [bn, li, limit + 1, bi],
    );
    return rows.map(transferItem);
  }

  /** What an address holds, in the order of the token and its id, after the key (token, id). */
  async function holdings(a: string, after: Key | null, limit: number): Promise<Holding[]> {
    const [token, id] = after ?? [null, null];
    const rows = await query(
      `select b.token, tk.standard, tk.name, tk.symbol, tk.decimals, tk.total_supply::text as total_supply, b.token_id::text as token_id, b.value::text as value, b.updated_block
       from token_balances b join tokens tk on tk.address = b.token
       where b.holder = $1 and b.value > 0 and ($2::bytea is null or (b.token, b.token_id) > ($2::bytea, $3::numeric)) order by b.token, b.token_id limit $4`,
      [bytes(a), token === null ? null : bytes(token as string), id, limit + 1],
    );
    return rows.map((r) => ({ token: hex(r.token), standard: r.standard, name: r.name, symbol: r.symbol, decimals: num(r.decimals), totalSupply: r.total_supply, tokenId: r.token_id, value: r.value, updatedBlock: Number(r.updated_block) }));
  }

  /** The balance after each block that moved it, newest first, after the key (block). */
  async function coinHistory(a: string, before: number | null, limit: number): Promise<CoinPoint[]> {
    const rows = await query(
      "select block_number, value::text as value from coin_balance_history where address = $1 and ($2::bigint is null or block_number < $2) order by block_number desc limit $3",
      [bytes(a), before, limit + 1],
    );
    return rows.map((r) => ({ block: Number(r.block_number), balance: r.value }));
  }

  const contractSelect = `c.address, c.name, c.origin, c.creator, c.creation_block, c.creation_tx_index, c.interaction_count, c.verified_source, c.match_type, c.destroyed_block, c.last_interaction_block, c.runtime_code_hash, bc.size,
    tk.standard, a.coin_balance::text as balance, a.coin_balance_block, coalesce(a.sent_count + a.received_count, 0) as tx_count, coalesce(a.internal_count, 0) as internal_count,
    v.compiler_version as list_compiler, extract(epoch from cb.timestamp)::bigint as created_ts`;
  // The account, the token, the verified source and the block of the creation: each by its primary key, one row at most, whatever the page's size.
  const withAccount = "left join addresses a on a.address = c.address left join tokens tk on tk.address = c.address left join verified_sources v on v.id = c.verified_source left join blocks cb on cb.number = c.creation_block";
  const contractItem = (r: Row): ContractItem => ({
    address: hex(r.address), name: r.name, origin: r.origin, creator: hexOrNull(r.creator), creationBlock: num(r.creation_block), creationTxIndex: num(r.creation_tx_index),
    createdAt: r.created_ts === null || r.created_ts === undefined ? null : new Date(Number(r.created_ts) * 1000).toISOString(), compilerVersion: r.list_compiler ?? null, interactionCount: Number(r.interaction_count),
    verified: r.verified_source !== null, matchType: r.match_type, codeSize: r.size, destroyedBlock: num(r.destroyed_block),
    standard: r.standard, balance: r.balance, balanceBlock: num(r.coin_balance_block), txCount: Number(r.tx_count), internalCount: Number(r.internal_count),
  });

  /**
   * The contract list. Interactions: most first. Newest or oldest: by the place of the creation (a genesis contract, which has none, is the oldest). The key is
   * the sort's own parts and then the address, so that two contracts of one place keep their order. `order` "asc" reads the list from its other end (the key is then the
   * one the page before it left), for the last page: each index is read backward, as the token list's is.
   */
  async function contracts(sort: ContractSort, verified: boolean | null, before: Key | null, limit: number, order: "desc" | "asc" = "desc"): Promise<ContractItem[]> {
    const from = `from contracts c join bytecodes bc on bc.code_hash = c.runtime_code_hash ${withAccount}`;
    const filter = (n: number) => `($${n}::boolean is null or (c.verified_source is not null) = $${n})`;
    const [x, y, z] = before ?? [null, null, null];
    // The sort's own direction, turned round when the list is read from its other end.
    const flip = (own: "desc" | "asc"): "desc" | "asc" => (order === "desc" ? own : own === "desc" ? "asc" : "desc");
    if (sort === "interactions") {
      const d = flip("desc"), past = d === "desc" ? "<" : ">";
      const rows = await query(
        `select ${contractSelect} ${from} where ($1::bigint is null or (c.interaction_count, c.address) ${past} ($1::bigint, $2::bytea)) and ${filter(4)} order by c.interaction_count ${d}, c.address ${d} limit $3`,
        [x, y === null ? null : bytes(y as string), limit + 1, verified],
      );
      return rows.map(contractItem);
    }
    const place = "(coalesce(c.creation_block, 0), coalesce(c.creation_tx_index, 0), c.address)";
    const d = flip(sort === "newest" ? "desc" : "asc"), dir = d === "desc" ? ["<", "desc"] : [">", "asc"];
    const rows = await query(
      `select ${contractSelect} ${from} where ($1::bigint is null or ${place} ${dir[0]} ($1::bigint, $4::int, $2::bytea)) and ${filter(5)}
       order by coalesce(c.creation_block, 0) ${dir[1]}, coalesce(c.creation_tx_index, 0) ${dir[1]}, c.address ${dir[1]} limit $3`,
      [x, z === null ? null : bytes(z as string), limit + 1, y, verified],
    );
    return rows.map(contractItem);
  }

  /** The contracts an address made, newest first by the place of the creation, after the key (block, index, address): the order of the contract list's newest sort. */
  async function contractsMadeBy(a: string, before: Key | null, limit: number): Promise<ContractItem[]> {
    const [x, y, z] = before ?? [null, null, null];
    const rows = await query(
      `select ${contractSelect} from contracts c join bytecodes bc on bc.code_hash = c.runtime_code_hash ${withAccount}
       where c.creator = $1 and ($2::bigint is null or (coalesce(c.creation_block, 0), coalesce(c.creation_tx_index, 0), c.address) < ($2::bigint, $3::int, $4::bytea))
       order by coalesce(c.creation_block, 0) desc, coalesce(c.creation_tx_index, 0) desc, c.address desc limit $5`,
      [bytes(a), x, y, z === null ? null : bytes(z as string), limit + 1],
    );
    return rows.map(contractItem);
  }

  /** The most logs of a contract that are counted: a contract with more says `capped`, so that a very busy one does not cost a count of millions on each view. */
  const EVENT_COUNT_CAP = 100_000;
  /** How many logs a contract wrote, counted from its own index (address, block, log index), at most `cap`. */
  async function eventCountOf(a: string, cap = EVENT_COUNT_CAP): Promise<{ count: number; capped: boolean }> {
    const [r] = await query("select count(*) as n from (select 1 from logs where address = $1 limit $2) e", [bytes(a), cap + 1]);
    const n = Number(r!.n);
    return { count: Math.min(n, cap), capped: n > cap };
  }

  /** How many contracts there are and how many of them have a verified source: counted from the primary key and from the partial index of verified sources. They are index-only scans, but the indexer updates a contract's row in each block that touches it, so they still visit heap pages to check visibility; fine while the list is small, and a counter kept by the indexer can replace them if it grows. */
  async function contractCounts(): Promise<{ all: number; verified: number; notVerified: number }> {
    const [r] = await query("select (select count(*) from contracts) as n, (select count(*) from contracts where verified_source is not null) as v");
    const all = Number(r!.n), verified = Number(r!.v);
    return { all, verified, notVerified: all - verified };
  }

  /** One contract with its code, its proxy and what verification says. Undefined when none is held at the address. */
  async function contract(a: string): Promise<ContractDetail | undefined> {
    const [r] = await query(
      `select ${contractSelect}, encode(bc.code, 'hex') as code, (select t.hash from transactions t where t.block_number = c.creation_block and t.tx_index = c.creation_tx_index) as creation_tx,
         p.kind as proxy_kind, p.implementation, p.beacon, p.checked_block, v.match_type as source_match_type, v.language, v.compiler_version, v.code_format, v.contract_path, v.contract_name, v.optimizer_enabled, v.optimizer_runs,
         v.evm_version, v.license, v.method as via_method, v.tool as via_tool, ${MS("v.verified_at")} as verified_at
       from contracts c join bytecodes bc on bc.code_hash = c.runtime_code_hash ${withAccount} left join proxies p on p.proxy = c.address and p.checked_block >= coalesce(c.creation_block, 0) where c.address = $1`,
      [bytes(a)],
    );
    if (!r) return undefined;
    const events = await eventCountOf(a);
    return {
      ...contractItem(r), creationTxHash: hexOrNull(r.creation_tx), lastInteractionBlock: num(r.last_interaction_block), eventCount: events.count, eventCountCapped: events.capped, codeHash: hex(r.runtime_code_hash), code: "0x" + r.code,
      proxy: r.proxy_kind === null ? null : { kind: r.proxy_kind, implementation: hexOrNull(r.implementation), beacon: hexOrNull(r.beacon), checkedBlock: Number(r.checked_block) },
      verification: r.language === null ? null : {
        language: r.language, compilerVersion: r.compiler_version, codeFormat: r.code_format, contractPath: r.contract_path, contractName: r.contract_name, optimizerEnabled: r.optimizer_enabled,
        optimizerRuns: num(r.optimizer_runs), evmVersion: r.evm_version, license: r.license, verifiedAt: r.verified_at, matchNote: matchNote(r.source_match_type), method: r.via_method, tool: r.via_tool,
      },
    };
  }

  /** Whether a contract is held at the address, and, when it is verified, its source. */
  async function source(a: string): Promise<{ held: boolean; source: SourceDetail | null }> {
    const [r] = await query(
      `select v.match_type, v.language, v.compiler_version, v.code_format, v.contract_path, v.contract_name, v.optimizer_enabled, v.optimizer_runs, v.evm_version, v.license, v.settings, v.sources,
         v.abi, v.constructor_args, v.libraries, v.method, v.tool, ${MS("v.verified_at")} as verified_at
       from contracts c left join verified_sources v on v.id = c.verified_source where c.address = $1`,
      [bytes(a)],
    );
    if (!r) return { held: false, source: null };
    if (r.language === null) return { held: true, source: null };
    const files = Object.entries(r.sources as Record<string, string>).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0)).map(([path, content]) => ({ path, content }));
    return {
      held: true,
      source: {
        matchType: r.match_type, language: r.language, compilerVersion: r.compiler_version, codeFormat: r.code_format, contractPath: r.contract_path, contractName: r.contract_name,
        optimizerEnabled: r.optimizer_enabled, optimizerRuns: num(r.optimizer_runs), evmVersion: r.evm_version, license: r.license, settings: r.settings, files, abi: r.abi,
        constructorArgs: hexOrNull(r.constructor_args), libraries: r.libraries, verifiedAt: r.verified_at, matchNote: matchNote(r.match_type), method: r.method, tool: r.tool,
      },
    };
  }

  const tokenSelect = `tk.address, tk.standard, tk.name, tk.symbol, tk.decimals, tk.total_supply::text as total_supply, tk.total_supply_block, tk.holder_count, tk.transfer_count, tk.first_transfer_block, tk.metadata_status, tk.gateway_wrapped, tk.balance_mode,
    c.creator, c.creation_block, c.verified_source is not null as verified, extract(epoch from cb.timestamp)::bigint as created_ts`;
  // Every token is a contract (the foreign key), so the first join always has its row; a contract of the genesis state has no creation block, so no block row.
  const tokenFrom = "from tokens tk join contracts c on c.address = tk.address left join blocks cb on cb.number = c.creation_block";
  const tokenItem = (r: Row): TokenItem => ({
    address: hex(r.address), standard: r.standard, name: r.name, symbol: r.symbol, decimals: num(r.decimals), totalSupply: r.total_supply, holderCount: Number(r.holder_count),
    transferCount: Number(r.transfer_count), firstTransferBlock: Number(r.first_transfer_block), gatewayWrapped: r.gateway_wrapped, metadataStatus: r.metadata_status,
    creator: hexOrNull(r.creator), creationBlock: num(r.creation_block), createdAt: r.created_ts === null || r.created_ts === undefined ? null : new Date(Number(r.created_ts) * 1000).toISOString(), verified: r.verified === true,
  });

  /**
   * The token list: most holders, most transfers, or newest (by the block of its first transfer), then by address, after the key; of one standard and/or only the tokens the gateway wrapped
   * when asked. `order` "asc" reads the same list from its other end (the key is then the one the page before it left), for the last page: each index is read backward.
   */
  async function tokens(sort: TokenSort, before: Key | null, limit: number, standard: TokenStandard | null = null, gateway = false, order: "desc" | "asc" = "desc"): Promise<TokenItem[]> {
    const column = { holders: "tk.holder_count", transfers: "tk.transfer_count", newest: "tk.first_transfer_block" }[sort];
    const [x, y] = before ?? [null, null];
    const [past, dir] = order === "desc" ? ["<", "desc"] : [">", "asc"];
    const values: unknown[] = [x, y === null ? null : bytes(y as string), limit + 1];
    const more = [standard === null ? "" : (values.push(standard), `and tk.standard = $${values.length}`), gateway ? "and tk.gateway_wrapped" : ""].filter(Boolean).join(" ");
    const rows = await query(
      `select ${tokenSelect} ${tokenFrom} where ($1::bigint is null or (${column}, tk.address) ${past} ($1::bigint, $2::bytea)) ${more} order by ${column} ${dir}, tk.address ${dir} limit $3`,
      values,
    );
    return rows.map(tokenItem);
  }

  /** How many tokens each standard has, and how many of those the gateway wrapped (a standard with none is 0), from one grouped count of the tokens table, which is small: the list's tabs and totals. */
  async function tokenCounts(): Promise<{ counts: Record<TokenStandard, number>; gateway: Record<TokenStandard, number> }> {
    const counts = { "ERC-20": 0, "ERC-721": 0, "ERC-1155": 0 }, gateway = { "ERC-20": 0, "ERC-721": 0, "ERC-1155": 0 };
    for (const r of await query("select standard, count(*) as n, count(*) filter (where gateway_wrapped) as g from tokens group by standard")) {
      if (r.standard in counts) { counts[r.standard as TokenStandard] = Number(r.n); gateway[r.standard as TokenStandard] = Number(r.g); }
    }
    return { counts, gateway };
  }

  async function token(a: string): Promise<TokenDetail | undefined> {
    const [r] = await query(`select ${tokenSelect} ${tokenFrom} where tk.address = $1`, [bytes(a)]);
    if (!r) return undefined;
    const [g] = await query("select instrument_admin, instrument_id, custody::text as custody, holdings, supply::text as supply, supply_block, ledger_offset, read_at from gateway_tokens where evm_token = $1", [bytes(a)]);
    const canton = g ? { instrumentAdmin: g.instrument_admin, instrumentId: g.instrument_id, custody: g.custody, custodyDecimals: CUSTODY_DECIMALS, holdings: Number(g.holdings), supply: g.supply ?? null, supplyBlock: Number(g.supply_block), ledgerOffset: Number(g.ledger_offset), readAt: new Date(g.read_at).toISOString() } : null;
    return { ...tokenItem(r), totalSupplyBlock: num(r.total_supply_block), balanceMode: r.balance_mode, canton, twin: await twinSupply(a) };
  }

  /**
   * The twin line of an ERC-20 that a registered vault holds or took in (null for any other token): one row of what the indexer keeps per token (`twin_totals`, counted once per leg). `supply` is the locks less
   * the releases, and `vaultBalance` is what the registered vaults held of the token at the SAME block, `through`, that the sums are counted to (both are written by one pass of the indexer in one transaction), so
   * the two never differ because one trails the other; `vaultBalance` is null where reth did not give it at that block.
   */
  async function twinSupply(a: string): Promise<TwinSupply | null> {
    const [t] = await query("select t.locked::text as locked, t.released::text as released, t.locks, t.releases, t.vault_balance::text as vault_balance, (select value from meta where key = 'twin_totals_block') as through from twin_totals t where t.token = $1 and exists (select 1 from canton_registry where kind = 'vault')", [bytes(a)]);
    if (!t) return null;
    const vaultBalance: string | null = t.vault_balance ?? null;
    if (Number(t.locks) === 0 && Number(t.releases) === 0 && (vaultBalance === null || vaultBalance === "0")) return null;
    return { supply: (BigInt(t.locked) - BigInt(t.released)).toString(), vaultBalance, locks: Number(t.locks), releases: Number(t.releases), through: t.through == null ? null : Number(t.through) };
  }

  /** Who holds a token, most first, after the key (value, holder, id). A holder of several ids of an ERC-1155 is listed once for each. */
  async function holders(a: string, before: Key | null, limit: number): Promise<HolderItem[]> {
    const [value, holder, id] = before ?? [null, null, null];
    const rows = await query(
      `select b.holder, b.token_id::text as token_id, b.value::text as value, b.updated_block from token_balances b
       where b.token = $1 and b.value > 0 and ($2::numeric is null or (b.value, b.holder, b.token_id) < ($2::numeric, $3::bytea, $4::numeric)) order by b.value desc, b.holder desc, b.token_id desc limit $5`,
      [bytes(a), value, holder === null ? null : bytes(holder as string), id, limit + 1],
    );
    return rows.map((r) => ({ holder: hex(r.holder), tokenId: r.token_id, value: r.value, updatedBlock: Number(r.updated_block) }));
  }

  /** A token's transfers, newest first, after the key (block, log, batch). */
  async function tokenTransfers(a: string, before: Key | null, limit: number): Promise<TokenTransferItem[]> {
    const [bn, li, bi] = before ?? [null, null, null];
    const rows = await query(
      `select ${transferSelect} from token_transfers x ${transferJoins}
       where x.token = $1 and ($2::bigint is null or (x.block_number, x.log_index, x.batch_index) < ($2::bigint, $3::int, $5::int)) order by x.block_number desc, x.log_index desc, x.batch_index desc limit $4`,
      [bytes(a), bn, li, limit + 1, bi],
    );
    return rows.map(transferItem);
  }

  const legSelect = `g.block_number, g.leg_index, g.tx_index, g.log_index, g.kind, g.leg_id, g.token, g.account, g.amount::text as amount, g.party, g.gateway, t.hash, ${TWIN_SELECT}`;
  // The legs a page reads are picked first, so that the twin legs are told for the page's rows and not for the table's.
  const legFrom = (pick = "gateway_legs") => `from ${pick} g left join transactions t on t.block_number = g.block_number and t.tx_index = g.tx_index ${TWIN_FROM}`;
  const legItem = (r: Row): LegListItem => ({
    block: Number(r.block_number), txHash: hexOrNull(r.hash), legIndex: r.leg_index, txIndex: r.tx_index, logIndex: r.log_index, kind: legKindOf(r), gateway: gatewayOf(r), twin: twinOf(r), legId: hex(r.leg_id),
    token: hex(r.token), account: hex(r.account), amount: r.amount, party: r.party ?? null,
  });

  /** The gateway's legs, newest first, after the key (block, leg index). */
  async function legs(before: Key | null, limit: number): Promise<LegListItem[]> {
    const [bn, li] = before ?? [null, null];
    const rows = await query(
      `select ${legSelect} ${legFrom("(select * from gateway_legs where ($1::bigint is null or (block_number, leg_index) < ($1::bigint, $2::int)) order by block_number desc, leg_index desc limit $3)")} order by g.block_number desc, g.leg_index desc`,
      [bn, li, limit + 1],
    );
    return rows.map(legItem);
  }

  /**
   * The swaps: each venue trade that a payment settled, with the payer, the funded claim and the token, and the deposit that redeemed the claim, if one did. The payment is the leg the venue
   * read recorded on the trade (`payment_block`, `payment_leg_index`: the first payment of the trade's id that pays its token, to its payee, for its amount); a payment that no trade is behind
   * is not a swap (it is in the legs list). The deposit counts only when it is for the claim's recipient, for its amount and in its registered token. Newest first, after the key (block, leg index)
   * of the payment, by the partial index on those two columns: a page reads its own rows, not the payments between them. The recipient is the claim's once the claim is read, the offer's before.
   */
  const swapSelect = `vt.pay_id, g.block_number, g.leg_index, g.token, g.account as payee, g.amount::text as amount, vt.claim_id, coalesce(fc.recipient, vt.recipient) as recipient, vt.offered_update_id,
    pt.hash as pay_tx_hash, pt.from_address as payer, pb.update_id as pay_update_id, ${US("pb.record_time")} as pay_record_time,
    fc.amount::text as canton_amount, fc.funded_update_id, ct.instrument_admin, ct.instrument_id, tk.symbol, tk.decimals,
    cl.block_number as claim_block, cl.leg_index as claim_leg_index, cl.tx_hash as claim_tx_hash, cl.update_id as claim_update_id, cl.record_time as claim_record_time`;
  const swapFrom = `from canton_venue_trades vt
    join gateway_legs g on g.block_number = vt.payment_block and g.leg_index = vt.payment_leg_index
    join blocks pb on pb.number = g.block_number
    left join transactions pt on pt.block_number = g.block_number and pt.tx_index = g.tx_index
    left join canton_funded_claims fc on fc.claim_id = vt.claim_id
    left join canton_gateway_tokens ct on ct.contract_id = coalesce(fc.gateway_token, vt.gateway_token)
    left join tokens tk on tk.address = g.token
    left join lateral (
      select d.block_number, d.leg_index, dt.hash as tx_hash, db.update_id, ${US("db.record_time")} as record_time
      from gateway_legs d join blocks db on db.number = d.block_number
        left join transactions dt on dt.block_number = d.block_number and dt.tx_index = d.tx_index
      where fc.claim_id is not null and d.kind = 1 and d.leg_id = fc.claim_id and d.account = fc.recipient and d.amount = fc.amount and d.token = ct.evm_token order by d.block_number, d.leg_index limit 1
    ) cl on true`;
  const swapItem = (r: Row): SwapItem => ({
    payId: hex(r.pay_id), claimId: hex(r.claim_id), status: r.claim_block === null ? "settled" : "claimed", offer: { updateId: r.offered_update_id },
    evm: { token: hex(r.token), symbol: r.symbol ?? null, decimals: num(r.decimals), payer: hexOrNull(r.payer), payee: hex(r.payee), amount: r.amount },
    canton: { amount: r.canton_amount ?? null, instrument: r.instrument_id ? { admin: r.instrument_admin, id: r.instrument_id } : null, recipient: hex(r.recipient), updateId: r.funded_update_id ?? null },
    payment: { block: Number(r.block_number), txHash: hexOrNull(r.pay_tx_hash), legIndex: r.leg_index, updateId: r.pay_update_id, recordTime: isoTime(r.pay_record_time) },
    claim: r.claim_block === null ? null : { block: Number(r.claim_block), txHash: hexOrNull(r.claim_tx_hash), legIndex: r.claim_leg_index, updateId: r.claim_update_id, recordTime: isoTime(r.claim_record_time) },
  });

  async function swaps(before: Key | null, limit: number): Promise<SwapItem[]> {
    const [bn, li] = before ?? [null, null];
    const rows = await query(
      `select ${swapSelect} ${swapFrom} where vt.payment_block is not null and ($1::bigint is null or (vt.payment_block, vt.payment_leg_index) < ($1::bigint, $2::int))
       order by vt.payment_block desc, vt.payment_leg_index desc limit $3`,
      [bn, li, limit + 1],
    );
    return rows.map(swapItem);
  }

  /** One swap by its payment id. */
  async function swap(payId: string): Promise<SwapItem | undefined> {
    const [r] = await query(`select ${swapSelect} ${swapFrom} where vt.pay_id = $1 and vt.payment_block is not null`, [bytes(payId)]);
    return r && swapItem(r);
  }

  /** One leg by its id. An id is a hash of the leg, so one is expected to name one leg; if the same leg is ever recorded twice, this is the first. */
  async function leg(id: string): Promise<LegListItem | undefined> {
    const [r] = await query(`select ${legSelect} ${legFrom()} where g.leg_id = $1 order by g.block_number, g.leg_index limit 1`, [bytes(id)]);
    return r && legItem(r);
  }

  /** The tokens (by name or symbol) and verified contracts (by name) that start with the text, tokens first, at most `limit`. The text is matched as it is, never as a pattern. */
  async function byName(text: string, limit: number): Promise<NameMatch[]> {
    const like = text.replace(/[\\%_]/g, "\\$&") + "%";
    const found = await query(
      "select address, name, symbol from tokens where name ilike $1 or symbol ilike $1 order by holder_count desc, address limit $2",
      [like, limit],
    );
    const matches: NameMatch[] = found.map((r) => ({ kind: "token", name: r.name, symbol: r.symbol, address: hex(r.address) }));
    if (matches.length < limit) {
      const contracts = await query(
        "select c.address, c.name from contracts c where c.name ilike $1 and c.verified_source is not null and not exists (select 1 from tokens t where t.address = c.address) order by c.interaction_count desc, c.address limit $2",
        [like, limit - matches.length],
      );
      matches.push(...contracts.map((r): NameMatch => ({ kind: "contract", name: r.name, symbol: null, address: hex(r.address) })));
    }
    return matches;
  }

  return {
    derivedThrough, tokenCounts, addresses, address, addressTxs, addressInternal, addressTransfers, contractEvents, holdings, allTransfers, coinHistory, contracts, contractsMadeBy, contractCounts, eventCountOf, contract, source, tokens, token, holders, tokenTransfers, legs, leg, swaps, swap, byName, labels,
  };
}
