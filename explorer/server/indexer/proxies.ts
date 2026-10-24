/**
 * Proxy detection for the contracts a block made (design sections 4.3 and 5.2): the EIP-1967 implementation and beacon slots, the EIP-1822 slot (all
 * read with `eth_getStorageAt` at the block) and the EIP-1167 minimal proxy, which is recognised from its code. A proxy is looked at once, in the
 * block that made it, and again in each later block that has an `Upgraded(address)` or `BeaconUpgraded(address)` log from it (the way a proxy is pointed at
 * a new implementation, or at its first one after it was made), or an `Upgraded(address)` log from its beacon (`UpgradeableBeacon.upgradeTo` logs from the
 * beacon, so the proxies behind it are looked at again, and each takes the beacon's new implementation); `checked_block` says when, so the API serves the
 * implementation as of that block. A proxy that changes its slot or its beacon's answer without one of those logs is not seen again.
 *
 * The ERC-3643 (T-REX) proxies and the ONCHAINID identity proxy are a fourth kind, "trex": they keep no implementation of their own but the address of an
 * "implementation authority" in a fixed slot, and ask it for the implementation at each call (`getTokenImplementation()` for a token, `getIRImplementation()`
 * for an identity registry, and so on; `getImplementation()` for an identity). The authority is recorded in `beacon`, the implementation it answers in
 * `implementation`. Which getter the proxy asks is read from its own code (the selector it pushes before the call). An authority that changes what it answers
 * logs `VersionUpdated` (T-REX) or `UpdatedImplementation` (ONCHAINID), and the proxies behind it are looked at again like those behind a beacon; a proxy that
 * changes its authority logs `ImplementationAuthoritySet`.
 */
import { hexToBigInt, keccak256, toHex } from "viem";
import type { Pool, PoolClient } from "pg";
import { RethError } from "../reth.ts";
import type { CreatedContract } from "./calls.ts";
import type { FinalReads } from "./reads.ts";

const slot = (name: string, minus = 0n): string => "0x" + (hexToBigInt(keccak256(toHex(name))) - minus).toString(16).padStart(64, "0");
export const EIP1967_IMPLEMENTATION_SLOT = slot("eip1967.proxy.implementation", 1n);
export const EIP1967_BEACON_SLOT = slot("eip1967.proxy.beacon", 1n);
export const EIP1822_SLOT = slot("PROXIABLE");
/** `implementation()` of a beacon. */
const BEACON_IMPLEMENTATION = "0x5c60da1b";

/** The slot where the T-REX proxies and the ONCHAINID identity proxy keep the address of their implementation authority (their source's own constant, `sload` in `getImplementationAuthority()`). */
export const TREX_AUTHORITY_SLOT = "0x821f3e4d3d679f19eacc940c87acf846ea6eae24a63058ea750304437a62aafc";
const selector = (signature: string): string => keccak256(toHex(signature)).slice(0, 10);
/** What the authority is asked, by the kind of proxy: the T-REX token, claim topics, identity registry, its storage, trusted issuers and compliance, and an ONCHAINID identity. */
export const TREX_GETTERS = ["getTokenImplementation()", "getCTRImplementation()", "getIRImplementation()", "getIRSImplementation()", "getTIRImplementation()", "getMCImplementation()", "getImplementation()"].map(selector);
/** The getter a proxy asks its authority, found in its code (`PUSH4 <selector>`, which the compiler puts before the external call), or null when the code asks none of them. */
export function trexGetter(code: string): string | null {
  const hex = code.toLowerCase().replace(/^0x/, "");
  return TREX_GETTERS.find((g) => hex.includes("63" + g.slice(2))) ?? null;
}
export type ProxyKind = "eip1967" | "eip1822" | "beacon" | "eip1167" | "trex";
export interface ProxyRow { proxy: string; kind: ProxyKind; implementation: string | null; beacon: string | null }

const UPGRADE_TOPICS = [keccak256(toHex("Upgraded(address)")), keccak256(toHex("BeaconUpgraded(address)")), keccak256(toHex("ImplementationAuthoritySet(address)"))];
/** What a beacon or an authority logs when it takes a new implementation: `Upgraded(address)`; `VersionUpdated((uint8,uint8,uint8))` of T-REX's authority; `UpdatedImplementation(address)` of ONCHAINID's. */
const BEHIND_TOPICS = [keccak256(toHex("Upgraded(address)")), keccak256(toHex("VersionUpdated((uint8,uint8,uint8))")), keccak256(toHex("UpdatedImplementation(address)"))];
const MINIMAL_PREFIX = "363d3d373d3d3d363d73", MINIMAL_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

