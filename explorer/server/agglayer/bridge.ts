/**
 * The routes of the AggLayer bridge page: its setup, the stage of a deposit and the claim receipt. The server reads and the person's wallet signs: nothing here claims for anyone or
 * holds a key. The facts come from AggKit's bridge service, from Ethereum Sepolia (through an endpoint kept secret) and from Ostia's own reth.
 */
import type { Answer } from "../api.ts";
import { createLimiter, REST_REFUSED, retryAfter } from "../limits.ts";
import type { HealthRow } from "../indexer/health.ts";
import { cached } from "../rest/cache.ts";
import { REST_FIELDS as F, pick } from "../rest/fields.ts";
import { BadRequest } from "../rest/paging.ts";
import type { Reth } from "../reth.ts";
import { BRIDGE_EVENT, BRIDGE_EVENT_TOPIC, claimAssetCall, depositCountCall, isClaimedCall, type ClaimArgs } from "./abi.ts";
import { AggkitError, type AggkitReader, type BridgeLeaf } from "./aggkit.ts";
import { SepoliaError, type SepoliaReader } from "./sepolia.ts";
import type { AgglayerSettings } from "./settings.ts";

/** Ethereum's network id in AggLayer. */
const ETHEREUM = 0;
export const AGGLAYER_PATHS = ["/api/agglayer/setup", "/api/agglayer/deposit", "/api/agglayer/claim"] as const;
export const AGGLAYER_OFF = "The AggLayer bridge is off on this explorer.";
export const NOT_SERVED = "That deposit is not on a route this page serves.";
export const NOT_READY = "That deposit is not ready to claim yet.";
export const UNREADABLE = "The bridge cannot be read right now.";
/** What the status of the bridge is kept for. */
const STATUS_MS = 5000;
/** The reads a client may make of the bridge: bursts of 10, 30 a minute. */
const RATE = [{ capacity: 10, perSecond: 0.5 }] as const;

export interface BridgeDeps {
  settings: AgglayerSettings;
  chainId: number;
  chainName: string;
  aggkit: AggkitReader;
  sepolia: SepoliaReader;
  reth: Pick<Reth, "block" | "callAt">;
  now?: () => number;
}

interface Status {
  reachable: boolean;
  halted: boolean | null;
  /** How many blocks AggKit's Ostia syncers trail Ostia's head; null when either is not known. */
  lagBlocks: number | null;
  attached: boolean | null;
  lastSettlementAgeSeconds: number | null;
  /** How long the newest Ostia deposit has waited for a settlement after it; null when none waits. */
  waitingSeconds: number | null;
  available: boolean;
}

const ok = (body: unknown): Answer => ({ status: 200, body });
const fail = (status: number, error: string, headers?: Record<string, string>): Answer => ({ status, body: { error }, ...(headers ? { headers } : {}) });
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const range = (r: { minSeconds: number; maxSeconds: number } | null) => r && pick(r, F.agglayerRange);

