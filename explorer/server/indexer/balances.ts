/**
 * The background check of balances (design section 4.3), off the critical path: it follows stage 2 behind its own cursor (`cursors.stream = 'balances'`)
 * and reads from reth what the transfers and the traces cannot say.
 *
 * - Coin balances: for each block, the accounts its transactions and internal calls name are read with `eth_getBalance` at that block. The value goes
 *   to `coin_balance_history` (the balance after that block) and, for the newest block read, to `addresses.coin_balance`.
 * - Token balances: a `token_balances` row with `checked_block` null (stage 2 wrote it, or a reindex cleared it) is read with `balanceOf` at its
 *   `updated_block`, which is the last block that moved it, so the derived value must be the answer. When they agree `checked_block` is set. When a
 *   token's derived balance disagrees (it takes a fee, or rebases) the token is switched to `balance_mode = 'read'` and all its balances are read.
 * - Token metadata that failed at the block is read again, and a token's total supply is refreshed.
 *
 * Each step reads from reth first and writes in one short transaction under the same shared lock the indexer takes, so a reindex pauses it.
 */
import type { Pool, PoolClient } from "pg";
import { Paused } from "./errors.ts";
import type { FinalReads } from "./reads.ts";
import { REINDEX_KEY } from "./reindex.ts";
import { deriveCursor } from "./stage2.ts";
import { nameContracts, readMetadata, SELECTORS, tryCall, type Standard } from "./tokens.ts";

export type BalanceReads = Pick<FinalReads, "call" | "balance">;
export interface BalanceCheck { blocks: number; coin: number; checked: number; switched: number; retried: number }

const WIDTH = 16;
const word = (b: Buffer): string => b.toString("hex").padStart(64, "0");
const uint = (output: string | null): bigint | null => (output !== null && /^0x[0-9a-f]{64}$/.test(output) ? BigInt(output) : null);

async function inLock<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query("begin");
    if (!(await c.query("select pg_try_advisory_xact_lock_shared($1) as ok", [REINDEX_KEY])).rows[0].ok) throw new Paused();
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    try { await c.query("rollback"); } catch { broken = true; }
    throw e;
  } finally {
    c.release(broken);
  }
}

async function inBatches<T, R>(items: T[], f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += WIDTH) out.push(...(await Promise.all(items.slice(i, i + WIDTH).map(f))));
  return out;
}

/** The coin balances of block `m`'s accounts, written with the cursor. */
async function coinBlock(pool: Pool, reads: BalanceReads, m: number): Promise<number> {
  const touched = (await pool.query(
    `select a from (
       select from_address as a from transactions where block_number = $1
       union select to_address from transactions where block_number = $1
       union select created_contract from transactions where block_number = $1
       union select from_address from internal_calls where block_number = $1
       union select to_address from internal_calls where block_number = $1
     ) q where a is not null order by a`, [m])).rows.map((r) => r.a as Buffer);
  const values = await inBatches(touched, (a) => reads.balance("0x" + a.toString("hex"), m));
  await inLock(pool, async (c) => {
    if (touched.length > 0) {
      await c.query(
        `insert into coin_balance_history (address, block_number, value) select t.a, $1::bigint, t.v::numeric from unnest($2::bytea[], $3::text[]) as t(a, v)
         on conflict (address, block_number) do update set value = excluded.value`,
        [m, touched, values.map((v) => v.toString())],
      );
      await c.query(
        `update addresses x set coin_balance = t.v::numeric, coin_balance_block = $1 from unnest($2::bytea[], $3::text[]) as t(a, v)
         where x.address = t.a and (x.coin_balance_block is null or x.coin_balance_block <= $1)`,
        [m, touched, values.map((v) => v.toString())],
      );
    }
    await c.query(
      `insert into cursors (stream, position, updated_at) values ('balances', $1, now())
       on conflict (stream) do update set position = excluded.position, updated_at = excluded.updated_at`,
      [m],
    );
  });
  return touched.length;
}

interface Row { token: Buffer; holder: Buffer; token_id: string; value: string; updated_block: string; standard: Standard; balance_mode: string }

/** `balanceOf` of one row at its block: null when the token does not answer. */
async function readRow(reads: BalanceReads, r: Row): Promise<bigint | null> {
  const token = "0x" + r.token.toString("hex"), who = word(r.holder);
  if (r.standard === "ERC-1155") return uint(await tryCall(reads, token, SELECTORS.balanceOf1155 + who + BigInt(r.token_id).toString(16).padStart(64, "0"), Number(r.updated_block)));
  return uint(await tryCall(reads, token, SELECTORS.balanceOf + who, Number(r.updated_block)));
}