/** The implementation an EIP-1167 minimal proxy delegates to, or null when the code is not exactly that proxy. */
export function minimalProxyTarget(code: string): string | null {
  const body = code.slice(2);
  if (body.length !== MINIMAL_PREFIX.length + 40 + MINIMAL_SUFFIX.length || !body.startsWith(MINIMAL_PREFIX) || !body.endsWith(MINIMAL_SUFFIX)) return null;
  return "0x" + body.slice(MINIMAL_PREFIX.length, MINIMAL_PREFIX.length + 40);
}

/** The address a storage word holds, or null when it is empty or is not an address (the top 12 bytes must be zero). */
export function addressOfWord(word: string): string | null {
  if (!/^0x0{24}[0-9a-f]{40}$/.test(word) || /^0x0{64}$/.test(word)) return null;
  return "0x" + word.slice(26);
}

export type ProxyReads = Pick<FinalReads, "storageAt" | "call">;
/** The reads that look at one address again: its code as well. */
export type ProxyProbe = ProxyReads & { code(account: string, n: number): Promise<string> };

export async function detect(k: CreatedContract, n: number, reads: ProxyReads): Promise<ProxyRow | null> {
  const target = minimalProxyTarget(k.runtimeCode);
  if (target) return { proxy: k.address, kind: "eip1167", implementation: target, beacon: null };
  const [impl, beacon, logic, authority] = await Promise.all([EIP1967_IMPLEMENTATION_SLOT, EIP1967_BEACON_SLOT, EIP1822_SLOT, TREX_AUTHORITY_SLOT].map((s) => reads.storageAt(k.address, s, n)));
  const implementation = addressOfWord(impl!);
  if (implementation) return { proxy: k.address, kind: "eip1967", implementation, beacon: null };
  const beaconAddress = addressOfWord(beacon!);
  if (beaconAddress) {
    // The beacon names the implementation by answering `implementation()`; a beacon that does not answer is recorded with no implementation.
    let behind: string | null = null;
    try {
      behind = addressOfWord(await reads.call(beaconAddress, BEACON_IMPLEMENTATION, n));
    } catch (e) {
      // Only an answer from reth (a revert) means the beacon has no implementation; a transport failure stops stage 2, which is retried.
      if (!(e instanceof RethError && e.answered)) throw e;
      behind = null;
    }
    return { proxy: k.address, kind: "beacon", implementation: behind, beacon: beaconAddress };
  }
  const logicAddress = addressOfWord(logic!);
  if (logicAddress) return { proxy: k.address, kind: "eip1822", implementation: logicAddress, beacon: null };
  const authorityAddress = addressOfWord(authority!);
  const getter = authorityAddress ? trexGetter(k.runtimeCode) : null;
  if (authorityAddress && getter) {
    // The authority names the implementation by answering the getter of this kind of proxy; one that does not answer is recorded with no implementation.
    let behind: string | null = null;
    try {
      behind = addressOfWord(await reads.call(authorityAddress, getter, n));
    } catch (e) {
      if (!(e instanceof RethError && e.answered)) throw e;
      behind = null;
    }
    return { proxy: k.address, kind: "trex", implementation: behind, beacon: authorityAddress };
  }
  return null;
}

const bytea = (h: string): Buffer => Buffer.from(h.slice(2), "hex");
const WIDTH = 8;

/** Looks at each contract made in block `n` and writes the proxies, in the caller's transaction. Returns how many. */
export async function writeProxies(c: Pick<PoolClient, "query">, n: number, created: CreatedContract[], reads: ProxyReads): Promise<number> {
  const last = new Map<string, CreatedContract>();
  for (const k of created) last.set(k.address, k);
  const todo = [...last.values()];
  // A contract made earlier, that says in this block that its implementation changed: look at its slots again.
  const again = await c.query(
    `select distinct encode(l.address, 'hex') as a from logs l join contracts k on k.address = l.address
     where l.block_number = $1 and l.topic0 = any($2::bytea[]) and (k.origin = 'genesis' or k.creation_block <= $1)`,
    [n, UPGRADE_TOPICS.map(bytea)],
  );
  // A beacon or an implementation authority that says it was upgraded: every proxy behind it.
  const behind = await c.query(
    `select distinct encode(p.proxy, 'hex') as a from logs l join proxies p on p.beacon = l.address where l.block_number = $1 and l.topic0 = any($2::bytea[])`,
    [n, BEHIND_TOPICS.map(bytea)],
  );
  const queued = new Set(last.keys());
  const relook: string[] = [];
  for (const r of [...again.rows, ...behind.rows]) {
    const address = "0x" + (r.a as string);
    if (queued.has(address)) continue;
    queued.add(address);
    relook.push(address);
  }
  // A proxy of the authority kind asks the getter its own code names, so the code of a contract looked at again is read from the index.
  const codes = new Map<string, string>();
  if (relook.length > 0) {
    const code = await c.query(
      `select encode(k.address, 'hex') as a, encode(b.code, 'hex') as code from contracts k join bytecodes b on b.code_hash = k.runtime_code_hash where k.address = any($1::bytea[])`,
      [relook.map(bytea)],
    );
    for (const r of code.rows) codes.set("0x" + (r.a as string), "0x" + (r.code as string));
  }
  for (const address of relook) todo.push({ address, creator: address, txIndex: 0, traceAddress: [], runtimeCode: codes.get(address) ?? "0x", initCode: "0x" });
  const found: ProxyRow[] = [];
  for (let i = 0; i < todo.length; i += WIDTH) {
    const rows = await Promise.all(todo.slice(i, i + WIDTH).map((k) => detect(k, n, reads)));
    for (const r of rows) if (r) found.push(r);
  }
  if (found.length === 0) return 0;
  await upsertProxies(c, n, found);
  return found.length;
}

