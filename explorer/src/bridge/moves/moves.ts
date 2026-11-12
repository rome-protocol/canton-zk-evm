import type { Address, Hex } from "viem";
import { ApiError, bridgeReads, type ApiTx, type BlockLeg } from "../../api.ts";
import { walletWords } from "../../wallet.ts";
import { timeoutSignal } from "../../timeout.ts";
import { AmountError, parseAmount, tenDecimals } from "../amounts.ts";
import { approveCall, claimCall, definitelyNotSent, payCall, releaseCall, wrapCall, withdrawCall, type Call, type EvmAdapter } from "../evm/adapter.ts";
import type { BridgeConfig, BridgeToken } from "../evm/config.ts";
import { UnexpectedTransaction } from "../canton/sign.ts";
import { Unanswered } from "../canton/accounts.ts";
import { LockRefused, type RegistryAdapter } from "../evm/registry.ts";
import {
  clearCheckpoint, depositIdOf, keptMoves, loadCheckpoint, lockIdOf, releaseIdOf, sameId, saveCheckpoint, TAKE_BACK_STAGES, transition,
  type Checkpoint, type MoveInput, type MoveState, type Step, type StoreLike,
} from "./state.ts";

/**
 * The Canton side, built from the account library: the user's own key signs, and each wait ends when the command is on the ledger.
 * Every amount is an exact 10-decimal string ("1.5000000000"). `ref` and `label` are random and at most 128 characters. A call that is made again for the same ref, label or
 * deposit id after a reload must do nothing twice: the move never signs twice on purpose, but it cannot know whether a reload came before or after a command reached the ledger.
 */
export interface CantonAdapter {
  /** The user's Canton party id, worked out locally (no request). */
  party(): string;
  signRedeem(a: { asset: Address; amount: string; recipient: Address; ref: string }): Promise<void>;
  /**
   * Ends when the redeem request is open. After a reload it reads GET /accounts/v1/open/{party}. It must give up after a time and throw `Waited`: the move keeps its record and
   * the person's continue waits again. (Any other error is a failure of the step.)
   */
  waitRedeem(ref: string): Promise<void>;
  /** Removes the account's open redeem request with `ref` (archives it); does nothing when there is none. A request locks nothing, so this can be done at any time; the move gives a redeem up only when its release is not made. */
  cancelRedeem(ref: string): Promise<void>;
  /** Looks only, signs nothing: whether the step is on Canton now (the redeem request with this ref, the allocation under this label, or the deposit request with this id). */
  appeared(a: { redeem: string } | { allocation: string } | { deposit: Hex }): Promise<boolean>;
  /** A deposit's first Canton step: allocate the tokens under `label`. The move saves a checkpoint when it returns. */
  allocateDeposit(a: { instrument: { admin: string; id: string }; amount: string; label: string }): Promise<void>;
  /** Its second step: the deposit request, which uses that allocation. */
  signDeposit(a: { instrument: { admin: string; id: string }; amount: string; label: string; depositId: Hex; recipient: Address }): Promise<void>;
  /** Ends when the deposit is on the ledger. After a reload it reads GET /accounts/v1/open/{party} and GET /accounts/v1/allocations/{party}. It must give up after a time and throw `Waited`, as `waitRedeem` does. */
  waitDeposit(depositId: Hex): Promise<void>;
  /** The time (ms since 1970) the allocation made under `label` can no longer be settled (its settle-before time); null when the account has no such allocation. */
  depositDeadline(label: string): Promise<number | null>;
  /**
   * Takes back a deposit that cannot settle: withdraws the allocation made under `label` if it is still there, then archives the open deposit request with `depositId`. Each part is skipped when
   * it is already done, so a repeat after a reload finishes what is left. Only possible once the settle-before time has passed (the account service refuses before).
   */
  recoverDeposit(a: { label: string; depositId: Hex }): Promise<void>;
}

/** The part of the browser's Web Locks that a move uses: a lock per move, held while it runs, never waited for. */
export interface LocksLike {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown | null) => Promise<T>): Promise<T>;
}
export const webLocks = (): LocksLike | null => {
  try { return typeof navigator !== "undefined" && navigator.locks ? (navigator.locks as unknown as LocksLike) : null; } catch { return null; }
};
const STILL_WAITING = "A transaction from this account is still waiting. This move continues once it is final. If it does not go through, speed it up or cancel it in your wallet.";
const NO_LOCKS = "This browser cannot run the bridge: it has no Web Locks, which keep a second tab or window from working on the same move. Use a current browser.";

export interface Deps {
  config: BridgeConfig;
  evm: EvmAdapter;
  registry: RegistryAdapter;
  canton: CantonAdapter;
  /** The explorer's /api/tx/{hash}; null while the explorer has not seen the transaction. */
  api: { tx(hash: Hex): Promise<ApiTx | null> };
  /** The explorer's /api/legs/{id}: the leg of a move and the transaction that made it; null while it is not indexed. */
  leg(id: Hex): Promise<{ txHash: string | null } | null>;
  /** The final transactions `account` sent with a nonce of `nonce` or more, oldest first, from the explorer. */
  sentSince(account: Address, nonce: number): Promise<Hex[]>;
  /** What the gateway holds on Canton of the wrapped token (base units of `decimals`), or null where that is not known. A withdrawal of more is never taken into a block. */
  custody?(wrapped: Address): Promise<{ amount: bigint; decimals: number } | null>;
  store: StoreLike | null;
  /** Web Locks (`webLocks()`), or null where there are none: then nothing runs, rather than running without the guard against a second tab. */
  locks: LocksLike | null;
  sleep(ms: number): Promise<void>;
  /** A fresh random id for a move: at most 128 characters. */
  newRef(): string;
  pollMs?: number;
  maxPolls?: number;
}

