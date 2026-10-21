/**
 * The genesis contracts (design section 4.3, "at first start"): every account with code in the chain's genesis.json, written to `bytecodes` and to
 * `contracts` with `origin = 'genesis'` and no creator. The gateway is one of them, so it has a contract page.
 *
 * The file is checked against reth: each account's code in the file must be the code reth holds at block 0. The seeding is one database
 * transaction, marked by `meta.genesis_seeded`, so it happens once and a start that finds the mark does nothing.
 */
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import type { Pool } from "pg";
import { IndexerStop } from "./errors.ts";
import type { FinalReads } from "./reads.ts";

export interface GenesisContract { address: string; code: string }

/** The accounts with code in a genesis.json, by lowercase 0x address and lowercase code. Keys may be written with or without 0x and in any case. */
export function genesisContracts(file: string): GenesisContract[] {
  let alloc: unknown;
  try {
    alloc = (JSON.parse(readFileSync(file, "utf8")) as { alloc?: unknown }).alloc;
  } catch (e) {
    throw new IndexerStop("genesis", `the genesis file ${file} cannot be read: ${(e as Error).message}`, null);
  }
  if (typeof alloc !== "object" || alloc === null || Array.isArray(alloc)) throw new IndexerStop("genesis", `the genesis file ${file} has no alloc`, null);
  const out: GenesisContract[] = [];
  for (const [key, account] of Object.entries(alloc)) {
    const address = "0x" + key.replace(/^0x/i, "").toLowerCase();
    const code = (account as { code?: unknown } | null)?.code;
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new IndexerStop("genesis", `the genesis file has an account named "${key}", which is not an address`, null);
    if (code === undefined || code === null || code === "" || code === "0x") continue;
    if (typeof code !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(code)) throw new IndexerStop("genesis", `the code of ${address} in the genesis file is not hex`, null);
    out.push({ address, code: code.toLowerCase() });
  }
  return out.sort((a, b) => (a.address < b.address ? -1 : 1));
}

const bytea = (h: string): Buffer => Buffer.from(h.slice(2), "hex");

/** Seeds the genesis contracts once. Returns how many it wrote (0 when they were seeded before). Throws IndexerStop("genesis") for a file that reth does not agree with, or that lacks the gateway. */
export async function seedGenesis(pool: Pool, reads: Pick<FinalReads, "code">, file: string, gateway: string): Promise<number> {
  if ((await pool.query("select 1 from meta where key = 'genesis_seeded'")).rowCount) return 0;
  const contracts = genesisContracts(file);
  if (!contracts.some((c) => c.address === gateway)) throw new IndexerStop("genesis", `the genesis file ${file} has no code at the gateway's address ${gateway}`, null, { gateway });
  for (const c of contracts) {
    const onChain = await reads.code(c.address, 0);
    if (onChain !== c.code) throw new IndexerStop("genesis", `${c.address}: the genesis file's code is not the code reth holds at block 0`, null, { address: c.address });
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const c of contracts) {
      const hash = bytea(keccak256(c.code as `0x${string}`));
      await client.query("insert into bytecodes (code_hash, code, size) values ($1, $2, $3) on conflict do nothing", [hash, bytea(c.code), (c.code.length - 2) / 2]);
      await client.query("insert into contracts (address, origin, runtime_code_hash) values ($1, 'genesis', $2) on conflict do nothing", [bytea(c.address), hash]);
    }
    await client.query("insert into meta (key, value) values ('genesis_seeded', $1) on conflict do nothing", [String(contracts.length)]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return contracts.length;
}
