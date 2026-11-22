// A transfer between Ostia and another chain, step by step. Every function takes the record's id and an `Env` (the wallet, the chains and the bridge's reads), so the whole of it can be tested
// with fakes. The rules that keep it from signing anything twice:
//  - nothing signs on its own: a step that signs is a call the person asked for (the Send button, the Claim button), made under a lock of its own, on the record read again under that lock;
//  - the record is written before the wallet is asked (with the nonce the step would take) and again when the wallet gives the hash;
//  - a step the wallet did not answer is looked up (the wallet's own count of the account's transactions, or a transaction hash the person pastes, matched to the exact call) before it may be asked again;
//  - a claim is signed only after the server says it is not paid out yet, and only when what it handed over pays this wallet exactly this amount on this chain.
import type { Hex } from "viem";
import { definitelyNotSent } from "../evm/adapter.ts";
import type { LocksLike } from "../moves/moves.ts";
import type { StoreLike } from "../moves/state.ts";
import { bridgeCall, depositMade, isClaimFor, type Call } from "./calls.ts";
import { loadTransfer, removeTransfer, saveTransfer, type Attempt, type Dir, type Transfer } from "./record.ts";
import { ReadError, type Claim, type Deposit } from "./reads.ts";
import type { Asset, OpenRow, OstiaChain } from "./setup.ts";

export interface Receipt { ok: boolean; logs: { address: string; topics: string[]; data: string }[] }
/** A transaction as a chain shows it: what is needed to tell whether it is the call a record kept. `value` is a decimal string. */
export interface Seen { from: string; to: string | null; input: string; value: string }

/** The wallet is not on the chain a read needs (a wallet answers only for the chain it is on). */
export class WrongChain extends Error { readonly chainId: number; constructor(chainId: number) { super("The wallet is on another chain."); this.name = "WrongChain"; this.chainId = chainId; } }
/** A refusal in words, with nothing signed. */
export class Stop extends Error { constructor(message: string) { super(message); this.name = "Stop"; } }
/** The wallet did not say whether it sent the step. The page asks nothing more of the wallet for it until it is looked up. */
export class Unsure extends Error { constructor(cause: unknown) { super("The wallet did not say whether it sent this.", { cause }); this.name = "Unsure"; } }

export interface Plan { ostia: OstiaChain; other: OpenRow; topic0: string }

export interface Env {
  plan: Plan;
  /** The wallet's account, lower case. */
  account: string;
  store: StoreLike | null;
  locks: LocksLike | null;
  now(): number;
  newId(): string;
  /** Puts the wallet on the chain; says why not, in words, when it cannot. */
  ensure(chainId: number): Promise<string | null>;
  /** Whether the wallet is on the chain now. */
  onChain(chainId: number): Promise<boolean>;
  /** The wallet's own count of the account's transactions on the chain it is on: the next nonce that is pending, and the count in blocks. Null when the wallet does not say. */
  nonces(chainId: number): Promise<{ pending: number; latest: number } | null>;
  /** Estimates the call (a call that would revert stops here, before the wallet is asked) and asks the wallet to send it. Returns the hash once the wallet has signed. */
  send(chainId: number, call: Call): Promise<Hex>;
  /** The receipt of a transaction in a block, or null while there is none. Throws `WrongChain` where the chain can be read only through a wallet that is on another one. */
  receipt(chainId: number, hash: Hex): Promise<Receipt | null>;
  lookup(chainId: number, hash: Hex): Promise<Seen | null>;
  deposit(network: number, count: number): Promise<Deposit>;
  claim(network: number, count: number): Promise<Claim>;
}

/** The facts of a direction: where the send and the claim are, and the network the deposit is read under. */
export function sides(plan: Plan, dir: Dir) {
  const { ostia, other } = plan;
  return dir === "in"
    ? { sendChain: other.chainId, sendBridge: other.bridge, sendNetwork: other.networkId, claimChain: ostia.chainId, claimBridge: ostia.bridge, claimNetwork: ostia.networkId, sendName: other.name, claimName: ostia.name }
    : { sendChain: ostia.chainId, sendBridge: ostia.bridge, sendNetwork: ostia.networkId, claimChain: other.chainId, claimBridge: other.bridge, claimNetwork: other.networkId, sendName: ostia.name, claimName: other.name };
}

const MAX = 1n << 128n;

async function locked<T>(env: Env, id: string, run: () => Promise<T>): Promise<T> {
  if (!env.locks) throw new Stop("This browser cannot run the bridge. Use a current browser.");
  return env.locks.request(`agglayer-transfer:${id}`, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Stop("This transfer is open in another tab. Use that one.");
    return run();
  });
}