async function upsertProxies(c: Pick<PoolClient, "query">, n: number, found: ProxyRow[]): Promise<void> {
  await c.query(
    `insert into proxies (proxy, kind, implementation, beacon, checked_block)
     select t.p, t.k, t.i, t.b, $1::bigint from unnest($2::bytea[], $3::text[], $4::bytea[], $5::bytea[]) as t(p, k, i, b)
     on conflict (proxy) do update set kind = excluded.kind, implementation = excluded.implementation, beacon = excluded.beacon, checked_block = excluded.checked_block
       where proxies.checked_block <= excluded.checked_block`,
    [n, found.map((p) => bytea(p.proxy)), found.map((p) => p.kind), found.map((p) => (p.implementation === null ? null : bytea(p.implementation))), found.map((p) => (p.beacon === null ? null : bytea(p.beacon)))],
  );
}

/**
 * Looks at one address again, at block `n`, and writes what it finds in the caller's transaction (the API's `verifyproxycontract`, which reads the slots at the final head
 * rather than trust the row a log last refreshed: a proxy upgraded without a log, as an EIP-1822 `updateCodeAddress` does, is seen here). An address that is no proxy at
 * `n` loses its row, unless a later block has written it. Returns what it found.
 */
export async function refreshProxy(c: Pick<PoolClient, "query">, address: string, n: number, reads: ProxyProbe): Promise<ProxyRow | null> {
  const runtimeCode = await reads.code(address, n);
  const found = await detect({ address, creator: address, txIndex: 0, traceAddress: [], runtimeCode, initCode: "0x" }, n, reads);
  if (found) await upsertProxies(c, n, [found]);
  else await c.query("delete from proxies where proxy = $1 and checked_block <= $2", [bytea(address), n]);
  return found;
}

const REPAIR_STREAM = "trex_proxies";

/**
 * Once for a database: the proxies of an implementation authority that were made before the indexer knew the kind are looked at (they were looked at when they were
 * made, found to be none, and are not looked at again until a log says so). Every contract with no proxy row whose code asks an authority's getter is read at the derived
 * head; the cursor `trex_proxies` says it was done, so a restart does not repeat it. Returns how many proxies it found.
 */
export async function repairTrexProxies(pool: Pool, reads: ProxyReads): Promise<number> {
  if ((await pool.query("select 1 from cursors where stream = $1", [REPAIR_STREAM])).rowCount) return 0;
  const derived = Number((await pool.query("select position from cursors where stream = 'derive'")).rows[0]?.position ?? 0);
  let found = 0;
  if (derived > 0) {
    const patterns = TREX_GETTERS.map((g) => Buffer.from("63" + g.slice(2), "hex"));
    const candidates = await pool.query(
      `select encode(k.address, 'hex') as a, encode(b.code, 'hex') as code
         from contracts k join bytecodes b on b.code_hash = k.runtime_code_hash
        where k.destroyed_block is null and coalesce(k.creation_block, 0) <= $1 and not exists (select 1 from proxies p where p.proxy = k.address)
          and exists (select 1 from unnest($2::bytea[]) as g(pattern) where position(g.pattern in b.code) > 0)`,
      [derived, patterns],
    );
    for (let i = 0; i < candidates.rows.length; i += WIDTH) {
      const rows = await Promise.all(candidates.rows.slice(i, i + WIDTH).map((r) =>
        detect({ address: "0x" + (r.a as string), creator: "0x" + (r.a as string), txIndex: 0, traceAddress: [], runtimeCode: "0x" + (r.code as string), initCode: "0x" }, derived, reads)));
      const here = rows.filter((r): r is ProxyRow => r !== null);
      if (here.length > 0) {
        const c = await pool.connect();
        try { await upsertProxies(c, derived, here); } finally { c.release(); }
        found += here.length;
      }
    }
  }
  await pool.query("insert into cursors (stream, position, updated_at) values ($1, $2, now()) on conflict (stream) do nothing", [REPAIR_STREAM, derived]);
  return found;
}
