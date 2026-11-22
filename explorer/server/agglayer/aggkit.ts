/**
 * A reader for AggKit's bridge service, which answers only on this machine (127.0.0.1:5578). It sends a GET to a fixed list of routes and nothing else; every number that goes
 * into a request is a whole number that fits the bridge's uint32, and every answer is checked field by field before it is used. It keeps an answer for a few seconds and asks once
 * for requests that arrive together.
 */

import { cappedText } from "./capped.ts";

/** The only routes this reader asks. */
export const AGGKIT_PATHS = {
  bridges: "/bridge/v1/bridges",
  l1InfoTreeIndex: "/bridge/v1/l1-info-tree-index",
  injectedLeaf: "/bridge/v1/injected-l1-info-leaf",
  claimProof: "/bridge/v1/claim-proof",
  settlements: "/bridge/v1/settlements",
  syncStatus: "/bridge/v1/sync-status",
  health: "/health",
} as const;

/** Outside requests name the project, never a person. */
export const AGGKIT_USER_AGENT = "Rome Protocol rome@romeprotocol.com";
export const AGGKIT_TIMEOUT_MS = 1500;
/** How long an answer is kept, and how long "not there yet" is (short, so a deposit that arrives is seen at once). */
export const AGGKIT_CACHE_MS = 3000;
export const AGGKIT_MISSING_MS = 1000;
const MAX_ENTRIES = 500;
/** The longest answer read, in bytes. */
const MAX_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 4096;

export class AggkitError extends Error {}

/** A deposit as the bridge service indexed it. Amounts and the global index stay decimal strings: they pass 2^53. */
export interface BridgeLeaf {
  depositCount: number;
  txHash: string;
  blockTimestamp: number;
  leafType: number;
  globalIndex: string;
  originNetwork: number;
  originAddress: string;
  destinationNetwork: number;
  destinationAddress: string;
  amount: string;
  metadata: string;
}
/** An L1 info tree leaf; `injectedAt` is when a layer two took its root in (seconds), for a layer two's network id only. */
export interface InfoLeaf { index: number; blockNumber: number; timestamp: number; injectedAt: number | undefined }
export interface ClaimProof { proofLocal: string[]; proofRollup: string[]; mainnetExitRoot: string; rollupExitRoot: string }
/** One settlement of this network's certificate on Ethereum, newest first. */
export interface Settlement { txHash: string | null; blockNumber: number; blockTimestamp: number | null }

export interface AggkitOptions {
  /** The service's address, such as http://127.0.0.1:5578. */
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  maxEntries?: number;
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const bad = (what: string): never => { throw new AggkitError(`the bridge service answered with an unexpected ${what}`); };
const whole = (v: unknown, what: string): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : bad(what));
const dec = (v: unknown, what: string): string => (typeof v === "string" && /^\d{1,78}$/.test(v) ? v : bad(what));
const hash = (v: unknown, what: string): string => (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : bad(what));
const address = (v: unknown, what: string): string => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : bad(what));
const bytes = (v: unknown, what: string): string => (typeof v === "string" && /^0x([0-9a-fA-F]{2})*$/.test(v) && v.length <= 2 + 2 * MAX_METADATA_BYTES ? v.toLowerCase() : bad(what));
const hashes32 = (v: unknown, what: string): string[] => (Array.isArray(v) && v.length === 32 ? v.map((x) => hash(x, what)) : bad(what));

/** A number that goes into a request: whole and at most the bridge's uint32. */
function uint32(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0 || n >= 2 ** 32) throw new TypeError(`${what} must be a whole number below 2^32`);
  return n;
}

/** What the sync status says about the syncers Ostia's bridge depends on. A field the answer does not carry is null. */
export interface SyncStatus {
  /** True when a syncer reports it is halted, false when every one that reports says it is not, null when none reports. */
  halted: boolean | null;
  /** The lowest last processed Ostia block of the layer-two syncers (`l2_info`, `claim_l2_info`). */
  ostiaBlock: number | null;
  /** The head of Ostia as the service itself last saw it (`l2_info.network_block`). */
  ostiaHead: number | null;
}

