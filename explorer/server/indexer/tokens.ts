/**
 * Tokens, transfers and the balances worked out from them (design sections 4.3 and 5.2). Stage 2 reads the block's logs and decodes the ERC-20, ERC-721
 * and ERC-1155 transfers of contracts the explorer knows (a transfer-shaped log from an address that is no known contract is not a token), makes a
 * `tokens` row for each new token with name, symbol, decimals and supply read with `eth_call` at the block (a call that fails leaves the field empty
 * and the status `failed`, which the background check tries again), writes `token_transfers`, and adds the block to the derived balances, the NFT owners,
 * the holder and transfer counts and the addresses' token transfer counts.
 *
 * Balances add up, so this runs behind stage 2's guard, once for each block. A token whose `balance_mode` is `read` (the background check found it
 * takes a fee or rebases) is not added up: the holders a block touched are marked unchecked and the check reads them with `balanceOf`.
 * `aggregates.ts` rebuilds all of this from the fact tables, with the same SQL for the transfers' legs.
 */
import { decodeAbiParameters, keccak256, toHex } from "viem";
import type { PoolClient } from "pg";
import { RethError } from "../reth.ts";
import type { FinalReads } from "./reads.ts";

export type Standard = "ERC-20" | "ERC-721" | "ERC-1155";

export const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));
export const SINGLE_TOPIC = keccak256(toHex("TransferSingle(address,address,address,uint256,uint256)"));
export const BATCH_TOPIC = keccak256(toHex("TransferBatch(address,address,address,uint256[],uint256[])"));

/** The four reads of a token's metadata, and the two reads of a balance. */
export const SELECTORS = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd", balanceOf: "0x70a08231", balanceOf1155: "0x00fdd58e" } as const;

export interface Transfer {
  logIndex: number;
  batchIndex: number;
  txIndex: number;
  token: string;
  from: string;
  to: string;
  standard: Standard;
  /** ERC-20 and ERC-1155. */
  amount: bigint | null;
  /** ERC-721 and ERC-1155. */
  tokenId: bigint | null;
}

export interface LogRow { log_index: number; tx_index: number; address: Buffer; topic0: Buffer | null; topic1: Buffer | null; topic2: Buffer | null; topic3: Buffer | null; data: Buffer }

const hex = (b: Buffer): string => "0x" + b.toString("hex");
const word = (b: Buffer): bigint => BigInt(hex(b));
const who = (topic: Buffer): string => "0x" + topic.subarray(12).toString("hex");

/** The transfers a log states, none for a log that is not shaped as the standards say (the same event signature is ERC-20's and ERC-721's: the topics tell them apart). */
export function decodeTransfers(r: LogRow): Transfer[] {
  const t = r.topic0 === null ? null : hex(r.topic0);
  const base = { logIndex: r.log_index, txIndex: r.tx_index, token: hex(r.address) };
  if (t === TRANSFER_TOPIC && r.topic1 && r.topic2 && r.topic3 === null && r.data.length === 32) {
    return [{ ...base, batchIndex: 0, from: who(r.topic1), to: who(r.topic2), standard: "ERC-20", amount: word(r.data), tokenId: null }];
  }
  if (t === TRANSFER_TOPIC && r.topic1 && r.topic2 && r.topic3 && r.data.length === 0) {
    return [{ ...base, batchIndex: 0, from: who(r.topic1), to: who(r.topic2), standard: "ERC-721", amount: null, tokenId: word(r.topic3) }];
  }
  if (t === SINGLE_TOPIC && r.topic1 && r.topic2 && r.topic3 && r.data.length === 64) {
    return [{ ...base, batchIndex: 0, from: who(r.topic2), to: who(r.topic3), standard: "ERC-1155", tokenId: word(r.data.subarray(0, 32)), amount: word(r.data.subarray(32)) }];
  }
  if (t === BATCH_TOPIC && r.topic1 && r.topic2 && r.topic3 && r.data.length >= 128) {
    try {
      const [ids, values] = decodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], hex(r.data) as `0x${string}`);
      if (ids.length !== values.length) return [];
      return ids.map((id, i) => ({ ...base, batchIndex: i, from: who(r.topic2!), to: who(r.topic3!), standard: "ERC-1155" as const, tokenId: id, amount: values[i]! }));
    } catch {
      return []; // data that does not decode as two arrays is not a TransferBatch
    }
  }
  return [];
}

