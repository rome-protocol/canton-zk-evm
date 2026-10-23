/**
 * The reads behind the REST routes of addresses, contracts, tokens and gateway legs (design 6.1), as the indexer's rows hold them. Nothing here writes.
 * Lists take a keyset (the parts of the last row's sort key) and a limit, and are asked for one row more than they show. Most of what is read here is written
 * by stage 2 (the counters, the contracts, the tokens and their transfers) or by the background check of balances behind it, so a list is complete only up to the
 * derive cursor: `derivedThrough` gives the cursor and the head, and the routes say so.
 */
import type { Pool } from "pg";
import { ChainDbError } from "../chain-db.ts";
import { addressOfKey, bytes, hex, hexOrNull, MS, txSelect, type TxListItem, txItem } from "./chain-rest.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Key = (number | string)[];
const LEG_KINDS = ["", "deposit", "withdrawal", "payment"] as const;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export type AddressSort = "balance" | "txs";
export type ContractSort = "interactions" | "newest" | "oldest";
export type TokenSort = "holders" | "transfers" | "newest";

export interface AddressItem { address: string; kind: string; balance: string | null; balanceBlock: number | null; txCount: number }
export interface AddressDetail {
  address: string; kind: string; sentCount: number; receivedCount: number; internalCount: number; tokenTransferCount: number; firstSeenBlock: number | null; lastActiveBlock: number | null;
  token: { name: string | null; symbol: string | null; decimals: number | null } | null; createdBy: { txHash: string | null; block: number } | null;
}
export interface AddressInternalItem {
  txHash: string; block: number; txIndex: number; traceAddress: number[]; callType: string; from: string; to: string | null; value: string; gas: number | null; gasUsed: number | null;
  selector: string | null; inputSize: number | null; error: string | null;
}
/** A log a contract wrote, with the transaction it is in and that transaction's method (the first 4 bytes of its input, null when it has none). */
export interface ContractEventItem { txHash: string; block: number; txIndex: number; logIndex: number; address: string; topics: string[]; data: string; method: string | null }
export interface TokenTransferItem { txHash: string; block: number; txIndex: number; logIndex: number; batchIndex: number; token: string; from: string; to: string; amount: string | null; tokenId: string | null }
export interface Holding { token: string; standard: string; name: string | null; symbol: string | null; decimals: number | null; tokenId: string; value: string; updatedBlock: number }
export interface CoinPoint { block: number; balance: string }
/** Shown with a partial match: the library lets the metadata (the CBOR at the end of the code, and of any contract embedded in it) differ from the compile. */
export const PARTIAL_MATCH_NOTE = "Partial match: the metadata differs from this compile. Code that reads its own or another contract's code (type(X).creationCode/runtimeCode, codecopy, extcodecopy, address(this).code) may act differently from this source's compile; only a full match is byte-for-byte.";
export const matchNote = (matchType: string | null): string | null => (matchType === "partial" ? PARTIAL_MATCH_NOTE : null);

export interface ContractItem {
  address: string; name: string | null; origin: string; creator: string | null; creationBlock: number | null; creationTxIndex: number | null; interactionCount: number; verified: boolean; matchType: string | null; codeSize: number;
  destroyedBlock: number | null;
  /** The token standard when the contract is a token. The balance and the counts are the explorer's copy, as of `balanceBlock`; a contract it has not seen move has none. */
  standard: string | null; balance: string | null; balanceBlock: number | null; txCount: number; internalCount: number;
}
export interface ContractDetail extends ContractItem {
  creationTxHash: string | null; lastInteractionBlock: number | null; codeHash: string; code: string;
  proxy: { kind: string; implementation: string | null; beacon: string | null; checkedBlock: number } | null;
  verification: {
    language: string; compilerVersion: string; codeFormat: string; contractPath: string; contractName: string; optimizerEnabled: boolean | null; optimizerRuns: number | null; evmVersion: string | null;
    license: string | null; verifiedAt: string; matchNote: string | null;
  } | null;
}
export interface SourceDetail {
  matchType: string; language: string; compilerVersion: string; codeFormat: string; contractPath: string; contractName: string; optimizerEnabled: boolean | null; optimizerRuns: number | null;
  evmVersion: string | null; license: string | null; settings: unknown; files: { path: string; content: string }[]; abi: unknown; constructorArgs: string | null; libraries: unknown; verifiedAt: string; matchNote: string | null;
}
export interface TokenItem {
  address: string; standard: string; name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null; holderCount: number; transferCount: number; firstTransferBlock: number;
  gatewayWrapped: boolean; metadataStatus: string;
}
export interface TokenDetail extends TokenItem { totalSupplyBlock: number | null; balanceMode: string }
export interface HolderItem { holder: string; tokenId: string; value: string; updatedBlock: number }
export interface LegListItem { block: number; txHash: string | null; legIndex: number; txIndex: number; logIndex: number; kind: string; legId: string; token: string; account: string; amount: string }
export interface NameMatch { kind: "token" | "contract"; name: string | null; symbol: string | null; address: string }