const count = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
};

function syncStatusOf(body: unknown): SyncStatus {
  const o = record(body) ?? bad("sync status");
  const flags: boolean[] = [];
  for (const name of ["l1_info", "l2_info", "l1_info_tree_info"]) {
    const halted = record(o[name])?.["is_halted"];
    if (typeof halted === "boolean") flags.push(halted);
  }
  const l2 = record(o["l2_info"]), claim = record(o["claim_l2_info"]);
  const seen = [count(l2?.["last_processed_block"]), count(claim?.["last_processed_block"])].filter((n): n is number => n !== null);
  return { halted: flags.length ? flags.some(Boolean) : null, ostiaBlock: seen.length ? Math.min(...seen) : null, ostiaHead: count(l2?.["network_block"]) };
}

type Reply = { found: true; json: unknown } | { found: false };

export function createAggkitReader(opts: AggkitOptions) {
  const root = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? AGGKIT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const kept = new Map<string, { at: number; reply: Promise<Reply> }>();
  const missing = new WeakSet<Promise<Reply>>();

  async function ask(url: string, notReadyIs404: boolean): Promise<Reply> {
    let res: Response;
    try {
      res = await doFetch(url, { headers: { accept: "application/json", "user-agent": AGGKIT_USER_AGENT }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new AggkitError("the bridge service cannot be reached");
    }
    if (notReadyIs404 && (res.status === 404 || res.status === 503)) { await res.body?.cancel().catch(() => undefined); return { found: false }; }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new AggkitError(`the bridge service answered HTTP ${res.status}`); }
    let text: string;
    try {
      text = await cappedText(res, MAX_BYTES, () => new AggkitError("the bridge service's answer is too long"));
    } catch (e) {
      throw e instanceof AggkitError ? e : new AggkitError("the bridge service's answer could not be read");
    }
    try {
      return { found: true, json: JSON.parse(text) };
    } catch {
      throw new AggkitError("the bridge service did not answer with JSON");
    }
  }

  /** One GET, kept for a few seconds. A 404 or a 503 is "not ready yet" (kept for one second); anything else that is not a success is an error and is not kept. */
  function get(path: string, params: [string, number][], notReadyIs404 = true): Promise<Reply> {
    const url = `${root}${path}${params.length ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&") : ""}`;
    const t = now();
    const had = kept.get(url);
    if (had && t - had.at < (missing.has(had.reply) ? AGGKIT_MISSING_MS : AGGKIT_CACHE_MS)) return had.reply;
    const reply = ask(url, notReadyIs404);
    kept.delete(url);
    kept.set(url, { at: t, reply });
    if (kept.size > maxEntries) kept.delete(kept.keys().next().value as string);
    reply.then((r) => { if (!r.found) missing.add(reply); }, () => { if (kept.get(url)?.reply === reply) kept.delete(url); });
    return reply;
  }

  return {
    /** The deposit with this number on `network`, or undefined while the service has not indexed it. */
    async bridge(network: number, depositCount: number): Promise<BridgeLeaf | undefined> {
      const r = await get(AGGKIT_PATHS.bridges, [["network_id", uint32(network, "network")], ["deposit_count", uint32(depositCount, "deposit count")]]);
      if (!r.found) return undefined;
      const list = record(r.json)?.["bridges"];
      const raw = (Array.isArray(list) ? list : []).map(record).find((b) => b?.["deposit_count"] === depositCount);
      if (!raw) return undefined;
      return {
        depositCount, txHash: hash(raw["tx_hash"], "deposit"), blockTimestamp: whole(raw["block_timestamp"], "deposit"), leafType: whole(raw["leaf_type"], "deposit"),
        globalIndex: dec(raw["global_index"], "deposit"), originNetwork: whole(raw["origin_network"], "deposit"), originAddress: address(raw["origin_address"], "deposit"),
        destinationNetwork: whole(raw["destination_network"], "deposit"), destinationAddress: address(raw["destination_address"], "deposit"), amount: dec(raw["amount"], "deposit"),
        metadata: bytes(raw["metadata"], "deposit"),
      };
    },
    /** The first L1 info tree index after the deposit: it exists once the deposit is settled on Ethereum. */
    async l1InfoTreeIndex(network: number, depositCount: number): Promise<number | undefined> {
      const r = await get(AGGKIT_PATHS.l1InfoTreeIndex, [["network_id", uint32(network, "network")], ["deposit_count", uint32(depositCount, "deposit count")]]);
      return r.found ? whole(r.json, "L1 info tree index") : undefined;
    },
    /** For network 0, the leaf at the index. For a layer two's id, the first leaf at or after the index that the layer two took in (undefined until it has). */
    async injectedLeaf(network: number, leafIndex: number): Promise<InfoLeaf | undefined> {
      const r = await get(AGGKIT_PATHS.injectedLeaf, [["network_id", uint32(network, "network")], ["leaf_index", uint32(leafIndex, "leaf index")]]);
      if (!r.found) return undefined;
      const b = record(r.json) ?? bad("L1 info leaf");
      const injectedAt = b["injected_l2_block_timestamp"];
      if (network !== 0 && typeof injectedAt !== "number") return undefined;
      return { index: whole(b["l1_info_tree_index"], "L1 info leaf"), blockNumber: whole(b["block_num"], "L1 info leaf"), timestamp: whole(b["timestamp"], "L1 info leaf"), injectedAt: typeof injectedAt === "number" ? whole(injectedAt, "L1 info leaf") : undefined };
    },
    async claimProof(network: number, leafIndex: number, depositCount: number): Promise<ClaimProof | undefined> {
      const r = await get(AGGKIT_PATHS.claimProof, [["network_id", uint32(network, "network")], ["leaf_index", uint32(leafIndex, "leaf index")], ["deposit_count", uint32(depositCount, "deposit count")]]);
      if (!r.found) return undefined;
      const b = record(r.json) ?? bad("claim proof");
      const info = record(b["l1_info_tree_leaf"]) ?? bad("claim proof");
      return { proofLocal: hashes32(b["proof_local_exit_root"], "claim proof"), proofRollup: hashes32(b["proof_rollup_exit_root"], "claim proof"), mainnetExitRoot: hash(info["mainnet_exit_root"], "claim proof"), rollupExitRoot: hash(info["rollup_exit_root"], "claim proof") };
    },
    /** The newest settlements of this service's own network, newest first. */
    async settlements(): Promise<Settlement[]> {
      const r = await get(AGGKIT_PATHS.settlements, [["page_number", 1], ["page_size", 5]]);
      const list = r.found ? record(r.json)?.["settlements"] : undefined;
      return (Array.isArray(list) ? list : []).flatMap((v) => {
        const s = record(v);
        if (!s || typeof s["block_number"] !== "number" || !Number.isSafeInteger(s["block_number"]) || s["block_number"] < 0) return [];
        const tx = typeof s["tx_hash"] === "string" && /^0x[0-9a-fA-F]{64}$/.test(s["tx_hash"]) ? s["tx_hash"].toLowerCase() : null;
        const at = typeof s["block_timestamp"] === "number" && Number.isSafeInteger(s["block_timestamp"]) && s["block_timestamp"] >= 0 ? s["block_timestamp"] : null;
        return [{ txHash: tx, blockNumber: s["block_number"], blockTimestamp: at }];
      });
    },
    /** The syncers' positions and whether one is halted; null when the service has no such route. */
    async syncStatus(): Promise<SyncStatus | null> {
      const r = await get(AGGKIT_PATHS.syncStatus, []);
      return r.found ? syncStatusOf(r.json) : null;
    },
    /** True when the service's own health route answers with a success. A refusal is false; a service that cannot be reached is an error. */
    async healthy(): Promise<boolean> {
      try {
        await get(AGGKIT_PATHS.health, [], false);
        return true;
      } catch (e) {
        if (e instanceof AggkitError && /^the bridge service answered HTTP/.test(e.message)) return false;
        throw e;
      }
    },
    /** How many answers are held (for a test). */
    cached: (): number => kept.size,
  };
}

export type AggkitReader = ReturnType<typeof createAggkitReader>;
