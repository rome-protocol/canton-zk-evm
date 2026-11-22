/**
 * The routes of the AggLayer bridge page: its setup, the stage of a deposit and the claim receipt. The server reads and the person's wallet signs: nothing here claims for anyone or
 * holds a key. The facts come from AggKit's bridge service, from Ethereum Sepolia (through an endpoint kept secret) and from Ostia's own reth.
 */
import { keccak256, type Hex } from "viem";
import type { Answer } from "../api.ts";
import { createLimiter, REST_REFUSED, retryAfter } from "../limits.ts";
import type { HealthRow } from "../indexer/health.ts";
import { cached } from "../rest/cache.ts";
import { REST_FIELDS as F, pick } from "../rest/fields.ts";
import { BadRequest } from "../rest/paging.ts";
import { RethError, type Reth } from "../reth.ts";
import { BRIDGE_EVENT, BRIDGE_EVENT_TOPIC, claimAssetCall, claimMessageCall, depositCountCall, emergencyStateCall, isClaimedCall, noteOf, noteOfCall, type ClaimArgs } from "./abi.ts";
import { AggkitError, type AggkitReader, type BridgeLeaf } from "./aggkit.ts";
import { createHadrianReader, type HadrianReader } from "./hadrian.ts";
import { SepoliaBusy, SepoliaError, SIMULATE_FROM, SIMULATE_GAS, type SepoliaReader } from "./sepolia.ts";
import { OPEN_ROUTE, type AgglayerSettings } from "./settings.ts";
import { createSolgateReader, type SolgateReader } from "./solgate.ts";

/** Ethereum's network id in AggLayer. */
const ETHEREUM = 0;
export const AGGLAYER_PATHS = ["/api/agglayer/setup", "/api/agglayer/deposit", "/api/agglayer/claim"] as const;
/** The two routes that exist only with AGGLAYER_MESSAGES on. */
export const AGGLAYER_MESSAGE_PATHS = ["/api/agglayer/messages", "/api/agglayer/note"] as const;
export const MESSAGES_OFF = "AggLayer messages are off on this explorer.";
export const TOO_LARGE = "This message is too large for this page.";
export const NOT_AVAILABLE = (chain: string): string => `${chain} is not available right now. Nothing is lost.`;
export const NO_CODE = (chain: string): string => `There is no contract at this address on ${chain} yet. The message can be claimed once one is there.`;
export const WOULD_FAIL = (chain: string): string => `The contract on ${chain} turns this message down right now, so a claim would fail. No claim was sent. The message stays ready to claim.`;
export const AGGLAYER_OFF = "The AggLayer bridge is off on this explorer.";
export const NOT_SERVED = "That deposit is not on a route this page serves.";
export const NOT_READY = "That deposit is not ready to claim yet.";
export const UNREADABLE = "The bridge cannot be read right now.";
export const BUSY = (seconds: number): string => `The bridge is busy. Try again in ${seconds} s.`;
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
  reth: Pick<Reth, "block" | "callAt"> & Partial<Pick<Reth, "rpc" | "code">>;
  /** The readers of Solgate and of Hadrian for the routes through Solgate; made from the settings when not given. */
  solgate?: SolgateReader;
  hadrian?: HadrianReader;
  now?: () => number;
}

interface Status {
  reachable: boolean;
  halted: boolean | null;
  /** How many blocks AggKit's Ostia syncers trail Ostia's finalized block; null when either is not known. */
  lagBlocks: number | null;
  attached: boolean | null;
  lastSettlementAgeSeconds: number | null;
  /** How long the newest Ostia deposit has waited for a settlement after it; null when none waits. */
  waitingSeconds: number | null;
  available: boolean;
}

const ok = (body: unknown): Answer => ({ status: 200, body });
const fail = (status: number, error: string, headers?: Record<string, string>, code?: string): Answer => ({ status, body: { error, ...(code ? { code } : {}) }, ...(headers ? { headers } : {}) });
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const range = (r: { minSeconds: number; maxSeconds: number } | null) => r && pick(r, F.agglayerRange);