/** Reads the unchecked balances stage 2 (or a reindex) left, up to `limit`. Returns how many were read and how many tokens were switched to read balances. */
async function checkTokens(pool: Pool, reads: BalanceReads, upTo: number, limit: number): Promise<{ checked: number; switched: number }> {
  const rows = (await pool.query(
    `select b.token, b.holder, b.token_id::text, b.value::text, b.updated_block, k.standard, k.balance_mode from token_balances b join tokens k on k.address = b.token
     where b.checked_block is null and b.updated_block <= $1 order by b.updated_block, b.token, b.holder, b.token_id limit $2`, [upTo, limit])).rows as Row[];
  if (rows.length === 0) return { checked: 0, switched: 0 };
  const answers = await inBatches(rows, (r) => readRow(reads, r));
  // The supply of each token in the batch, at the newest block its rows name.
  const newest = new Map<string, { token: Buffer; block: number; standard: Standard }>();
  for (const r of rows) {
    const key = r.token.toString("hex");
    const at = Number(r.updated_block);
    if (r.standard !== "ERC-1155" && (newest.get(key)?.block ?? -1) < at) newest.set(key, { token: r.token, block: at, standard: r.standard });
  }
  const supplies = await inBatches([...newest.values()], async (s) => uint(await tryCall(reads, "0x" + s.token.toString("hex"), SELECTORS.totalSupply, s.block)));
  let switched = 0;
  await inLock(pool, async (c) => {
    const modes = new Map<string, string>();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!, read = answers[i]!;
      const key = r.token.toString("hex");
      const mode = modes.get(key) ?? r.balance_mode;
      const now = (await c.query(
        "select value::text, updated_block from token_balances where token = $1 and holder = $2 and token_id = $3 and checked_block is null for update", [r.token, r.holder, r.token_id])).rows[0];
      // Moved by a later block while it was being read: the next pass reads it again.
      if (!now || now.updated_block !== r.updated_block) continue;
      const ub = Number(r.updated_block);
      if (read === null || (mode === "derived" && read === BigInt(r.value))) {
        await c.query("update token_balances set checked_block = $4 where token = $1 and holder = $2 and token_id = $3", [r.token, r.holder, r.token_id, ub]);
        continue;
      }
      if (mode === "derived") {
        // The derived balance disagrees with the token's own answer: this token's balances are read from now on, every holder's.
        await c.query("update tokens set balance_mode = 'read' where address = $1", [r.token]);
        await c.query("update token_balances set checked_block = null where token = $1 and not (holder = $2 and token_id = $3) and checked_block is not null", [r.token, r.holder, r.token_id]);
        modes.set(key, "read");
        switched++;
      }
      const before = BigInt(r.value);
      await c.query("update token_balances set value = $4::numeric, checked_block = $5 where token = $1 and holder = $2 and token_id = $3", [r.token, r.holder, r.token_id, read.toString(), ub]);
      const delta = Number(read > 0n) - Number(before > 0n);
      if (delta !== 0) await c.query("update tokens set holder_count = holder_count + $2 where address = $1", [r.token, delta]);
    }
    const list = [...newest.values()];
    for (let i = 0; i < list.length; i++) {
      const s = supplies[i];
      if (s === null || s === undefined) continue;
      await c.query("update tokens set total_supply = $2::numeric, total_supply_block = $3 where address = $1 and (total_supply_block is null or total_supply_block < $3)", [list[i]!.token, s.toString(), list[i]!.block]);
    }
  });
  return { checked: rows.length, switched };
}

/** Tokens whose metadata failed at their first block are read again, at the derive cursor. */
async function retryMetadata(pool: Pool, reads: BalanceReads, at: number): Promise<number> {
  const tokens = (await pool.query("select address, standard from tokens where metadata_status <> 'read' order by address limit 50")).rows as { address: Buffer; standard: Standard }[];
  if (tokens.length === 0 || at < 1) return 0;
  const got = await inBatches(tokens, (t) => readMetadata(reads, "0x" + t.address.toString("hex"), t.standard, at));
  await inLock(pool, async (c) => {
    for (let i = 0; i < tokens.length; i++) {
      const m = got[i]!;
      await c.query(
        `update tokens set name = coalesce($2, name), symbol = coalesce($3, symbol), decimals = coalesce($4, decimals), total_supply = coalesce($5::numeric, total_supply),
           total_supply_block = case when $5::numeric is null then total_supply_block else $6::bigint end, metadata_status = $7 where address = $1 and metadata_status <> 'read'`,
        [tokens[i]!.address, m.name, m.symbol, m.decimals, m.totalSupply === null ? null : m.totalSupply.toString(), at, m.status],
      );
    }
    await nameContracts(c, tokens.map((t) => t.address));
  });
  return tokens.length;
}

/**
 * One turn of the check: up to `blocks` blocks of coin balances behind the derive cursor, one batch of token balances, and the metadata to retry.
 * It throws a RethError when reth does not answer (the loop logs it and tries again) and `Paused` while a reindex has the database.
 */
export async function checkBalances(pool: Pool, reads: BalanceReads, o: { blocks?: number; tokenBatch?: number } = {}): Promise<BalanceCheck> {
  const out: BalanceCheck = { blocks: 0, coin: 0, checked: 0, switched: 0, retried: 0 };
  const upTo = await deriveCursor(pool);
  const at = (await pool.query("select position from cursors where stream = 'balances'")).rows[0];
  let m = at ? Number(at.position) : 0;
  while (m < upTo && out.blocks < (o.blocks ?? 50)) {
    out.coin += await coinBlock(pool, reads, ++m);
    out.blocks++;
  }
  const t = await checkTokens(pool, reads, upTo, o.tokenBatch ?? 500);
  out.checked = t.checked;
  out.switched = t.switched;
  out.retried = await retryMetadata(pool, reads, upTo);
  return out;
}