/** A string a token answers: ABI `string`, or the `bytes32` that older tokens use; null for an answer that is neither. Control characters are dropped (PostgreSQL text holds no NUL). */
export function decodeText(output: string): string | null {
  const clean = (s: string) => s.replace(/[\u0000-\u001f]/g, "").slice(0, 256);
  try {
    if (output.length === 66) return clean(Buffer.from(output.slice(2), "hex").toString("utf8")) || null;
    const [s] = decodeAbiParameters([{ type: "string" }], output as `0x${string}`);
    return clean(s) || null;
  } catch {
    return null;
  }
}

const uint = (output: string): bigint | null => (/^0x[0-9a-f]{64}$/.test(output) ? BigInt(output) : null);

/** An `eth_call` that reth answered with an error (the contract has no such function, or it reverts) is no answer; one that did not come back at all is thrown, and stage 2 is tried again. */
export async function tryCall(reads: Pick<FinalReads, "call">, to: string, input: string, n: number): Promise<string | null> {
  try {
    return await reads.call(to, input, n);
  } catch (e) {
    if (e instanceof RethError && e.answered) return null;
    throw e;
  }
}

export interface Metadata { name: string | null; symbol: string | null; decimals: number | null; totalSupply: bigint | null; status: "read" | "failed" }

/** A token's metadata at block `n`. An ERC-1155 has none to read. A token is `read` when what its standard requires is answered (see below). */
export async function readMetadata(reads: Pick<FinalReads, "call">, token: string, standard: Standard, n: number): Promise<Metadata> {
  if (standard === "ERC-1155") return { name: null, symbol: null, decimals: null, totalSupply: null, status: "read" };
  const [name, symbol, decimals, supply] = (await Promise.all([SELECTORS.name, SELECTORS.symbol, SELECTORS.decimals, SELECTORS.totalSupply].map((s) => tryCall(reads, token, s, n)))) as (string | null)[];
  const d = standard === "ERC-20" && decimals != null ? uint(decimals) : null;
  const totalSupply = supply == null ? null : uint(supply);
  return {
    name: name == null ? null : decodeText(name), symbol: symbol == null ? null : decodeText(symbol), decimals: d !== null && d <= 255n ? Number(d) : null, totalSupply,
    // An ERC-20 is read when its supply answers; an ERC-721's supply comes only with the Enumerable extension, so its name or symbol is enough.
    status: totalSupply !== null || (standard === "ERC-721" && (name !== null || symbol !== null)) ? "read" : "failed",
  };
}

const bytea = (h: string): Buffer => Buffer.from(h.slice(2), "hex");
const WIDTH = 8;

/**
 * The legs of the transfers a filter selects, as SQL: one row for each account whose balance moves, with the change (an NFT counts one; the zero address
 * has no balance). The filter and the mode are put in by the caller; the placeholders `$1`, `$2` and so on are the caller's.
 */
export function legsSql(filter: string, mode: "derived" | "read"): string {
  return `select t.token, x.holder, case when k.standard = 'ERC-1155' then t.token_id else 0 end as tid,
            x.sign * (case when k.standard = 'ERC-721' then 1 else t.amount end) as delta, t.block_number as block
          from token_transfers t join tokens k on k.address = t.token
          cross join lateral (values (t.from_address, -1), (t.to_address, 1)) as x(holder, sign)
          where ${filter} and k.balance_mode = '${mode}' and x.holder <> '\\x0000000000000000000000000000000000000000'::bytea`;
}

/**
 * Block `n`'s tokens, transfers and balances, from the logs stage 1 wrote, in the caller's transaction. Returns how many transfers.
 * Called once for each block (stage 2's guard); a reindex calls `writeTransfers` alone and rebuilds the aggregates after.
 */