function patch(env: Env, id: string, change: Partial<Transfer>): Transfer | null {
  const now = loadTransfer(env.store, id);
  if (!now) return null;
  const next = { ...now, ...change };
  saveTransfer(env.store, next);
  return next;
}

const kept = (env: Env, id: string) => loadTransfer(env.store, id);

/** Writes the step before the wallet is asked, asks, and writes the hash. A refusal that certainly sent nothing leaves the record as it was (`restore`); any other failure leaves the step open and is `Unsure`. */
async function ask(env: Env, t: Transfer, which: "send" | "claim", chainId: number, call: Call): Promise<Transfer> {
  const why = await env.ensure(chainId);
  if (why) throw new Stop(why);
  const nonce = (await env.nonces(chainId))?.pending ?? null;
  const before = loadTransfer(env.store, t.id);
  const planned: Attempt = { chainId, to: call.to, data: call.data, value: call.value, nonce, tx: null };
  saveTransfer(env.store, { ...t, [which]: planned });
  let tx: Hex;
  try {
    tx = await env.send(chainId, call);
  } catch (e) {
    if (!definitelyNotSent(e)) throw new Unsure(e);
    if (before) saveTransfer(env.store, before); else removeTransfer(env.store, t.id);
    throw e;
  }
  const next = { ...t, [which]: { ...planned, tx } };
  saveTransfer(env.store, next);
  return next;
}

export interface SendInput { dir: Dir; asset: Asset; amount: bigint }

/** The call a send makes. */
export function sendCall(plan: Plan, account: string, dir: Dir, asset: Asset, amount: bigint): Call {
  const s = sides(plan, dir);
  return dir === "in" ? bridgeCall(s.sendBridge, s.claimNetwork, account, amount, asset.sepolia) : bridgeCall(s.sendBridge, s.claimNetwork, account, amount, asset.ostia);
}

/** Starts a transfer: asks the wallet for the send. The record is kept from the moment the wallet is asked; a send the wallet certainly did not make leaves no record. */
export async function startSend(env: Env, input: SendInput): Promise<Transfer> {
  if (input.amount <= 0n || input.amount >= MAX) throw new Stop("The amount must be more than zero.");
  const t: Transfer = {
    id: env.newId(), account: env.account, at: env.now(), route: env.plan.other.id, dir: input.dir, symbol: input.asset.symbol, decimals: input.asset.decimals, native: input.asset.sepolia === "native",
    amount: input.amount.toString(), send: null, count: null, claim: null,
  };
  return locked(env, t.id, () => ask(env, t, "send", sides(env.plan, input.dir).sendChain, sendCall(env.plan, env.account, input.dir, input.asset, input.amount)));
}

/** Asks the wallet for the send of a record that has none (the page was closed between the record and the pop-up). */
export async function resendSend(env: Env, id: string): Promise<Transfer> {
  return locked(env, id, async () => {
    const t = kept(env, id);
    if (!t) throw new Stop("This transfer is no longer kept in this browser.");
    if (t.send) throw new Stop("This send was already asked for. Nothing was signed again.");
    const asset = env.plan.other.assets.find((a) => a.symbol === t.symbol);
    if (!asset) throw new Stop("This token is not offered here any more. Nothing was signed.");
    return ask(env, t, "send", sides(env.plan, t.dir).sendChain, sendCall(env.plan, t.account, t.dir, asset, BigInt(t.amount)));
  });
}

/** Asks the wallet for the claim of a deposit that is ready, after the server's own answer says it is not paid out and what it handed over is this wallet's. */
export async function signClaim(env: Env, id: string): Promise<Transfer> {
  return locked(env, id, async () => {
    const t = kept(env, id);
    if (!t) throw new Stop("This transfer is no longer kept in this browser.");
    if (t.done !== undefined) throw new Stop("Already arrived.");
    if (t.count === null || t.lost) throw new Stop("This transfer is not ready to claim.");
    if (t.claim) throw new Stop("This claim was already asked for. Nothing was signed again.");
    const s = sides(env.plan, t.dir);
    let claim: Claim;
    try { claim = await env.claim(s.sendNetwork, t.count); } catch (e) { throw readStop(e); }
    if (claim.claimed) {
      patch(env, id, { done: env.now() });
      throw new Stop("Already arrived.");
    }
    if (claim.data === null || claim.to.toLowerCase() !== s.claimBridge.toLowerCase() || claim.chainId !== s.claimChain || claim.destinationNetwork !== s.claimNetwork
      || !isClaimFor(claim.data, { destinationNetwork: s.claimNetwork, receiver: t.account, amount: BigInt(t.amount) })) {
      throw new Stop("The bridge sent back a claim that is not yours, so nothing was signed. Try again in a moment.");
    }
    return ask(env, { ...t, claimFailed: undefined }, "claim", s.claimChain, { to: claim.to, data: claim.data as Hex, value: "0" });
  });
}