export function createAgglayerBridge({ settings, chainId, chainName, aggkit, sepolia, reth, solgate: solgateIn, hadrian: hadrianIn, now = Date.now }: BridgeDeps) {
  const solgate = solgateIn ?? (settings.solgate ? createSolgateReader({ baseUrl: settings.solgate.url, now }) : null);
  const hadrian = hadrianIn ?? (settings.hadrian ? createHadrianReader({ url: settings.hadrian.rpc, chainId: settings.hadrian.chainId, now }) : null);
  const limiter = createLimiter(RATE, now);
  const networks = [ETHEREUM, settings.ostiaNetworkId];
  const bridgeOn = (network: number) => (network === ETHEREUM ? settings.sepoliaBridge : settings.ostiaBridge);
  const chainOn = (network: number) => (network === ETHEREUM ? settings.sepoliaChainId : chainId);

  const chainName_ = (network: number) => (network === ETHEREUM ? settings.routes.find((r) => r.id === OPEN_ROUTE)?.name ?? "Ethereum Sepolia" : chainName);
  const msg = settings.messages;

  /** One eth_call of Ostia's reth at its latest block; "reverted" when reth answers with an error (a revert), an error when it cannot be read. */
  async function ostiaCall(to: string, data: string, simulate = false): Promise<string | "reverted"> {
    if (!reth.rpc) throw new RethError("reth cannot be asked for a call");
    try {
      const out = await reth.rpc("eth_call", [{ ...(simulate ? { from: SIMULATE_FROM, gas: SIMULATE_GAS } : {}), to, data }, "latest"]);
      if (typeof out !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(out)) throw new RethError("eth_call: reth answered with something that is not data");
      return out;
    } catch (e) {
      if (e instanceof RethError && e.answered) return "reverted";
      throw e;
    }
  }
  const pausedOn = async (network: number): Promise<boolean> => {
    if (network === ETHEREUM) return sepolia.paused();
    const out = await ostiaCall(settings.ostiaBridge, emergencyStateCall());
    return out !== "reverted" && /^0x[0-9a-f]{64}$/.test(out) && BigInt(out) !== 0n;
  };
  const hasCodeOn = async (network: number, address: string): Promise<boolean> => {
    if (network === ETHEREUM) return sepolia.hasCode(address);
    if (!reth.code) throw new RethError("reth cannot be asked for code");
    return (await reth.code(address)) !== "0x";
  };
  const wouldPassOn = async (network: number, data: string): Promise<boolean> => (network === ETHEREUM ? sepolia.wouldPass(data) : (await ostiaCall(settings.ostiaBridge, data, true)) !== "reverted");

  let statusAt = -Infinity;
  let statusNow: Promise<Status> | null = null;

  /** The time of the newest deposit made on Ostia as of `block` (the finalized block: the bridge service follows that one), in seconds; null when there is none or it cannot be read. */
  async function newestOstiaDeposit(block: number | null): Promise<number | null> {
    if (block === null) return null;
    const out = await reth.callAt(settings.ostiaBridge, depositCountCall(), block);
    if (!/^0x[0-9a-f]{64}$/.test(out) || BigInt(out) === 0n || BigInt(out) >= 2n ** 32n) return null;
    return (await aggkit.bridge(settings.ostiaNetworkId, Number(BigInt(out)) - 1))?.blockTimestamp ?? null;
  }

  /** What the service and the chains say about the bridge, read once for a few seconds. Never rejects: a reading that fails is "not reachable" or "not known". */
  function status(): Promise<Status> {
    const t = now();
    if (statusNow && t - statusAt < STATUS_MS) return statusNow;
    statusAt = t;
    statusNow = (async (): Promise<Status> => {
      const number = (id: "latest" | "finalized") => reth.block(id).then((b) => b?.number ?? null, () => null);
      const [head, finalized] = await Promise.all([number("latest"), number("finalized")]);
      const [healthy, sync, settled, attached, newest] = await Promise.allSettled([aggkit.healthy(), aggkit.syncStatus(), aggkit.settlements(), sepolia.attached(chainId), newestOstiaDeposit(finalized ?? head)]);
      const reachable = healthy.status === "fulfilled" && healthy.value;
      const sy = sync.status === "fulfilled" ? sync.value : null;
      const a = attached.status === "fulfilled" ? attached.value : null;
      const last = settled.status === "fulfilled" ? settled.value.find((x) => x.blockTimestamp !== null) : undefined;
      const lastAt = last?.blockTimestamp ?? null;
      const sent = newest.status === "fulfilled" ? newest.value : null;
      // The bridge service's Ostia syncers follow the finalized block, so that is what their lag is measured against.
      const ostia = finalized ?? sy?.ostiaHead ?? null;
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

  /**
   * A route through Solgate: the page hands the person over, so the row carries Solgate's address, the tokens that route offers and their times. It is available only while the bridge is, Solgate lists
   * Ostia and Hadrian (Hadrian under the chain id of the settings), Hadrian answers, and at least one of the route's tokens has an address on Ostia in Solgate's list.
   */
  async function handoffRow(r: AgglayerSettings["routes"][number], times: unknown, bridgeUp: boolean) {
    const [view, hadrianUp] = await Promise.all([solgate!.read(), hadrian!.reachable()]);
    const hadrianNet = settings.hadrian!.networkId;
    const record = view?.chains.get(hadrianNet);
    const listed = Boolean(view?.chains.has(settings.ostiaNetworkId) && record && (record.chainId === null || record.chainId === settings.hadrian!.chainId));
    const assets = (view?.assets ?? []).flatMap((t) => {
      const ostia = t.evm[settings.ostiaNetworkId];
      if (!r.handoff!.symbols.includes(t.symbol) || ostia === undefined) return [];
      const own = r.handoff!.assetTimes[t.symbol];
      return [pick({ symbol: t.symbol, name: t.name, decimals: t.decimals, places: t.places, ostia, times: pick({ in: range(own?.in ?? null), out: range(own?.out ?? null) }, F.agglayerTimes) }, F.agglayerHandoffToken)];
    }).sort((a, b) => r.handoff!.symbols.indexOf(a.symbol as string) - r.handoff!.symbols.indexOf(b.symbol as string));
    const available = bridgeUp && listed && hadrianUp && assets.length > 0;
    return pick({ id: r.id, name: r.name, open: true, via: "solgate", available, solgate: settings.solgate!.url, coin: r.id === "hadrian" && listed ? record!.nativeSymbol : null, assets, times }, F.agglayerHandoffRoute);
  }

  async function setup(): Promise<Answer> {
    const st = await status();
    const routes = await Promise.all(settings.routes.map(async (r) => {
      if (!r.open) return pick(r, F.agglayerRouteClosed);
      const times = pick({ in: range(r.times.in), out: range(r.times.out) }, F.agglayerTimes);
      if (r.handoff) return handoffRow(r, times, st.available);
      const assets = r.offered.map((t) => pick(t, F.agglayerToken));
      return pick({ id: r.id, name: r.name, open: true, networkId: ETHEREUM, chainId: settings.sepoliaChainId, bridge: settings.sepoliaBridge, available: st.available, assets, times, claimedForYou: pick(r.claimedForYou, F.agglayerClaimedForYou) }, F.agglayerRoute);
    }));
    return cached(ok(pick({
      on: true, chain: pick({ chainId, name: chainName, networkId: settings.ostiaNetworkId, bridge: settings.ostiaBridge }, F.agglayerChain), bridgeEvent: pick({ signature: BRIDGE_EVENT, topic0: BRIDGE_EVENT_TOPIC }, F.agglayerBridgeEvent), routes,
      ...(msg ? { messages: pick({ on: true, maxBytes: msg.maxBytes, noteBoards: pick(msg.noteBoards, F.agglayerNoteBoards) }, F.agglayerMessages) } : {}),
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
      if (e instanceof SepoliaBusy) throw e;
      console.error(`agglayer: the claimed read failed: ${(e as Error).message}`);
      return null;
    }
  }

  type Look =
    | { stage: "unknown" }
    | { stage: "sent" | "confirmed" | "ready" | "claimed"; leaf: BridgeLeaf; confirmedAt: number | null; readyAt: number | null; proof?: ClaimArgsParts; unreadable?: true };
  interface ClaimArgsParts { l1InfoTreeIndex: number; proofLocal: string[]; proofRollup: string[]; mainnetExitRoot: string; rollupExitRoot: string }

  /**
   * Where a deposit is. A deposit that is not between Ethereum and Ostia, or is a message while messages are off, is not served. `forClaim` is for the route that hands out calldata: a deposit into Ostia
   * counts as paid as soon as Ostia's latest block shows it, not only its finalized one, so a claim already sent is not offered again, and a read that fails is `unreadable`.
   */
  async function look(network: number, count: number, forClaim = false): Promise<Look | "not served"> {
    const leaf = await aggkit.bridge(network, count);
    if (!leaf) return { stage: "unknown" };
    const other = network === ETHEREUM ? settings.ostiaNetworkId : ETHEREUM;
    if (!(leaf.leafType === 0 || (leaf.leafType === 1 && msg)) || leaf.destinationNetwork !== other) return "not served";
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

  /** What a message carries: its bytes and their hash, or neither (`tooLarge`) when they are longer than the page takes. */
  const messageBody = (leaf: BridgeLeaf) => (leaf.tooLarge ? { dataHash: null, data: null, tooLarge: true } : { dataHash: keccak256(leaf.metadata as Hex), data: leaf.metadata, tooLarge: false });

  async function deposit(q: URLSearchParams): Promise<Answer> {
    const { network, count } = asked(q);
    const l = await look(network, count);
    if (l === "not served") return fail(404, NOT_SERVED);
    if (l.stage === "unknown") return ok(pick({ network, count, stage: "unknown", destinationNetwork: null, sentAt: null, confirmedAt: null, readyAt: null, leaf: null }, F.agglayerDeposit));
    const { leaf } = l;
    return ok(pick({
      network, count, stage: l.stage, destinationNetwork: leaf.destinationNetwork, sentAt: iso(leaf.blockTimestamp), confirmedAt: l.confirmedAt === null ? null : iso(l.confirmedAt), readyAt: l.readyAt === null ? null : iso(l.readyAt),
      leaf: leaf.leafType === 1
        ? pick({ kind: "message", txHash: leaf.txHash, originNetwork: leaf.originNetwork, sender: leaf.originAddress, destinationNetwork: leaf.destinationNetwork, destinationAddress: leaf.destinationAddress, value: leaf.amount, ...messageBody(leaf) }, F.agglayerMessageLeaf)
        : pick({ txHash: leaf.txHash, originNetwork: leaf.originNetwork, originTokenAddress: leaf.originAddress, destinationNetwork: leaf.destinationNetwork, destinationAddress: leaf.destinationAddress, amount: leaf.amount }, F.agglayerLeaf),
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
    if (leaf.leafType === 0) return ok(pick({ ...base, claimed: false, data: claimAssetCall(args), args: pick(args, F.agglayerClaimArgs) }, F.agglayerClaim));
    // A message: too large to build, a paused bridge, a receiver with no code, and the claim simulated on the destination.
    const where = chainName_(destination), data = claimMessageCall(args);
    if (leaf.tooLarge) return fail(409, TOO_LARGE, undefined, "message_too_large");
    if (await pausedOn(destination)) return fail(503, NOT_AVAILABLE(where), undefined, "bridge_paused");
    if (!(await hasCodeOn(destination, leaf.destinationAddress))) return fail(409, NO_CODE(where), undefined, "receiver_has_no_code");
    if (!(await wouldPassOn(destination, data))) return fail(409, WOULD_FAIL(where), undefined, "message_would_fail");
    return ok(pick({ ...base, claimed: false, data, args: pick(args, F.agglayerClaimArgs) }, F.agglayerClaim));
  }

  /** A wallet's messages, newest first, at most 20 each way: AggKit lists a wallet's sends by `from_address`, and the reader pages until 20 messages are found (tokens are skipped). */
  async function messages(q: URLSearchParams): Promise<Answer> {
    const wallet = q.get("wallet");
    if (wallet === null || !ADDRESS.test(wallet)) throw new BadRequest("wallet is 0x and 40 hex digits.");
    const ostia = settings.ostiaNetworkId;
    const [in_, out] = await Promise.all([aggkit.messagesFrom(ETHEREUM, wallet, ostia, 20), aggkit.messagesFrom(ostia, wallet, ETHEREUM, 20)]);
    const rows = [...in_.map((l) => ({ network: ETHEREUM, l })), ...out.map((l) => ({ network: ostia, l }))]
      .sort((a, b) => b.l.blockTimestamp - a.l.blockTimestamp || a.network - b.network || b.l.depositCount - a.l.depositCount)
      .map(({ network, l }) => pick({ network, count: l.depositCount, txHash: l.txHash, destinationNetwork: l.destinationNetwork, receiver: l.destinationAddress, sentAt: iso(l.blockTimestamp), ...messageBody(l) }, F.agglayerMessage));
    return ok(pick({ wallet: wallet.toLowerCase(), items: rows }, F.agglayerMessageList));
  }

  /** The note the note board on `network` keeps for `sender` (who sent it from the other chain). */
  async function note(q: URLSearchParams): Promise<Answer> {
    const network = Number(q.get("network") ?? "");
    if (!/^\d{1,10}$/.test(q.get("network") ?? "") || !networks.includes(network)) throw new BadRequest(`network is ${ETHEREUM} (Ethereum) or ${settings.ostiaNetworkId} (${chainName}).`);
    const sender = q.get("sender");
    if (sender === null || !ADDRESS.test(sender)) throw new BadRequest("sender is 0x and 40 hex digits.");
    const board = (network === ETHEREUM ? msg?.noteBoards.sepolia : msg?.noteBoards.ostia) ?? null;
    if (board === null) return fail(404, `There is no note board on ${chainName_(network)}.`);
    const origin = network === ETHEREUM ? settings.ostiaNetworkId : ETHEREUM;
    const out = network === ETHEREUM ? await sepolia.noteOf(board, origin, sender) : await ostiaCall(board, noteOfCall(origin, sender));
    const got = out === null || out === "reverted" ? null : noteOf(out);
    if (!got) throw new AggkitError("the note board did not answer with a note");
    const none = got.number === "0", big = !none && (got.text.length - 2) / 2 > (msg?.readMaxBytes ?? 0);
    return ok(pick({ network, sender: sender.toLowerCase(), board, found: !none, data: none || big ? null : got.text, tooLarge: big, at: none ? null : iso(got.at), number: got.number }, F.agglayerNote));
  }

  /** The route's own errors in words: a request that is wrong is 400, Sepolia reads over the total cap are 503 "busy" with Retry-After (no call was made), and a service or a chain that cannot be read is 503, and the cause is logged without any address. */
  async function guarded(run: () => Promise<Answer>): Promise<Answer> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof BadRequest) return fail(400, e.message);
      if (e instanceof SepoliaBusy) return fail(503, BUSY(e.retryAfterSeconds), retryAfter(e.retryAfterSeconds));
      if (e instanceof AggkitError || e instanceof SepoliaError || e instanceof RethError) {
        console.error(`agglayer: ${e.message}`);
        return fail(503, UNREADABLE);
      }
      throw e;
    }
  }

  const routes = (parts: string[], q: URLSearchParams, ip: string | undefined): (() => Promise<Answer>) | undefined => {
    if (parts.length !== 3 || parts[0] !== "api" || parts[1] !== "agglayer") return undefined;
    const run = { setup: () => setup(), deposit: () => deposit(q), claim: () => claim(q), ...(msg ? { messages: () => messages(q), note: () => note(q) } : {}) }[parts[2]!];
    if (!run) return AGGLAYER_MESSAGE_PATHS.some((p) => p.endsWith(`/${parts[2]}`)) ? async () => fail(404, MESSAGES_OFF) : undefined;
    if (parts[2] === "setup") return () => guarded(run);
    return async () => {
      const wait = limiter.take(ip ?? "unknown");
      return wait === null ? guarded(run) : fail(429, REST_REFUSED(wait), retryAfter(wait));
    };
  };

  /**
   * The `agglayer` health row: degraded, never down, when the service is not reachable or healthy, a syncer is halted, its Ostia syncers trail Ostia's finalized block by more than the limit,
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

  return { routes, healthRow, status, messagePaths: msg ? AGGLAYER_MESSAGE_PATHS : [] };
}

export type AgglayerBridge = ReturnType<typeof createAgglayerBridge>;

/** The routes of a bridge, or, with none (the switch is off), the same paths answering that it is off: `{on: false}` for the setup and 404 for the rest. */
export function agglayerRoutes(bridge: Pick<AgglayerBridge, "routes"> | null): AgglayerBridge["routes"] {
  if (bridge) return bridge.routes;
  return (parts) => {
    if (parts.length !== 3 || parts[0] !== "api" || parts[1] !== "agglayer") return undefined;
    if (parts[2] === "setup") return async () => ok(pick({ on: false }, F.agglayerOff));
    if (parts[2] === "deposit" || parts[2] === "claim" || parts[2] === "messages" || parts[2] === "note") return async () => fail(404, AGGLAYER_OFF);
    return undefined;
  };
}