export async function writeTokens(c: Pick<PoolClient, "query">, n: number, reads: Pick<FinalReads, "call">): Promise<number> {
  const count = await writeTransfers(c, n, reads);
  if (count === 0) return 0;
  // Read-mode tokens: the holders the block touched are read again by the check.
  await c.query(
    `insert into token_balances (token, holder, token_id, value, updated_block, checked_block)
     select token, holder, tid, 0, $1, null from (${legsSql("t.block_number = $1", "read")}) l group by token, holder, tid order by token, holder, tid
     on conflict (token, holder, token_id) do update set updated_block = excluded.updated_block, checked_block = null, unanswered = false`,
    [n],
  );
  // Derived tokens: add the block's changes, and move the holder count by the holders that crossed zero. A holder is counted once, whatever number of
  // ids (an ERC-1155's) it holds: `before` is the number of ids it held before the block (an ERC-1155's rows by the primary key's prefix; any other token has one id), and the block moves it by
  // `change` ids. Every look-up is by the primary key and no set is joined back to itself, so the time follows the keys. The statement reads the balances as they
  // were before its own insert (one snapshot).
  const moved = await c.query(
    `with d as (select token, holder, tid, sum(delta) as delta from (${legsSql("t.block_number = $1", "derived")}) l group by token, holder, tid),
          up as (
            insert into token_balances (token, holder, token_id, value, updated_block, checked_block, unanswered)
            select token, holder, tid, delta, $1, null, false from d order by token, holder, tid
            on conflict (token, holder, token_id) do update set value = token_balances.value + excluded.value, updated_block = excluded.updated_block, checked_block = null, unanswered = false
            returning 1
          ),
          dn as (
            select d.token, d.holder, k.standard = 'ERC-1155' as multi, (coalesce(o.value, 0) > 0)::int as pos_before, (coalesce(o.value, 0) + d.delta > 0)::int as pos_after
            from d join tokens k on k.address = d.token left join token_balances o on o.token = d.token and o.holder = d.holder and o.token_id = d.tid
          ),
          h as (select token, holder, multi, sum(pos_before) as touched, sum(pos_after - pos_before) as change from dn group by token, holder, multi),
          b as (
            select token, change, case when multi then (select count(*) from token_balances x where x.token = h.token and x.holder = h.holder and x.value > 0) else touched end as before
            from h
          )
     select token, sum(((before + change) > 0)::int - (before > 0)::int)::int as holders from b group by token`,
    [n],
  );
  // The block's tokens are locked in address order, as the check locks its batch's (balances.ts), before any of them is updated.
  await c.query("select 1 from tokens where address in (select token from token_transfers where block_number = $1) order by address for update", [n]);
  await c.query(
    `update tokens k set transfer_count = k.transfer_count + t.n, holder_count = k.holder_count + coalesce(h.holders, 0)
     from (select token, count(*) as n from token_transfers where block_number = $1 group by token) t
     left join (select unnest($2::bytea[]) as token, unnest($3::int[]) as holders) h on h.token = t.token
     where k.address = t.token`,
    [n, moved.rows.map((r) => r.token as Buffer), moved.rows.map((r) => r.holders as number)],
  );
  await c.query(
    `insert into nft_owners (token, token_id, owner, updated_block)
     select distinct on (t.token, t.token_id) t.token, t.token_id, t.to_address, t.block_number
     from token_transfers t join tokens k on k.address = t.token and k.standard = 'ERC-721' where t.block_number = $1
     order by t.token, t.token_id, t.log_index desc
     on conflict (token, token_id) do update set owner = excluded.owner, updated_block = excluded.updated_block where nft_owners.updated_block <= excluded.updated_block`,
    [n],
  );
  // The accounts in the block's transfers are seen in this block, and each counts the transfers it is in (once for a transfer to itself).
  await c.query(
    `insert into addresses (address, first_seen_block, last_active_block, token_transfer_count, is_contract)
     select a, $1, $1, n, exists (select 1 from contracts k where k.address = p.a) from (
       select a, count(*) as n from (
         select from_address as a from token_transfers where block_number = $1
         union all select to_address from token_transfers where block_number = $1 and to_address <> from_address
       ) q where a <> '\\x0000000000000000000000000000000000000000'::bytea group by a
     ) p order by a
     on conflict (address) do update set first_seen_block = least(addresses.first_seen_block, excluded.first_seen_block),
       last_active_block = greatest(addresses.last_active_block, excluded.last_active_block), token_transfer_count = addresses.token_transfer_count + excluded.token_transfer_count`,
    [n],
  );
  return count;
}