export type AccountRest = ReturnType<typeof createAccountRest>;

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

  /** What the database holds of an address: the counters, the kind, the token it is and the transaction that made it. Undefined for an address nothing has touched. */
  async function address(a: string): Promise<AddressDetail | undefined> {
    const [r] = await query(
      `select ad.sent_count, ad.received_count, ad.internal_count, ad.token_transfer_count, ad.first_seen_block, ad.last_active_block, ad.is_contract,
         tk.address is not null as is_token, tk.name, tk.symbol, tk.decimals, c.address is not null as has_contract, c.creation_block,
         (select t.hash from transactions t where t.block_number = c.creation_block and t.tx_index = c.creation_tx_index) as creation_tx
       from (select $1::bytea as address) q left join addresses ad on ad.address = q.address left join contracts c on c.address = q.address left join tokens tk on tk.address = q.address`,
      [bytes(a)],
    );
    if (!r || (r.sent_count === null && !r.has_contract)) return undefined;
    return {
      address: a, kind: r.is_token ? "token" : r.is_contract || r.has_contract ? "contract" : "account", sentCount: Number(r.sent_count ?? 0), receivedCount: Number(r.received_count ?? 0),
      internalCount: Number(r.internal_count ?? 0), tokenTransferCount: Number(r.token_transfer_count ?? 0), firstSeenBlock: num(r.first_seen_block), lastActiveBlock: num(r.last_active_block),
      token: r.is_token ? { name: r.name, symbol: r.symbol, decimals: num(r.decimals) } : null,
      createdBy: r.creation_block === null || r.creation_block === undefined ? null : { txHash: hexOrNull(r.creation_tx), block: Number(r.creation_block) },
    };
  }

  /** The transactions an address sent, received or was made by, newest first, after the key (block, index). */
  async function addressTxs(a: string, before: Key | null, limit: number): Promise<TxListItem[]> {
    const [bn, ix] = before ?? [null, null];
    const side = (column: string) =>
      `(select block_number, tx_index from transactions where ${column} = $1 and ($2::bigint is null or (block_number, tx_index) < ($2::bigint, $3::int)) order by block_number desc, tx_index desc limit $4)`;
    const rows = await query(
      `with k as (${side("from_address")} union ${side("to_address")} union ${side("created_contract")})
       select ${txSelect} from k join transactions t on t.block_number = k.block_number and t.tx_index = k.tx_index join blocks b on b.number = t.block_number
       order by t.block_number desc, t.tx_index desc limit $4`,
      [bytes(a), bn, ix, limit + 1],
    );
    return rows.map(txItem);
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

  /** The logs written by one contract, newest first, after the key (block, log index); `topic0` keeps one kind of event. The index is (address, block_number). */
  async function contractEvents(a: string, topic0: string | null, before: Key | null, limit: number): Promise<ContractEventItem[]> {
    const [bn, li] = before ?? [null, null];
    const rows = await query(
      `select l.block_number, l.log_index, l.tx_index, l.address, l.topic0, l.topic1, l.topic2, l.topic3, l.data, t.hash, t.method_id
       from logs l join transactions t on t.block_number = l.block_number and t.tx_index = l.tx_index
       where l.address = $1 and ($2::bytea is null or l.topic0 = $2) and ($3::bigint is null or (l.block_number, l.log_index) < ($3::bigint, $4::int))
       order by l.block_number desc, l.log_index desc limit $5`,
      [bytes(a), topic0 === null ? null : bytes(topic0), bn, li, limit + 1],
    );
    return rows.map((r) => ({
      txHash: hex(r.hash), block: Number(r.block_number), txIndex: r.tx_index, logIndex: r.log_index, address: hex(r.address),
      topics: [r.topic0, r.topic1, r.topic2, r.topic3].flatMap((t, i, all) => (t !== null && all.slice(0, i).every((x) => x !== null) ? [hex(t)] : [])), data: hex(r.data), method: hexOrNull(r.method_id),
    }));
  }

  const transferSelect = "x.block_number, x.log_index, x.batch_index, x.tx_index, x.token, x.from_address, x.to_address, x.amount::text as amount, x.token_id::text as token_id, t.hash";
  const transferItem = (r: Row): TokenTransferItem => ({
    txHash: hex(r.hash), block: Number(r.block_number), txIndex: r.tx_index, logIndex: r.log_index, batchIndex: r.batch_index, token: hex(r.token), from: hex(r.from_address), to: hex(r.to_address),
    amount: r.amount, tokenId: r.token_id,
  });

  /** The token transfers an address sent or received, newest first, after the key (block, log, batch). */
  async function addressTransfers(a: string, before: Key | null, limit: number): Promise<TokenTransferItem[]> {
    const [bn, li, bi] = before ?? [null, null, null];
    const side = (column: string) =>
      `(select block_number, log_index, batch_index from token_transfers where ${column} = $1
         and ($2::bigint is null or (block_number, log_index, batch_index) < ($2::bigint, $3::int, $5::int)) order by block_number desc, log_index desc, batch_index desc limit $4)`;
    const rows = await query(
      `with k as (${side("from_address")} union ${side("to_address")})
       select ${transferSelect} from k join token_transfers x on x.block_number = k.block_number and x.log_index = k.log_index and x.batch_index = k.batch_index
         join transactions t on t.block_number = x.block_number and t.tx_index = x.tx_index
       order by x.block_number desc, x.log_index desc, x.batch_index desc limit $4`,
      [bytes(a), bn, li, limit + 1, bi],
    );
    return rows.map(transferItem);
  }

  /** What an address holds, in the order of the token and its id, after the key (token, id). */
  async function holdings(a: string, after: Key | null, limit: number): Promise<Holding[]> {
    const [token, id] = after ?? [null, null];
    const rows = await query(
      `select b.token, tk.standard, tk.name, tk.symbol, tk.decimals, b.token_id::text as token_id, b.value::text as value, b.updated_block
       from token_balances b join tokens tk on tk.address = b.token
       where b.holder = $1 and b.value > 0 and ($2::bytea is null or (b.token, b.token_id) > ($2::bytea, $3::numeric)) order by b.token, b.token_id limit $4`,
      [bytes(a), token === null ? null : bytes(token as string), id, limit + 1],
    );
    return rows.map((r) => ({ token: hex(r.token), standard: r.standard, name: r.name, symbol: r.symbol, decimals: num(r.decimals), tokenId: r.token_id, value: r.value, updatedBlock: Number(r.updated_block) }));
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
    tk.standard, a.coin_balance::text as balance, a.coin_balance_block, coalesce(a.sent_count + a.received_count, 0) as tx_count, coalesce(a.internal_count, 0) as internal_count`;
  const withAccount = "left join addresses a on a.address = c.address left join tokens tk on tk.address = c.address";
  const contractItem = (r: Row): ContractItem => ({
    address: hex(r.address), name: r.name, origin: r.origin, creator: hexOrNull(r.creator), creationBlock: num(r.creation_block), creationTxIndex: num(r.creation_tx_index), interactionCount: Number(r.interaction_count),
    verified: r.verified_source !== null, matchType: r.match_type, codeSize: r.size, destroyedBlock: num(r.destroyed_block),
    standard: r.standard, balance: r.balance, balanceBlock: num(r.coin_balance_block), txCount: Number(r.tx_count), internalCount: Number(r.internal_count),
  });

  /**
   * The contract list. Interactions: most first. Newest or oldest: by the place of the creation (a genesis contract, which has none, is the oldest). The key is
   * the sort's own parts and then the address, so that two contracts of one place keep their order.
   */
  async function contracts(sort: ContractSort, verified: boolean | null, before: Key | null, limit: number): Promise<ContractItem[]> {
    const from = `from contracts c join bytecodes bc on bc.code_hash = c.runtime_code_hash ${withAccount}`;
    const filter = (n: number) => `($${n}::boolean is null or (c.verified_source is not null) = $${n})`;
    const [x, y, z] = before ?? [null, null, null];
    if (sort === "interactions") {
      const rows = await query(
        `select ${contractSelect} ${from} where ($1::bigint is null or (c.interaction_count, c.address) < ($1::bigint, $2::bytea)) and ${filter(4)} order by c.interaction_count desc, c.address desc limit $3`,
        [x, y === null ? null : bytes(y as string), limit + 1, verified],
      );
      return rows.map(contractItem);
    }
    const place = "(coalesce(c.creation_block, 0), coalesce(c.creation_tx_index, 0), c.address)";
    const dir = sort === "newest" ? ["<", "desc"] : [">", "asc"];
    const rows = await query(
      `select ${contractSelect} ${from} where ($1::bigint is null or ${place} ${dir[0]} ($1::bigint, $4::int, $2::bytea)) and ${filter(5)}
       order by coalesce(c.creation_block, 0) ${dir[1]}, coalesce(c.creation_tx_index, 0) ${dir[1]}, c.address ${dir[1]} limit $3`,
      [x, z === null ? null : bytes(z as string), limit + 1, y, verified],
    );
    return rows.map(contractItem);
  }

  /** One contract with its code, its proxy and what verification says. Undefined when none is held at the address. */
  async function contract(a: string): Promise<ContractDetail | undefined> {
    const [r] = await query(
      `select ${contractSelect}, encode(bc.code, 'hex') as code, (select t.hash from transactions t where t.block_number = c.creation_block and t.tx_index = c.creation_tx_index) as creation_tx,
         p.kind as proxy_kind, p.implementation, p.beacon, p.checked_block, v.match_type as source_match_type, v.language, v.compiler_version, v.code_format, v.contract_path, v.contract_name, v.optimizer_enabled, v.optimizer_runs,
         v.evm_version, v.license, ${MS("v.verified_at")} as verified_at
       from contracts c join bytecodes bc on bc.code_hash = c.runtime_code_hash ${withAccount} left join proxies p on p.proxy = c.address and p.checked_block >= coalesce(c.creation_block, 0) left join verified_sources v on v.id = c.verified_source where c.address = $1`,
      [bytes(a)],
    );
    if (!r) return undefined;
    return {
      ...contractItem(r), creationTxHash: hexOrNull(r.creation_tx), lastInteractionBlock: num(r.last_interaction_block), codeHash: hex(r.runtime_code_hash), code: "0x" + r.code,
      proxy: r.proxy_kind === null ? null : { kind: r.proxy_kind, implementation: hexOrNull(r.implementation), beacon: hexOrNull(r.beacon), checkedBlock: Number(r.checked_block) },
      verification: r.language === null ? null : {
        language: r.language, compilerVersion: r.compiler_version, codeFormat: r.code_format, contractPath: r.contract_path, contractName: r.contract_name, optimizerEnabled: r.optimizer_enabled,
        optimizerRuns: num(r.optimizer_runs), evmVersion: r.evm_version, license: r.license, verifiedAt: r.verified_at, matchNote: matchNote(r.source_match_type),
      },
    };
  }

  /** Whether a contract is held at the address, and, when it is verified, its source. */
  async function source(a: string): Promise<{ held: boolean; source: SourceDetail | null }> {
    const [r] = await query(
      `select v.match_type, v.language, v.compiler_version, v.code_format, v.contract_path, v.contract_name, v.optimizer_enabled, v.optimizer_runs, v.evm_version, v.license, v.settings, v.sources,
         v.abi, v.constructor_args, v.libraries, ${MS("v.verified_at")} as verified_at
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
        constructorArgs: hexOrNull(r.constructor_args), libraries: r.libraries, verifiedAt: r.verified_at, matchNote: matchNote(r.match_type),
      },
    };
  }

  const tokenSelect = "address, standard, name, symbol, decimals, total_supply::text as total_supply, total_supply_block, holder_count, transfer_count, first_transfer_block, metadata_status, gateway_wrapped, balance_mode";
  const tokenItem = (r: Row): TokenItem => ({
    address: hex(r.address), standard: r.standard, name: r.name, symbol: r.symbol, decimals: num(r.decimals), totalSupply: r.total_supply, holderCount: Number(r.holder_count),
    transferCount: Number(r.transfer_count), firstTransferBlock: Number(r.first_transfer_block), gatewayWrapped: r.gateway_wrapped, metadataStatus: r.metadata_status,
  });

  /** The token list: most holders, most transfers, or newest (by the block of its first transfer), then by address, after the key. */
  async function tokens(sort: TokenSort, before: Key | null, limit: number): Promise<TokenItem[]> {
    const column = { holders: "holder_count", transfers: "transfer_count", newest: "first_transfer_block" }[sort];
    const [x, y] = before ?? [null, null];
    const rows = await query(
      `select ${tokenSelect} from tokens where ($1::bigint is null or (${column}, address) < ($1::bigint, $2::bytea)) order by ${column} desc, address desc limit $3`,
      [x, y === null ? null : bytes(y as string), limit + 1],
    );
    return rows.map(tokenItem);
  }

  async function token(a: string): Promise<TokenDetail | undefined> {
    const [r] = await query(`select ${tokenSelect} from tokens where address = $1`, [bytes(a)]);
    return r && { ...tokenItem(r), totalSupplyBlock: num(r.total_supply_block), balanceMode: r.balance_mode };
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
      `select ${transferSelect} from token_transfers x join transactions t on t.block_number = x.block_number and t.tx_index = x.tx_index
       where x.token = $1 and ($2::bigint is null or (x.block_number, x.log_index, x.batch_index) < ($2::bigint, $3::int, $5::int)) order by x.block_number desc, x.log_index desc, x.batch_index desc limit $4`,
      [bytes(a), bn, li, limit + 1, bi],
    );
    return rows.map(transferItem);
  }

  const legSelect = "g.block_number, g.leg_index, g.tx_index, g.log_index, g.kind, g.leg_id, g.token, g.account, g.amount::text as amount, t.hash";
  const legFrom = "from gateway_legs g left join transactions t on t.block_number = g.block_number and t.tx_index = g.tx_index";
  const legItem = (r: Row): LegListItem => ({
    block: Number(r.block_number), txHash: hexOrNull(r.hash), legIndex: r.leg_index, txIndex: r.tx_index, logIndex: r.log_index, kind: LEG_KINDS[r.kind] ?? String(r.kind), legId: hex(r.leg_id),
    token: hex(r.token), account: hex(r.account), amount: r.amount,
  });

  /** The gateway's legs, newest first, after the key (block, leg index). */
  async function legs(before: Key | null, limit: number): Promise<LegListItem[]> {
    const [bn, li] = before ?? [null, null];
    const rows = await query(
      `select ${legSelect} ${legFrom} where ($1::bigint is null or (g.block_number, g.leg_index) < ($1::bigint, $2::int)) order by g.block_number desc, g.leg_index desc limit $3`,
      [bn, li, limit + 1],
    );
    return rows.map(legItem);
  }

  /** One leg by its id. An id is a hash of the leg, so one is expected to name one leg; if the same leg is ever recorded twice, this is the first. */
  async function leg(id: string): Promise<LegListItem | undefined> {
    const [r] = await query(`select ${legSelect} ${legFrom} where g.leg_id = $1 order by g.block_number, g.leg_index limit 1`, [bytes(id)]);
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
    derivedThrough, addresses, address, addressTxs, addressInternal, addressTransfers, contractEvents, holdings, coinHistory, contracts, contract, source, tokens, token, holders, tokenTransfers, legs, leg, byName,
  };
}