/** How long before a deposit's time to settle the page still sends its claim: a claim sent closer than this may not be in a block in time, and a claim left out of every block holds up the account's later transactions. */
export const CLAIM_MARGIN_MS = 10 * 60_000;
/** How long after a deposit's time to settle its tokens may be taken back: the account service wants 60 seconds (its TAKE_BACK_MARGIN, Canton's default record-time tolerance), and this page's clock is not the service's: never below it, and with room for this page's clock running ahead of the service's. */
export const TAKE_BACK_AFTER_MS = 90_000;
export { TAKE_BACK_STAGES };
/** How long past the time Canton can record a command (the service's `maxRecordTime`) the page still waits before it signs the step again: the page's clock is not the sequencer's, so this leaves room for it running well ahead. */
export const RECORD_MARGIN_MS = 120_000;
/** The time a command may be recorded after it is prepared when nothing better is known (the account service's window). */
export const PROVISIONAL_RECORD_MS = 11 * 60_000;
/** The stages from which a redeem's request may be open on Canton. */
const REDEEM_OPEN_STAGES: readonly Checkpoint["stage"][] = ["signing", "canton", "evm", "wallet", "sent"];
/** The stages from which a deposit's request is on the ledger and its claim is only asked of the wallet or waited for. */
const REQUEST_ON_LEDGER: readonly Checkpoint["stage"][] = ["evm", "wallet", "sent"];