/**
 * The block's transfers and new tokens, with no balance or counter touched. A transfer counts only when its address is a contract the explorer knows
 * (the tokens table refers to contracts) and the log is shaped like the standard the token was first seen with.
 */
export async function writeTransfers(c: Pick<PoolClient, "query">, n: number, reads: Pick<FinalReads, "call">): Promise<number> {
  const logs = (await c.query(
    `select l.log_index, l.tx_index, l.address, l.topic0, l.topic1, l.topic2, l.topic3, l.data from logs l
     where l.block_number = $1 and l.topic0 = any($2::bytea[]) and exists (select 1 from contracts k where k.address = l.address) order by l.log_index`,
    [n, [TRANSFER_TOPIC, SINGLE_TOPIC, BATCH_TOPIC].map(bytea)],
  )).rows as LogRow[];
  const found = logs.flatMap(decodeTransfers);
  if (found.length === 0) return 0;
  // A token's standard is the one it is already known by, else the first its logs show.
  const standards = new Map<string, Standard>();
  const known = (await c.query("select address, standard from tokens where address = any($1::bytea[])", [[...new Set(found.map((t) => t.token))].map(bytea)])).rows;
  for (const r of known) standards.set(hex(r.address), r.standard as Standard);
  const fresh = new Map<string, Standard>();
  for (const t of found) {
    if (!standards.has(t.token)) { standards.set(t.token, t.standard); fresh.set(t.token, t.standard); }
  }
  const transfers = found.filter((t) => standards.get(t.token) === t.standard);
  if (fresh.size > 0) {
    const list = [...fresh.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const meta: Metadata[] = [];
    for (let i = 0; i < list.length; i += WIDTH) meta.push(...(await Promise.all(list.slice(i, i + WIDTH).map(([a, s]) => readMetadata(reads, a, s, n)))));
    await c.query(
      `insert into tokens (address, standard, name, symbol, decimals, total_supply, total_supply_block, first_transfer_block, metadata_status, gateway_wrapped)
       select t.a, t.s, t.nm, t.sy, t.d, t.ts::numeric, case when t.ts is null then null else $1::bigint end, $1, t.st,
              coalesce(k.creator = decode(substr(m.value, 3), 'hex'), false)
       from unnest($2::bytea[], $3::text[], $4::text[], $5::text[], $6::int[], $7::text[], $8::text[]) as t(a, s, nm, sy, d, ts, st)
       left join contracts k on k.address = t.a left join meta m on m.key = 'gateway_address'
       on conflict (address) do nothing`,
      [n, list.map(([a]) => bytea(a)), list.map(([, s]) => s), meta.map((m) => m.name), meta.map((m) => m.symbol), meta.map((m) => m.decimals),
        meta.map((m) => (m.totalSupply === null ? null : m.totalSupply.toString())), meta.map((m) => m.status)],
    );
    await nameContracts(c, list.map(([a]) => bytea(a)));
  }
  await c.query(
    `insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount, token_id)
     select $1::bigint, t.l, t.b, t.x, t.k, t.f, t.t, t.am::numeric, t.id::numeric
     from unnest($2::int[], $3::int[], $4::int[], $5::bytea[], $6::bytea[], $7::bytea[], $8::text[], $9::text[]) as t(l, b, x, k, f, t, am, id)`,
    [n, transfers.map((t) => t.logIndex), transfers.map((t) => t.batchIndex), transfers.map((t) => t.txIndex), transfers.map((t) => bytea(t.token)), transfers.map((t) => bytea(t.from)),
      transfers.map((t) => bytea(t.to)), transfers.map((t) => (t.amount === null ? null : t.amount.toString())), transfers.map((t) => (t.tokenId === null ? null : t.tokenId.toString()))],
  );
  return transfers.length;
}

/** A contract with no name of its own takes its token's name (the page of a verified contract keeps the name of its source). */
export async function nameContracts(c: Pick<PoolClient, "query">, tokens: Buffer[]): Promise<void> {
  await c.query(
    `update contracts k set name = t.name from tokens t where t.address = k.address and k.address = any($1::bytea[]) and k.name is null and k.verified_source is null and t.name is not null`,
    [tokens],
  );
}