export function createAgglayerBridge({ settings, chainId, chainName, aggkit, sepolia, reth, now = Date.now }: BridgeDeps) {
  const limiter = createLimiter(RATE, now);
  const networks = [ETHEREUM, settings.ostiaNetworkId];
  const bridgeOn = (network: number) => (network === ETHEREUM ? settings.sepoliaBridge : settings.ostiaBridge);
  const chainOn = (network: number) => (network === ETHEREUM ? settings.sepoliaChainId : chainId);

  let statusAt = -Infinity;
  let statusNow: Promise<Status> | null = null;

  /** The time of the newest deposit made on Ostia, in seconds; null when there is none or it cannot be read. */
  async function newestOstiaDeposit(head: number | null): Promise<number | null> {
    if (head === null) return null;
    const out = await reth.callAt(settings.ostiaBridge, depositCountCall(), head);
    if (!/^0x[0-9a-f]{64}$/.test(out) || BigInt(out) === 0n || BigInt(out) >= 2n ** 32n) return null;
    return (await aggkit.bridge(settings.ostiaNetworkId, Number(BigInt(out)) - 1))?.blockTimestamp ?? null;
  }

  /** What the service and the chains say about the bridge, read once for a few seconds. Never rejects: a reading that fails is "not reachable" or "not known". */
  function status(): Promise<Status> {
    const t = now();
    if (statusNow && t - statusAt < STATUS_MS) return statusNow;
    statusAt = t;
    statusNow = (async (): Promise<Status> => {
      const head = await reth.block("latest").then((b) => b?.number ?? null, () => null);
      const [healthy, sync, settled, attached, newest] = await Promise.allSettled([aggkit.healthy(), aggkit.syncStatus(), aggkit.settlements(), sepolia.attached(chainId), newestOstiaDeposit(head)]);
      const reachable = healthy.status === "fulfilled" && healthy.value;
      const sy = sync.status === "fulfilled" ? sync.value : null;
      const a = attached.status === "fulfilled" ? attached.value : null;
      const last = settled.status === "fulfilled" ? settled.value.find((x) => x.blockTimestamp !== null) : undefined;
      const lastAt = last?.blockTimestamp ?? null;
      const sent = newest.status === "fulfilled" ? newest.value : null;
      const ostia = head ?? sy?.ostiaHead ?? null;
      const lagBlocks = ostia !== null && sy?.ostiaBlock != null ? Math.max(0, ostia - sy.ostiaBlock) : null;
      const halted = sy?.halted ?? null;
      return {
        reachable, halted, lagBlocks, attached: a, lastSettlementAgeSeconds: lastAt === null ? null : Math.max(0, Math.floor(t / 1000 - lastAt)),
        waitingSeconds: sent !== null && (lastAt === null || sent > lastAt) ? Math.max(0, Math.floor(t / 1000 - sent)) : null,
        available: reachable && a !== false && halted !== true && (lagBlocks === null || lagBlocks <= settings.aggkitMaxLagBlocks),
      };
    })();
    return statusNow;
  }

  async function setup(): Promise<Answer> {
    const st = await status();
    const routes = settings.routes.map((r) => {
      if (!r.open) return pick(r, F.agglayerRouteClosed);
      const assets = r.offered.map((t) => pick(t, F.agglayerToken));
      const times = pick({ in: range(r.times.in), out: range(r.times.out) }, F.agglayerTimes);
      return pick({ id: r.id, name: r.name, open: true, networkId: ETHEREUM, chainId: settings.sepoliaChainId, bridge: settings.sepoliaBridge, available: st.available, assets, times, claimedForYou: pick(r.claimedForYou, F.agglayerClaimedForYou) }, F.agglayerRoute);
    });
    return cached(ok(pick({
      on: true, chain: pick({ chainId, name: chainName, networkId: settings.ostiaNetworkId, bridge: settings.ostiaBridge }, F.agglayerChain), bridgeEvent: pick({ signature: BRIDGE_EVENT, topic0: BRIDGE_EVENT_TOPIC }, F.agglayerBridgeEvent), routes,
    }, F.agglayerSetup)), "composite");
  }

  /** The `network` and `count` of a request: Ethereum's or Ostia's network id, and a whole number below 2^32. */
  function asked(q: URLSearchParams): { network: number; count: number } {
    const whole = (name: string): number => {
      const v = q.get(name);
      if (v === null || !/^\d{1,10}$/.test(v) || Number(v) >= 2 ** 32) throw new BadRequest(`${name} is a whole number below 2^32.`);
      return Number(v);
    };
    const network = whole("network"), count = whole("count");
    if (!networks.includes(network)) throw new BadRequest(`network is ${ETHEREUM} (Ethereum) or ${settings.ostiaNetworkId} (${chainName}).`);
    return { network, count };
  }

  /** Whether the destination has paid the deposit out, as of Ostia's `at` block where that is Ostia; null when that cannot be read now. */
  async function claimedOn(destination: number, source: number, count: number, at: "finalized" | "latest"): Promise<boolean | null> {
    try {
      if (destination === ETHEREUM) return await sepolia.isClaimed(count, source);
      const head = (await reth.block(at))?.number;
      if (head === undefined) return null;
      const out = await reth.callAt(settings.ostiaBridge, isClaimedCall(count, source), head);
      if (!/^0x[0-9a-f]{64}$/.test(out)) return null;
      return BigInt(out) !== 0n;
    } catch (e) {
      console.error(`agglayer: the claimed read failed: ${(e as Error).message}`);
      return null;
    }
  }

  type Look =
    | { stage: "unknown" }
    | { stage: "sent" | "confirmed" | "ready" | "claimed"; leaf: BridgeLeaf; confirmedAt: number | null; readyAt: number | null; proof?: ClaimArgsParts; unreadable?: true };
  interface ClaimArgsParts { l1InfoTreeIndex: number; proofLocal: string[]; proofRollup: string[]; mainnetExitRoot: string; rollupExitRoot: string }

  /**
   * Where a deposit is. A deposit that is not between Ethereum and Ostia, or is a message, is not served. `forClaim` is for the route that hands out calldata: a deposit into Ostia
   * counts as paid as soon as Ostia's latest block shows it, not only its finalized one, so a claim already sent is not offered again, and a read that fails is `unreadable`.
   */
  async function look(network: number, count: number, forClaim = false): Promise<Look | "not served"> {
    const leaf = await aggkit.bridge(network, count);
    if (!leaf) return { stage: "unknown" };
    const other = network === ETHEREUM ? settings.ostiaNetworkId : ETHEREUM;
    if (leaf.leafType !== 0 || leaf.destinationNetwork !== other) return "not served";
    const index = await aggkit.l1InfoTreeIndex(network, count);
    if (index === undefined) return { stage: "sent", leaf, confirmedAt: null, readyAt: null };
    const [l1, injected] = await Promise.all([aggkit.injectedLeaf(ETHEREUM, index), other === ETHEREUM ? undefined : aggkit.injectedLeaf(other, index)]);
    const taken = other === ETHEREUM ? l1 : injected;
    const confirmedAt = l1?.timestamp ?? null;
    const proof = taken && (await aggkit.claimProof(network, taken.index, count));
    if (!taken || !proof) return { stage: "confirmed", leaf, confirmedAt, readyAt: null };
    const readyAt = taken.injectedAt ?? taken.timestamp;
    const parts = { l1InfoTreeIndex: taken.index, proofLocal: proof.proofLocal, proofRollup: proof.proofRollup, mainnetExitRoot: proof.mainnetExitRoot, rollupExitRoot: proof.rollupExitRoot };
    let claimed = await claimedOn(other, network, count, "finalized");
    if (forClaim && claimed === false && other !== ETHEREUM) claimed = await claimedOn(other, network, count, "latest");
    return { stage: claimed ? "claimed" : "ready", leaf, confirmedAt, readyAt, proof: parts, ...(claimed === null ? { unreadable: true as const } : {}) };
  }

  async function deposit(q: URLSearchParams): Promise<Answer> {
    const { network, count } = asked(q);
    const l = await look(network, count);
    if (l === "not served") return fail(404, NOT_SERVED);
    if (l.stage === "unknown") return ok(pick({ network, count, stage: "unknown", destinationNetwork: null, sentAt: null, confirmedAt: null, readyAt: null, leaf: null }, F.agglayerDeposit));
    const { leaf } = l;
    return ok(pick({
      network, count, stage: l.stage, destinationNetwork: leaf.destinationNetwork, sentAt: iso(leaf.blockTimestamp), confirmedAt: l.confirmedAt === null ? null : iso(l.confirmedAt), readyAt: l.readyAt === null ? null : iso(l.readyAt),
      leaf: pick({ txHash: leaf.txHash, originNetwork: leaf.originNetwork, originTokenAddress: leaf.originAddress, destinationNetwork: leaf.destinationNetwork, destinationAddress: leaf.destinationAddress, amount: leaf.amount }, F.agglayerLeaf),
    }, F.agglayerDeposit));
  }

  async function claim(q: URLSearchParams): Promise<Answer> {
    const { network, count } = asked(q);
    const l = await look(network, count, true);
    if (l === "not served") return fail(404, NOT_SERVED);
    if (l.stage === "unknown" || !("proof" in l) || !l.proof) return fail(404, NOT_READY);
    if (l.unreadable) return fail(503, UNREADABLE);
    const { leaf, proof } = l;
    const destination = leaf.destinationNetwork;
    const base = { network, count, destinationNetwork: destination, chainId: chainOn(destination), to: bridgeOn(destination), l1InfoTreeIndex: proof.l1InfoTreeIndex };
    if (l.stage === "claimed") return ok(pick({ ...base, claimed: true, data: null, args: null }, F.agglayerClaim));
    const args: ClaimArgs = {
      smtProofLocalExitRoot: proof.proofLocal, smtProofRollupExitRoot: proof.proofRollup, globalIndex: leaf.globalIndex, mainnetExitRoot: proof.mainnetExitRoot, rollupExitRoot: proof.rollupExitRoot,
      originNetwork: leaf.originNetwork, originTokenAddress: leaf.originAddress, destinationNetwork: destination, destinationAddress: leaf.destinationAddress, amount: leaf.amount, metadata: leaf.metadata,
    };
    return ok(pick({ ...base, claimed: false, data: claimAssetCall(args), args: pick(args, F.agglayerClaimArgs) }, F.agglayerClaim));
  }

  /** The route's own errors in words: a request that is wrong is 400, and a service or a chain that cannot be read is 503, and the cause is logged without any address. */
  async function guarded(run: () => Promise<Answer>): Promise<Answer> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof BadRequest) return fail(400, e.message);
      if (e instanceof AggkitError || e instanceof SepoliaError) {
        console.error(`agglayer: ${e.message}`);
        return fail(503, UNREADABLE);
      }
      throw e;
    }
  }

  const routes = (parts: string[], q: URLSearchParams, ip: string | undefined): (() => Promise<Answer>) | undefined => {
    if (parts.length !== 3 || parts[0] !== "api" || parts[1] !== "agglayer") return undefined;
    const run = { setup: () => setup(), deposit: () => deposit(q), claim: () => claim(q) }[parts[2]!];
    if (!run) return undefined;
    if (parts[2] === "setup") return () => guarded(run);
    return async () => {
      const wait = limiter.take(ip ?? "unknown");
      return wait === null ? guarded(run) : fail(429, REST_REFUSED(wait), retryAfter(wait));
    };
  };

  /**
   * The `agglayer` health row: degraded, never down, when the service is not reachable or healthy, a syncer is halted, its Ostia syncers trail Ostia's head by more than the limit,
   * Ostia is not attached, or an Ostia deposit has waited past the limit for a settlement. A quiet bridge makes no certificate, so an old last settlement is no fault by itself.
   */
  async function healthRow(): Promise<HealthRow> {
    const st = await status();
    const why: string[] = [];
    if (!st.reachable) why.push("the bridge service cannot be read or says it is not healthy");
    if (st.halted === true) why.push("the bridge service says a syncer is halted");
    if (st.lagBlocks !== null && st.lagBlocks > settings.aggkitMaxLagBlocks) why.push(`the bridge service is ${st.lagBlocks} blocks behind Ostia (limit ${settings.aggkitMaxLagBlocks})`);
    if (st.attached === false) why.push("Ostia is not attached to AggLayer");
    if (st.waitingSeconds !== null && st.waitingSeconds > settings.settlementMaxAgeSeconds) why.push(`a deposit on Ostia has waited ${st.waitingSeconds} s for a settlement (limit ${settings.settlementMaxAgeSeconds} s)`);
    return {
      id: "agglayer", status: why.length ? "degraded" : "ok",
      value: { aggkit: st.reachable ? "ok" : "unavailable", halted: st.halted, lagBlocks: st.lagBlocks, attached: st.attached, lastSettlementAgeSeconds: st.lastSettlementAgeSeconds, waitingSeconds: st.waitingSeconds },
      threshold: { aggkitMaxLagBlocks: settings.aggkitMaxLagBlocks, settlementMaxAgeSeconds: settings.settlementMaxAgeSeconds }, detail: why.join("; ") || null,
    };
  }

  return { routes, healthRow, status };
}

export type AgglayerBridge = ReturnType<typeof createAgglayerBridge>;

/** The routes of a bridge, or, with none (the switch is off), the same paths answering that it is off: `{on: false}` for the setup and 404 for the rest. */
export function agglayerRoutes(bridge: Pick<AgglayerBridge, "routes"> | null): AgglayerBridge["routes"] {
  if (bridge) return bridge.routes;
  return (parts) => {
    if (parts.length !== 3 || parts[0] !== "api" || parts[1] !== "agglayer") return undefined;
    if (parts[2] === "setup") return async () => ok(pick({ on: false }, F.agglayerOff));
    if (parts[2] === "deposit" || parts[2] === "claim") return async () => fail(404, AGGLAYER_OFF);
    return undefined;
  };
}