/** The explorer's own answer for a transaction; a 404 is a transaction it has not seen yet. */
export const explorerTx = async (hash: Hex): Promise<ApiTx | null> => {
  try { return await bridgeReads.tx(hash, timeoutSignal()!); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
};
export const explorerLeg: Deps["leg"] = async (id) => {
  try { return await bridgeReads.leg(id, timeoutSignal()!); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
};
/** The most pages of an account's sends one look reads (50 each): past it the look is incomplete, which keeps the move waiting rather than guessing. */
const SENT_PAGES = 20;
export const explorerSentSince: Deps["sentSince"] = async (account, nonce) => {
  const found: { hash: string; nonce: number }[] = [];
  let before: string | undefined;
  for (let i = 0; i < SENT_PAGES; i++) {
    const page = await bridgeReads.sentTxs(account, 50, timeoutSignal()!, before);
    found.push(...page.items.filter((t) => t.nonce >= nonce));
    // The newest come first: once a send below the saved nonce is listed, every send from the saved nonce on is in `found`.
    if (page.next == null || page.items.some((t) => t.nonce < nonce)) return found.sort((a, b) => a.nonce - b.nonce).map((t) => t.hash as Hex);
    before = page.next;
  }
  throw new Error("The account has too many later sends to list.");
};
/** What the gateway holds on Canton of a wrapped token, from the explorer (null where it does not list it). */
export const explorerCustody: NonNullable<Deps["custody"]> = async (wrapped) => {
  const c = (await bridgeReads.twins(timeoutSignal()!)).canton.find((x) => same(x.token, wrapped));
  return c ? { amount: BigInt(c.custody), decimals: c.custodyDecimals } : null;
};
export const randomRef = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** A refusal with the words the person reads. */
export class Refused extends Error {}
/** A wait ran out: the explorer did not show the move final in time, or (thrown by `waitRedeem` and `waitDeposit`) Canton did not show the command. The move is kept, and continuing waits again. */
export class Waited extends Refused {}
/** Taking a deposit's tokens back failed in a way that will not clear by waiting (the account service does not offer it, or the ledger refused it). The person may still give the deposit up, which leaves the tokens locked on Canton. */
export class CannotTakeBack extends Refused {}
/** The move stops here until the person continues. */
class Pause extends Error {}
/** The record is gone: another tab finished the move or gave it up. */
class Gone extends Error {}

/** Whether a transaction (as the explorer shows it) is exactly the call a move saved: from the account, to the same address, with the same input data and value. */
function makesCall(t: ApiTx, c: Checkpoint): boolean {
  return c.call !== undefined && typeof t.from === "string" && same(t.from, c.account) && typeof t.to === "string" && same(t.to, c.call.to)
    && typeof t.input === "string" && same(t.input, c.call.data) && (c.call.value === undefined || t.value === c.call.value);
}

const PARTY = /^[^:\s]+::1220[0-9a-f]{64}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** A refusal that waiting does not clear: the account service answered 403 (not on its list), 404 (no such route or contract) or 422 (the ledger refused), the token registry refused (a 424, or a 502 from an older service, that carries its own 4xx), or the page's own check refused the prepared transaction. */
export const permanent = (e: unknown): boolean => {
  if (e instanceof UnexpectedTransaction) return true;   // the page's own check refused what the service prepared: preparing it again gives the same
  const { status, registryStatus } = (e ?? {}) as { status?: unknown; registryStatus?: unknown };
  if (typeof status === "number" && [403, 404, 422].includes(status)) return true;
  return (status === 424 || status === 502) && typeof registryStatus === "number" && registryStatus >= 400 && registryStatus < 500;   // the token registry refused the context
};
/** The steps whose transaction is the move's own, and shows its leg. */
const LAST: Step[] = ["pay", "release", "claim", "withdraw"];

export interface Move {
  readonly state: MoveState;
  /** The ref of the move this object is running or holds paused, failed or just final (null when none): the record to look at when more than one is kept. */
  readonly current: string | null;
  subscribe(fn: (s: MoveState) => void): () => void;
  /** Starts a move. Refused unless the last one is idle, final or failed, and while a move of this account is kept (continue it or abandon it first). */
  start(input: MoveInput): Promise<MoveState>;
  /**
   * Picks up a move kept in storage after a reload (the newest of this account and party, or the one named); idle when there is none. It only reads, waits and shows where the move is:
   * it never asks the wallet or signs, so a move that needs a send ends in `paused`. A lock that is sent but not settled announces its parts to the registry again (no wallet request, no signature). A second call while the first runs gets the same promise.
   */
  resume(ref?: string): Promise<MoveState>;
  /** The moves kept for the current account and party, newest first: for the screens to show and choose from. */
  kept(): Checkpoint[];
  /** Carries on a paused move, or retries a failed one that is kept: this is the person's go for the next send. */
  proceed(): Promise<MoveState>;
  /**
   * The person gives the move up: its record is removed. Rejects while a move is running here or in another tab, and when no move is named. A deposit whose Canton steps may be done is given up
   * only by taking its tokens back first (`takeBack`), so nothing stays locked on Canton with no record of it: before the time to settle has passed it is refused, with the time to come back at.
   * When the take-back fails in a way that will not clear (`CannotTakeBack`), `leaveLocked` (the person said so a second time) gives the deposit up anyway: its tokens stay locked on Canton.
   */
  abandon(ref?: string, opts?: { leaveLocked?: boolean }): Promise<void>;
  /** Whether the deposit kept under `ref` (or the current move) can be taken back now: its time to settle has passed (or Canton shows no allocation for it), and Ostia shows no claim for it. A claim that was sent or asked for is still in the wallet or the pool, so it is cancelled there. */
  takeBackDue(ref?: string): Promise<boolean>;
  /** Takes the tokens of a kept deposit back on Canton (withdraws its allocation, archives its request) and removes its record. Refused while the claim could still settle, and for a deposit already claimed. */
  takeBack(ref?: string): Promise<void>;
}

export function createMove(d: Deps): Move {
  let state: MoveState = { phase: "idle" };
  let ck: Checkpoint | null = null;
  let running: Promise<MoveState> | null = null;
  const owner = () => ({ account: d.evm.account, party: d.canton.party() });
  const subs = new Set<(s: MoveState) => void>();
  const go = (next: MoveState) => { state = transition(state, next); subs.forEach((f) => f(state)); };
  const save = (patch: Partial<Checkpoint>) => { ck = { ...ck!, ...patch, at: Date.now() }; saveCheckpoint(d.store, ck); };
  const assetOf = (list: BridgeToken[], a: Address) => {
    const t = list.find((x) => same(x.address, a));
    if (!t) throw new Refused("The bridge does not move this token.");
    if (list === d.config.wrapped && t.decimals !== 10) throw new Refused("This wrapped token does not have 10 decimals, so the bridge will not move it.");
    return t;
  };
  /** The stage a move goes back to when its send did not happen. */
  const before = (c: Checkpoint): Checkpoint["stage"] => (c.input.kind === "redeem" || c.input.kind === "deposit" ? "evm" : "start");

  /** What a move is about: the token, the amounts, the id its leg carries and the leg that shows it happened. Built from the record, so a resume cannot change it. */
  function plan(c: Checkpoint) {
    const { input, ref, account, party } = c;
    switch (input.kind) {
      case "lock": {
        if (!PARTY.test(input.receiver)) throw new Refused("The receiver is not a Canton party id (a name, then ::1220 and 64 hex digits).");
        const id = lockIdOf(input.receiver, ref), asset = assetOf(d.config.twins, input.asset);
        if (input.wrapNative === true && (d.config.wrapper === null || !same(asset.address, d.config.wrapper))) throw new Refused("Wrapping the chain's coin is not set up for this deployment, so nothing was wrapped.");
        return { asset, ...parseAmount(input.amount, asset.decimals), id, match: (l: BlockLeg) => l.kind === "payment" && sameId(l.legId, id) };
      }
      case "redeem": {
        const id = releaseIdOf(c.vault, ref), asset = assetOf(d.config.twins, input.asset);
        return { asset, ...parseAmount(input.amount, asset.decimals), id, match: (l: BlockLeg) => l.kind === "payment" && sameId(l.legId, id) };
      }
      case "deposit": {
        const id = depositIdOf(party, ref), asset = assetOf(d.config.wrapped, input.asset);
        return { asset, ...parseAmount(input.amount, asset.decimals), id, match: (l: BlockLeg) => l.kind === "deposit" && sameId(l.legId, id) };
      }
      case "withdraw": {
        const asset = assetOf(d.config.wrapped, input.asset), a = parseAmount(input.amount, asset.decimals);
        return { asset, ...a, id: null as Hex | null, match: (l: BlockLeg) => l.kind === "withdrawal" && same(l.token, asset.address) && same(l.account, account) && l.amount === a.base.toString() };
      }
    }
  }
  type Plan = ReturnType<typeof plan>;

  const enough = async (asset: BridgeToken, base: bigint) => { if ((await d.evm.balanceOf(asset.address)) < base) throw new Refused(`You do not hold enough ${asset.symbol}.`); };
  /** The first vault that holds the amount: a redeem is released from it, so the Canton step is not signed for a vault that could not pay. */
  async function pickVault(asset: BridgeToken, base: bigint, prefer?: Address): Promise<Address> {
    for (const v of prefer ? [prefer, ...d.config.vaults.filter((x) => !same(x, prefer))] : d.config.vaults) if ((await d.evm.balanceOf(asset.address, v)) >= base) return v;
    throw new Refused(`The vault does not hold enough ${asset.symbol} to release this amount.`);
  }

  /** A transaction of the account, at the saved nonce or after it, that makes exactly the call this move asked its wallet for (the same `to`, input data and value). A nonce alone proves nothing. */
  async function findCall(c: Checkpoint): Promise<{ hash: Hex | null; complete: boolean }> {
    if (!c.call || c.nonce === undefined) return { hash: null, complete: true };
    const list = await d.sentSince(c.account, c.nonce).catch(() => null);
    if (list === null) return { hash: null, complete: false };
    for (const h of list) {
      const t = await d.api.tx(h).catch(() => null);
      // A listed transaction that cannot be read could be the call: the look stays incomplete.
      if (!t) return { hash: null, complete: false };
      if (makesCall(t, c)) return { hash: h, complete: true };
    }
    // Complete: the list holds a final transaction for every nonce from the saved one up to the final count, and none is the call. Waiting longer cannot change that.
    const final = await d.evm.nonce().catch(() => null);
    return { hash: null, complete: final !== null && list.length >= final - c.nonce };
  }
  /** The transaction that made a move's leg. A move with an id (lock, redeem, deposit) is found by that id and nothing else; a withdrawal, which has none, by the call it made. Null while the explorer has not got it. */
  const lookup = async (c: Checkpoint, id: Hex | null): Promise<Hex | null> =>
    id ? ((await d.leg(id).catch(() => null))?.txHash as Hex | null | undefined) ?? null : (await findCall(c)).hash;
  /** The wallet itself (not /rpc) says a transaction of the account is still pending: its pending count is above its final count and above the nonce this move saved. A wallet that does not answer says nothing. */
  async function pendingInWallet(c: Checkpoint): Promise<boolean> {
    const n = await d.evm.walletNonces().catch(() => null);
    if (n !== null && n.pending > n.latest && n.pending > (c.nonce ?? 0)) return true;
    // Ostia's own pool is asked too: a wallet that missed a transaction it broadcast does not make it disappear there.
    const pool = await d.evm.pendingNonce?.().catch(() => null);
    const final = pool == null ? null : await d.evm.nonce().catch(() => null);
    return pool != null && final !== null && pool > final && pool > (c.nonce ?? 0);
  }
  async function poll(f: () => Promise<Hex | null>): Promise<Hex | null> {
    for (let i = 0; i < (d.maxPolls ?? 200); i++) { const h = await f(); if (h) return h; await d.sleep(d.pollMs ?? 3000); }
    return null;
  }

  /** What a step that did not happen leaves behind: the stage goes back to before the send. */
  const reset = (): Partial<Checkpoint> => ({ stage: before(ck!), step: undefined, call: undefined, nonce: undefined, tx: undefined });
  /**
   * The wallet is asked once per step, and what it is asked is saved first (the step, the exact call and a nonce that is a lower bound), so a reload can tell a send that happened from one that did not.
   * When the wallet returns the hash, the transaction's real nonce is saved.
   */
  async function ask(name: Step, send: () => Promise<Hex>, call?: Call): Promise<Hex> {
    // Before every send: the wallet itself says whether a transaction of the account is still pending. Never send over one.
    if (await pendingInWallet(ck!)) throw new Pause(STILL_WAITING);
    go({ phase: "sending-evm", step: name });
    save({ stage: "wallet", step: name, call, nonce: await d.evm.nonce() });
    let tx: Hex;
    try { tx = await send(); } catch (e) {
      // Only a send that certainly did not happen (the estimate failed, or the wallet refused the request) goes back before the step. Any other failure may have come after the wallet broadcast the transaction:
      // the record stays at "wallet" with its call and nonce, and the person's continue looks for that transaction on Ostia before anything is sent again.
      if (definitelyNotSent(e)) { save(reset()); throw e; }
      const said = (e as { shortMessage?: string }).shortMessage ?? walletWords(e);
      throw new Pause(`Your wallet did not say whether it sent this${said ? ` (it answered: ${said})` : ""}. Continue to check: nothing is sent again until Ostia shows it was not sent.`);
    }
    const real = (await d.evm.sentNonce(tx).catch(() => null)) ?? (await d.api.tx(tx).catch(() => null))?.nonce ?? null;
    save({ tx, ...(real === null ? {} : { nonce: real }) });
    return tx;
  }
  /** A step that failed on Ostia returns the move to before it and pauses, so the person's continue tries it again. */
  async function mined(tx: Hex, what: string) {
    if (!(await d.evm.waitReceipt(tx)).success) { save(reset()); throw new Pause(`${what} failed on Ostia. Nothing else was sent. Continue to try again.`); }
  }
  /** A step that makes no leg of the move (the wrap, the approval): done when it is mined. */
  async function prepare(name: Step, what: string, send: () => Promise<Hex>, call: Call) {
    await mined(await ask(name, send, call), what);
    save(reset());
  }
  /** The move's own transaction: asked, its hash kept, and proven final with its leg. */
  async function last(p: Plan, name: Step, send: () => Promise<Hex>, call?: Call) {
    const tx = await ask(name, send, call);
    save({ stage: "sent" });
    await prove(tx, p);
  }
  async function adopt(tx: Hex, p: Plan) { save({ stage: "sent", tx }); await prove(tx, p); }

  /**
   * Tells the registry the parts of a lock again, for a lock that is not settled yet: the registry keeps them for a few hours (6 by default), and a payment whose parts are gone waits in the pool until they are announced again.
   * Announcing is idempotent: the same receiver and ref give the same id. It asks nothing of the wallet and signs nothing.
   */
  async function announce(c: Checkpoint, p: Plan) {
    if (c.input.kind !== "lock") return;
    const parts = await d.registry.lockParts({ receiver: c.input.receiver, ref: c.ref });
    if (!sameId(parts.lockId, p.id)) throw new Refused("The registry gave a lock id that is not the one this lock makes. Nothing was sent.");
  }
  /** `announce` for a lock already sent: a registry that refuses pauses the move with its words, and one that cannot be reached is left for the next look (the move still waits for its block). */
  async function announceAgain(c: Checkpoint, p: Plan) {
    if (c.input.kind !== "lock" || (p.id !== null && (await d.leg(p.id).catch(() => null)) !== null)) return;
    try { await announce(c, p); } catch (e) {
      if (e instanceof LockRefused) { if (e.status === 0 || e.status >= 500) return; throw new Pause(e.message); }
      throw e;
    }
  }

  async function prove(first: Hex, p: Plan) {
    let tx = first, lost = false, legMissing = false, seen = false;
    go({ phase: "proving", tx });
    for (let i = 0; i < (d.maxPolls ?? 200); i++) {
      const t = await d.api.tx(tx).catch(() => null);
      lost = t?.status === "dropped" || t?.status === "replaced";
      seen = t?.status === "final" || t?.status === "proving";   // in a block already (a block being proven has it)
      legMissing = false;
      if (lost) {
        // A speed-up or a replacement in the wallet is another hash for the same move: find it by the move's id, or by the nonce. The progress is kept either way.
        const other = await lookup(ck!, p.id);
        if (other && !same(other, tx)) { tx = other; save({ tx }); go({ phase: "proving", tx }); continue; }
      } else if (t?.status === "final") {
        if (t.success !== false && t.legs.some(p.match)) {
          go({ phase: "final", tx, block: t.block?.number ?? 0 });
          clearCheckpoint(d.store, ck!.ref);
          return;
        }
        if (p.id !== null && (await d.evm.used(d.config.gateway, p.id))) {
          // The id is used, so the move is on Ostia, but perhaps not in this transaction (a second send that reverted over the first): prove the transaction that made the leg.
          const other = await lookup(ck!, p.id);
          if (other && !same(other, tx)) { tx = other; save({ tx }); go({ phase: "proving", tx }); continue; }
          legMissing = true;
        } else if (t.success === false) {
          // The transaction failed and the id is not used (or a withdrawal has none): nothing moved. Go back before the send, so the person's continue can send it again.
          save(reset());
          throw new Pause("The transaction failed on Ostia; nothing moved. Continue to try again.");
        } else if (makesCall(t, ck!)) {
          legMissing = true; // exactly the saved call, final and successful: the move is done, only the explorer's leg is missing
        } else {
          // Not this move's transaction, and the id is not used (or a withdrawal has none): nothing of the move has happened. Go back before the send and wait for the person.
          save(reset());
          throw new Pause("That transaction made no leg of this move, so the move has not happened on Ostia. Continue to send it again.");
        }
      }
      await d.sleep(d.pollMs ?? 3000);
    }
    await announceAgain(ck!, p);   // a tab left waiting keeps the lock's parts alive at the registry
    if (legMissing) throw new Waited("The move is final on Ostia, but the explorer does not show the leg yet. Continue to look again; nothing is sent.");
    if (ck!.input.kind === "deposit") {
      // After the time to settle neither the builder nor Canton can settle the deposit, so a claim still waiting will be left out of every block and holds the account's later transactions.
      const deadline = await d.canton.depositDeadline(ck!.ref).catch(() => null);
      if (deadline !== null && Date.now() >= deadline + TAKE_BACK_AFTER_MS) throw new Pause("The time to settle has run out: cancel the claim in your wallet, then take your tokens back on Canton.");
    }
    // A withdrawal the builder leaves out of every block (more than the gateway holds, or over the withdrawal quota) stays in the wallet's queue and holds the account's later sends: say where to cancel it.
    if (ck!.input.kind === "withdraw" && !lost && !seen) throw new Pause("This withdrawal has not been taken into a block. If it is still waiting in your wallet, cancel it there; nothing was burned.");
    if (lost) {
      save({ stage: "wallet", tx: undefined });
      throw new Waited("The transaction was replaced or dropped, and the explorer has not shown another one for this move. Continue to look again; nothing is sent until the wallet is asked.");
    }
    throw new Waited("Waiting for the block took too long. Reload this page to keep waiting.");
  }

  async function execute(c: Checkpoint, confirmed: boolean) {
    const at = () => ck!.stage;
    const gate = (note: string) => { if (!confirmed) throw new Pause(note); };
    if (!same(c.account, d.evm.account) || c.party !== d.canton.party()) throw new Refused("This move was started with another wallet account or Canton party. Switch back to continue it, or give it up.");
    const p = plan(c), { input, ref } = c;
    if (input.kind === "lock" && (at() === "wallet" || at() === "sent")) await announceAgain(c, p);
    if (at() === "sent" && c.tx) return prove(c.tx, p);
    if (at() === "wallet") {
      // The wallet was asked at this step. The account's own transaction counts only when it makes exactly the saved call; a move with an id is also decided by the id below.
      let h: Hex | null = c.tx ?? null, listed = true;
      if (!h && c.call) {
        let r = await findCall(c);
        h = r.hash;
        // The explorer may not list the account's latest final sends yet: look again until its list covers every nonce from the saved one to the final count (or the call is found).
        for (let i = 0; !h && !r.complete && i < (d.maxPolls ?? 200); i++) { await d.sleep(d.pollMs ?? 3000); r = await findCall(c); h = r.hash; }
        listed = r.complete;
      }
      if (h) {
        if (LAST.includes(c.step!)) return adopt(h, p);
        await mined(h, "The transaction");
      } else if (await pendingInWallet(c)) {
        // The explorer shows only final blocks, but the wallet knows its own pending sends: never send any step again over one. The record stays at this step; the transaction is matched (by its call, or by the id) once it is final.
        throw new Pause(STILL_WAITING);
      } else if (!listed) {
        // The explorer never listed the account's latest sends, so nothing proves the wallet did not send this: the record stays at this step and nothing is sent again (a withdrawal has no id to stop a second one).
        throw new Waited("Ostia's explorer has not listed this account's latest sends yet, so the page cannot tell whether your wallet sent this. Continue to look again; nothing is sent.");
      }
      save(reset());
    }
    // An id that is already used was made by an earlier send: find its transaction and prove it, never send again.
    if (p.id && (at() === "start" || at() === "evm") && (await d.evm.used(d.config.gateway, p.id))) {
      const h = await poll(() => lookup(c, p.id));
      if (!h) throw new Waited("This move is already on Ostia, and the explorer has not shown its transaction yet. Reload this page to keep waiting.");
      return adopt(h, p);
    }
    /**
     * A Canton command whose execute got no definite answer may still be recorded until its record time: until then the step is only looked for. True: it is on Canton, do not sign. False: sign it
     * (nothing was left in doubt, or the time has passed). Waited: it may still come.
     */
    const onCanton = async (what: Parameters<CantonAdapter["appeared"]>[0]): Promise<boolean> => {
      const by = ck!.cantonBy;
      if (by === undefined) return false;
      if (await d.canton.appeared(what)) { save({ cantonBy: undefined }); return true; }
      if (Date.now() <= by + RECORD_MARGIN_MS) throw new Waited("Canton has not shown this step yet, and it may still take it. Continue to look again; nothing is signed again until its time to take it has passed.");
      save({ cantonBy: undefined });
      return false;
    };
    /** Signs a Canton command; an answer that never came is remembered with the time Canton can still record it by, and the move pauses. */
    const signStep = (f: () => Promise<void>) => sign(async () => {
      // Saved before the execute: a tab closed while it is out leaves the time Canton can still record the step by (the longest the account service allows), so a later look does not sign again at once.
      save({ cantonBy: Date.now() + PROVISIONAL_RECORD_MS });
      try { await f(); } catch (e) {
        if (!(e instanceof Unanswered)) save({ cantonBy: undefined });
        if (e instanceof Unanswered) { save({ cantonBy: e.recordBy }); throw new Pause("Canton did not say whether it took this step. Continue to look: nothing is signed again until Canton shows it, or until its time to take it has passed."); }
        throw e;
      }
    });
    // A redeem resumed after its Canton step (the record is at the gate before the release): its request must still be open, or another browser removed it and a release would have no Canton side.
    const resumedForRelease = input.kind === "redeem" && at() === "evm";
    const waitCanton = async (wait: () => Promise<void>) => { go({ phase: "waiting-canton", ref }); await wait(); save({ stage: "evm" }); };
    const sign = (f: () => Promise<void>) => { if (state.phase !== "signing-canton") go({ phase: "signing-canton" }); return f(); };
    switch (input.kind) {
      case "lock": {
        gate("Your lock is saved. Continue to ask your wallet.");
        const wraps = input.wrapNative === true;
        if (!wraps) await enough(p.asset, p.base);
        go({ phase: "sending-evm", step: "prepare" });
        await announce(c, p);
        if (wraps) {
          const held = await d.evm.balanceOf(p.asset.address);
          if (held < p.base) {
            if ((await d.evm.native()) < p.base - held) throw new Refused(`You do not hold enough ${d.config.chain.coin.symbol}.`);
            await prepare("wrap", "The wrap", () => d.evm.wrap(p.asset.address, p.base - held), wrapCall(p.asset.address, p.base - held));
          }
        }
        if ((await d.evm.allowance(p.asset.address, d.config.gateway)) < p.base) {
          await prepare("approve", "The approval", () => d.evm.approve(p.asset.address, d.config.gateway, p.base), approveCall(p.asset.address, d.config.gateway, p.base));
          if ((await d.evm.allowance(p.asset.address, d.config.gateway)) < p.base) throw new Pause("The approval did not give the gateway the amount (a replaced approval, or a lower one). Check the allowance in your wallet. Continue to try again.");
        }
        return last(p, "pay", () => d.evm.pay(d.config.gateway, p.id!, p.asset.address, c.vault, p.base), payCall(d.config.gateway, p.id!, p.asset.address, c.vault, p.base));
      }
      case "redeem": {
        if (at() === "start" || at() === "signing") {
          gate("Your redeem is saved. Continue to sign it on Canton.");
          save({ stage: "signing" });
          if (!(await onCanton({ redeem: ref }))) await signStep(() => d.canton.signRedeem({ asset: p.asset.address, amount: tenDecimals(p.twin), recipient: c.to!, ref }));
          save({ stage: "canton", cantonBy: undefined });
        }
        if (at() === "canton") await waitCanton(() => d.canton.waitRedeem(ref));
        gate("Canton has your redeem. Continue to ask your wallet for the release.");
        if (resumedForRelease && !(await d.canton.appeared({ redeem: ref }))) {
          clearCheckpoint(d.store, ref);
          ck = null;
          throw new Refused("Canton no longer shows this redeem (it was removed, perhaps in another window), so nothing was released and your wallet was not asked. Start the redeem again if you still want it.");
        }
        // The vault may have been drained since the redeem was signed (or a release from it reverted): release from one that holds the amount. The release id follows the vault, so it is worked out again and saved.
        const vault = await pickVault(p.asset, p.base, ck!.vault);
        let q = p;
        if (!same(vault, ck!.vault)) { save({ vault }); q = plan(ck!); }
        return last(q, "release", () => d.evm.release(vault, ref, p.asset.address, c.to!, p.base), releaseCall(vault, ref, p.asset.address, c.to!, p.base));
      }
      case "deposit": {
        const a = { instrument: p.asset.instrument!, amount: tenDecimals(p.twin), label: ref };
        if (at() === "start" || at() === "signing") {
          gate("Your deposit is saved. Continue to allocate the tokens on Canton.");
          save({ stage: "signing" });
          if (!(await onCanton({ allocation: ref }))) await signStep(() => d.canton.allocateDeposit(a));
          save({ stage: "allocated", cantonBy: undefined });
        }
        if (at() === "allocated") {
          gate("The tokens are allocated on Canton. Continue to send the deposit request.");
          if (!(await onCanton({ deposit: p.id! }))) await signStep(() => d.canton.signDeposit({ ...a, depositId: p.id!, recipient: c.account }));
          save({ stage: "canton", cantonBy: undefined });
        }
        if (at() === "canton") await waitCanton(() => d.canton.waitDeposit(p.id!));
        gate("Canton has your deposit. Continue to ask your wallet for the claim.");
        // A claim sent when the deposit's time to settle is close, or past, is left out of every block (the builder refuses a deposit past it), and it holds the account's later transactions behind it.
        const deadline = await d.canton.depositDeadline(ref);
        // No allocation to read: the deposit's allocation is gone (or cannot be read), and the builder leaves a claim for it out of every block.
        if (deadline === null) throw new Pause("Canton no longer shows this deposit's allocation, so the claim is not sent. Take your tokens back on Canton, then start the deposit again.");
        if (deadline - Date.now() < CLAIM_MARGIN_MS) {
          throw new Pause(Date.now() >= deadline + TAKE_BACK_AFTER_MS
            ? "The time to settle this deposit has run out, so the claim would never be included. Take your tokens back on Canton, then start the deposit again."
            : "The time to settle this deposit has almost run out, so the claim is not sent. Take your tokens back on Canton when the time is up, then start the deposit again.");
        }
        return last(p, "claim", () => d.evm.claim(d.config.gateway, p.id!, p.asset.address, p.twin), claimCall(d.config.gateway, p.id!, p.asset.address, p.twin));
      }
      case "withdraw": {
        gate("Your withdrawal is saved. Continue to ask your wallet.");
        await enough(p.asset, p.base);
        // The builder takes a withdrawal into a block only when the gateway's holdings on Canton cover it: one above them would wait in the wallet for ever.
        const held = await d.custody?.(p.asset.address).catch(() => null);
        if (held && p.base * 10n ** BigInt(held.decimals) > held.amount * 10n ** BigInt(p.asset.decimals)) throw new Refused(`The bridge holds less ${p.asset.symbol} on Canton than this, so the withdrawal would not be taken into a block. Withdraw a smaller amount.`);
        return last(p, "withdraw", () => d.evm.withdraw(d.config.gateway, p.asset.address, p.base, c.party), withdrawCall(d.config.gateway, p.asset.address, p.base, c.party));
      }
    }
  }

  /**
   * Runs one job at a time in this tab, and one at a time across tabs: the move's lock is held for the whole run and is never waited for. `prep` gives the record and whether the person has said go
   * to the next send. Where there are no Web Locks nothing runs.
   */
  function run(prep: () => Promise<{ c: Checkpoint; confirmed: boolean; expect?: Checkpoint }>): Promise<MoveState> {
    if (state.phase === "failed" || state.phase === "final" || state.phase === "paused") go({ phase: "idle" });
    ck = null;
    const job = (async () => {
      try {
        const { c, confirmed, expect } = await prep();
        ck = c;
        if (d.locks === null) throw new Pause(NO_LOCKS);
        const outcome = await d.locks.request("bridge-move:" + c.ref, { ifAvailable: true }, async (lock) => {
          if (lock === null) return "busy" as const;
          let record = c, go_ = confirmed;
          if (expect !== undefined) {
            // The record is read again here, with the lock held (another tab may have moved it on since this tab last looked): a send happens only if it is still the record this tab showed.
            const fresh = loadCheckpoint(d.store, c.ref);
            if (fresh === null) return "gone" as const;
            go_ = confirmed && JSON.stringify(fresh) === JSON.stringify(expect);
            record = fresh;
            ck = fresh;
          }
          await execute(record, go_);
          return "done" as const;
        });
        if (outcome === "gone") throw new Gone();
        if (outcome === "busy") throw new Pause("This move is being worked on in another tab or window. Wait until it stops there, then continue here.");
      } catch (e) {
        if (e instanceof Gone) ck = null; // another tab finished the move or gave it up: nothing is left to do
        else if (e instanceof Pause) go({ phase: "paused", note: e.message });
        else {
          const known = e instanceof Refused || e instanceof AmountError || e instanceof LockRefused;
          const reason = known ? (e as Error).message : (e as { shortMessage?: string }).shortMessage ?? walletWords(e);
          // Once anything has been done the record stays, so the move can be finished (also a move found already on Ostia that is only waiting for the explorer); a move that failed before that leaves nothing behind.
          const kept = ck !== null && (ck.stage !== "start" || e instanceof Waited);
          if (ck !== null && !kept) clearCheckpoint(d.store, ck.ref);
          go({ phase: "failed", reason, from: state.phase, kept });
        }
      }
      return state;
    })().finally(() => { running = null; });
    running = job;
    return job;
  }

  /**
   * A Canton step whose answer never came may still be recorded until its record time. Before the move is given up or taken back, look for it: if it appeared, the move goes on from there;
   * if it did not and its time has not passed, refuse (the step could still land after the record is gone).
   */
  async function settleCantonDoubt(c: Checkpoint, later: string): Promise<Checkpoint> {
    if (c.cantonBy === undefined) return c;
    const what = c.input.kind === "redeem" ? { redeem: c.ref } : c.stage === "allocated" ? { deposit: depositIdOf(c.party, c.ref) } : { allocation: c.ref };
    if (!(await d.canton.appeared(what)) && Date.now() <= c.cantonBy + RECORD_MARGIN_MS) {
      const minutes = Math.max(1, Math.ceil((c.cantonBy + RECORD_MARGIN_MS - Date.now()) / 60_000));
      throw new Refused(`Canton may still take the last step of this move. ${later} in about ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    }
    const next = { ...c, cantonBy: undefined };
    saveCheckpoint(d.store, next);
    return next;
  }

  /** The deposit's Canton side, taken back. `strict` (the person asked for it) refuses a deposit that was claimed; giving a deposit up lets a claimed one go (nothing is locked for it). */
  async function takeBackCanton(c: Checkpoint, strict: boolean): Promise<void> {
    const depositId = depositIdOf(c.party, c.ref);
    if (await d.evm.used(d.config.gateway, depositId)) {
      if (strict) throw new Refused("This deposit was claimed on Ostia, so there is nothing to take back. Continue it to see it final.");
      return;
    }
    const deadline = await d.canton.depositDeadline(c.ref);
    if (deadline !== null && Date.now() < deadline + TAKE_BACK_AFTER_MS) {
      const minutes = Math.max(1, Math.ceil((deadline + TAKE_BACK_AFTER_MS - Date.now()) / 60_000));
      throw new Refused(`Your tokens are locked on Canton until this deposit's time to settle has passed. Come back in about ${minutes} minute${minutes === 1 ? "" : "s"} to take them back.`);
    }
    // A claim still pending in the wallet would hold back the account's later transactions after the tokens are taken back (it can never be included then): cancel it first.
    if ((c.stage === "wallet" || c.stage === "sent") && (await pendingInWallet(c))) throw new Refused("The claim for this deposit is still waiting in your wallet. Cancel it in your wallet first, then take your tokens back.");
    try { await d.canton.recoverDeposit({ label: c.ref, depositId }); } catch (e) {
      // The account service does not offer it (403, 404) or the ledger refused it (422): waiting changes nothing. Anything else may clear by itself.
      if (permanent(e)) throw new CannotTakeBack("Canton would not take the tokens back. If you give this deposit up now, the tokens stay locked on Canton.");
      throw e;
    }
  }
  /** Removes a redeem's request on Canton, unless its release is made already (the request is then spent) or still waiting in the wallet (it must be cancelled there first). */
  async function removeRedeem(c: Checkpoint): Promise<void> {
    if (await d.evm.used(d.config.gateway, releaseIdOf(c.vault, c.ref))) return;
    if ((c.stage === "wallet" || c.stage === "sent") && (await pendingInWallet(c))) throw new Refused("The release of this redeem is still waiting in your wallet. Cancel it in your wallet first, then give this move up.");
    try { await d.canton.cancelRedeem(c.ref); } catch (e) { if (!permanent(e)) throw e; }   // a request the service will not remove cannot be helped by waiting; the record may go
  }
  /** A kept move of this account and party that no other tab is working on, under its lock. */
  async function withRecord<T>(id: string, f: (c: Checkpoint | null) => Promise<T>): Promise<T> {
    if (running) throw new Refused("A move is running; wait until it stops before giving it up.");
    if (d.locks === null) throw new Refused(NO_LOCKS);
    const record = loadCheckpoint(d.store, id);
    if (record !== null && !keptMoves(d.store, owner()).some((c) => c.ref === id)) throw new Refused("That move belongs to another account or Canton party.");
    const done = await d.locks.request("bridge-move:" + id, { ifAvailable: true }, async (lock) => (lock === null ? ({ busy: true } as const) : { busy: false as const, value: await f(loadCheckpoint(d.store, id)) }));
    if (done.busy) throw new Refused("That move is being worked on in another tab or window. Wait until it stops there.");
    return done.value;
  }
  const finish = (id: string) => { clearCheckpoint(d.store, id); if (id === ck?.ref) { ck = null; if (state.phase !== "idle") go({ phase: "idle" }); } };

  return {
    get state() { return state; },
    get current() { return ck?.ref ?? null; },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    start(input) {
      if (running || !["idle", "final", "failed"].includes(state.phase)) return Promise.reject(new Refused("Another move is not finished yet."));
      if (d.locks === null) return Promise.reject(new Refused(NO_LOCKS));
      if (keptMoves(d.store, owner()).length > 0) return Promise.reject(new Refused("An earlier move of this account is kept. Continue it, or give it up, before starting another."));
      return run(async () => {
        const ref = d.newRef();
        if (ref.length === 0 || ref.length > 128) throw new Refused("The move could not be given an id.");
        const account = d.evm.account, c: Checkpoint = { input, ref, account, party: d.canton.party(), vault: d.config.vault, to: input.kind === "redeem" ? input.to ?? account : undefined, stage: "start" };
        const p = plan(c);
        if (input.kind === "redeem") c.vault = await pickVault(p.asset, p.base);
        c.at = Date.now();
        saveCheckpoint(d.store, c);
        return { c, confirmed: true };
      });
    },
    resume(ref) {
      if (running) return running;
      const c = loadCheckpoint(d.store, ref, owner());
      return c ? run(async () => ({ c, confirmed: false })) : Promise.resolve(state);
    },
    proceed() {
      if (running) return running;
      const c0 = ck;
      if (!c0 || !(state.phase === "paused" || (state.phase === "failed" && state.kept))) return Promise.resolve(state);
      // The record is shared by every tab, so it is read again once the move's lock is held (in `run`): if another tab moved it on, this tab only shows where it is.
      return run(async () => ({ c: c0, confirmed: true, expect: c0 }));
    },
    kept: () => keptMoves(d.store, owner()),
    async abandon(ref, opts) {
      if (running) throw new Refused("A move is running; wait until it stops before giving it up.");
      const id = ref ?? ck?.ref;
      if (id === undefined) throw new Refused("Say which move to give up.");
      await withRecord(id, async (c0) => {
        const c = c0 === null ? null : await settleCantonDoubt(c0, "Give this move up");
        // A deposit with a Canton step done has tokens locked on Canton: they are taken back before the record goes.
        if (c !== null && c.input.kind === "deposit" && TAKE_BACK_STAGES.includes(c.stage)) {
          try { await takeBackCanton(c, false); } catch (e) { if (!(opts?.leaveLocked === true && e instanceof CannotTakeBack)) throw e; }
        }
        // A redeem request is open on Canton from its first Canton step: it is removed before the record goes (unless the release was made, which burned what it named), so no dead request is left.
        if (c !== null && c.input.kind === "redeem" && REDEEM_OPEN_STAGES.includes(c.stage)) await removeRedeem(c);
        clearCheckpoint(d.store, id);
      });
      finish(id);
    },
    async takeBackDue(ref) {
      const c = loadCheckpoint(d.store, ref ?? ck?.ref, owner());
      if (c === null || c.input.kind !== "deposit" || !TAKE_BACK_STAGES.includes(c.stage)) return false;
      try {
        if (await d.evm.used(d.config.gateway, depositIdOf(c.party, c.ref))) return false;
        const deadline = await d.canton.depositDeadline(c.ref);
        // With no allocation left to read, only the request may remain: due once that request is on the ledger (the deposit wait is over).
        return deadline === null ? REQUEST_ON_LEDGER.includes(c.stage) : Date.now() >= deadline + TAKE_BACK_AFTER_MS;
      } catch { return false; }
    },
    async takeBack(ref) {
      if (running) throw new Refused("A move is running; wait until it stops before taking it back.");
      const id = ref ?? ck?.ref ?? loadCheckpoint(d.store, undefined, owner())?.ref;
      if (id === undefined) throw new Refused("Say which move to take back.");
      await withRecord(id, async (c0) => {
        if (c0 === null || c0.input.kind !== "deposit" || !TAKE_BACK_STAGES.includes(c0.stage)) throw new Refused("Only a deposit with tokens locked on Canton can be taken back.");
        const c = await settleCantonDoubt(c0, "Take it back");
        await takeBackCanton(c, true);
        clearCheckpoint(d.store, id);
      });
      finish(id);
    },
  };
}