/** The words of a failed read of the bridge. */
export function readStop(e: unknown): Stop | unknown {
  if (!(e instanceof ReadError)) return e;
  if (e.status === 404) return new Stop("This is not ready to claim yet.");
  if (e.status === 429) return new Stop("Too many requests just now. Wait a minute and try again.");
  return new Stop("The bridge cannot be read right now. Nothing was signed. Try again in a moment.");
}

export type Looked = "sent" | "not-sent" | "unknown" | "elsewhere";

/** Looks for a step the wallet did not answer: with a hash it is sent; else the wallet's own count of transactions says whether anything was sent since the record was written (then the step may be asked again) or not (it stays open). */
export async function look(env: Env, id: string, which: "send" | "claim"): Promise<Looked> {
  return locked(env, id, async () => {
    const t = kept(env, id);
    const a = t?.[which];
    if (!t || !a) return "not-sent";
    if (a.tx) return "sent";
    if (!(await env.onChain(a.chainId))) return "elsewhere";
    const n = await env.nonces(a.chainId);
    if (n && a.nonce !== null && n.pending <= a.nonce) {
      saveTransfer(env.store, { ...t, [which]: null });
      return "not-sent";
    }
    return "unknown";
  });
}

/** Takes the hash of a step the person found in their wallet, once the chain shows it is exactly the call the record kept. */
export async function adopt(env: Env, id: string, which: "send" | "claim", hash: string): Promise<Transfer> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Stop("A transaction hash is 0x and 64 letters and digits.");
  return locked(env, id, async () => {
    const t = kept(env, id);
    const a = t?.[which];
    if (!t || !a || a.tx) throw new Stop("There is nothing to look for here.");
    let seen: Seen | null;
    try { seen = await env.lookup(a.chainId, hash as Hex); } catch (e) { if (e instanceof WrongChain) throw new Stop("Put your wallet on the chain of this step first, then paste the hash again."); throw new Stop("The chain cannot be read right now. Try again in a moment."); }
    if (!seen || seen.from.toLowerCase() !== t.account || seen.to?.toLowerCase() !== a.to.toLowerCase() || seen.input.toLowerCase() !== a.data.toLowerCase() || BigInt(seen.value) !== BigInt(a.value)) {
      throw new Stop("That transaction is not this one.");
    }
    return patch(env, id, { [which]: { ...a, tx: hash as Hex } })!;
  });
}

/** Gives a record up: it is removed from this browser, and nothing is sent. */
export function giveUp(env: Env, id: string): void { removeTransfer(env.store, id); }

/** What one look found, besides the record: the deposit as the bridge shows it, the chain the wallet would have to be on to look further, and whether a read failed. */
export interface Live { deposit: Deposit | null; wrongChain: number | null; unreadable: boolean }

/** One look at a transfer. It never signs: it reads the send's block (and takes its deposit number), the deposit's stage and the claim's block, and writes what it found. */
export async function advance(env: Env, id: string): Promise<{ transfer: Transfer | null; live: Live }> {
  const live: Live = { deposit: null, wrongChain: null, unreadable: false };
  let t = kept(env, id);
  if (!t || t.done !== undefined) return { transfer: t, live };
  const s = sides(env.plan, t.dir);
  if (t.send?.tx && t.count === null && !t.lost) {
    try {
      const r = await env.receipt(t.send.chainId, t.send.tx);
      if (r) {
        const n = r.ok ? depositMade(r.logs, s.sendBridge, env.plan.topic0, { destinationNetwork: s.claimNetwork, receiver: t.account, amount: BigInt(t.amount) }) : null;
        t = patch(env, id, !r.ok ? { lost: "failed" } : n === null ? { lost: "unreadable" } : { count: n }) ?? t;
      }
    } catch (e) { if (e instanceof WrongChain) live.wrongChain = e.chainId; else live.unreadable = true; }
  }
  if (t.count !== null && !t.lost) {
    try { live.deposit = await env.deposit(s.sendNetwork, t.count); } catch { live.unreadable = true; }
    // Paid out: by this claim, or by a claim made elsewhere. Either way it has arrived.
    if (live.deposit?.stage === "claimed") return { transfer: patch(env, id, { done: env.now() }) ?? t, live };
    if (t.claim?.tx) {
      try {
        const r = await env.receipt(t.claim.chainId, t.claim.tx);
        if (r?.ok) return { transfer: patch(env, id, { done: env.now() }) ?? t, live };
        if (r) t = patch(env, id, { claim: null, claimFailed: true }) ?? t;
      } catch (e) { if (e instanceof WrongChain) live.wrongChain = e.chainId; else live.unreadable = true; }
    }
  }
  return { transfer: t, live };
}
