import type { Address, Hex } from "viem";
import { ApiError, getAddressTxs, getLeg, getTx, type ApiTx, type BlockLeg } from "../../api.ts";
import { walletWords } from "../../wallet.ts";
import { AmountError, parseAmount, tenDecimals } from "../amounts.ts";
import { approveCall, wrapCall, withdrawCall, type Call, type EvmAdapter } from "../evm/adapter.ts";
import type { BridgeConfig, BridgeToken } from "../evm/config.ts";
import { LockRefused, type RegistryAdapter } from "../evm/registry.ts";
import {
  clearCheckpoint, depositIdOf, keptMoves, loadCheckpoint, lockIdOf, releaseIdOf, saveCheckpoint, transition,
  type Checkpoint, type MoveInput, type MoveState, type Step, type StoreLike,
} from "./state.ts";

/**
 * The Canton side, built by the account slice: the user's own key signs, and each wait ends when the command is on the ledger.
 * Every amount is an exact 10-decimal string ("1.5000000000"). `ref` and `label` are random and at most 128 characters. A call that is made again for the same ref, label or
 * deposit id after a reload must do nothing twice: the move never signs twice on purpose, but it cannot know whether a reload came before or after a command reached the ledger.
 */
export interface CantonAdapter {
  /** The user's Canton party id, worked out locally (no request). */
  party(): string;
  signRedeem(a: { asset: Address; amount: string; recipient: Address; ref: string }): Promise<void>;
  /** Ends when the redeem request is open. After a reload it reads GET /accounts/v1/open/{party}. */
  waitRedeem(ref: string): Promise<void>;
  /** A deposit's first Canton step: allocate the tokens under `label`. The move saves a checkpoint when it returns. */
  allocateDeposit(a: { instrument: { admin: string; id: string }; amount: string; label: string }): Promise<void>;
  /** Its second step: the deposit request, which uses that allocation. */
  signDeposit(a: { instrument: { admin: string; id: string }; amount: string; label: string; depositId: Hex; recipient: Address }): Promise<void>;
  /** Ends when the deposit is on the ledger. After a reload it reads GET /accounts/v1/open/{party} and GET /accounts/v1/allocations/{party}. */
  waitDeposit(depositId: Hex): Promise<void>;
}

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
  store: StoreLike | null;
  sleep(ms: number): Promise<void>;
  /** A fresh random id for a move: at most 128 characters. */
  newRef(): string;
  pollMs?: number;
  maxPolls?: number;
}

/** The explorer's own answer for a transaction; a 404 is a transaction it has not seen yet. */
export const explorerTx = async (hash: Hex): Promise<ApiTx | null> => {
  try { return await getTx(hash); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
};
export const explorerLeg: Deps["leg"] = async (id) => {
  try { return await getLeg(id); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
};
export const explorerSentSince: Deps["sentSince"] = async (account, nonce) =>
  (await getAddressTxs(account, null, 50, "sent")).items.filter((t) => t.nonce >= nonce).sort((a, b) => a.nonce - b.nonce).map((t) => t.hash as Hex);
export const randomRef = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** A refusal with the words the person reads. */
export class Refused extends Error {}
/** The explorer did not show the move final in time. The move is kept for a reload. */
class Waited extends Refused {}
/** The move stops here until the person continues. */
class Pause extends Error {}

const PARTY = /^[^:\s]+::1220[0-9a-f]{64}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** The steps whose transaction is the move's own, and shows its leg. */
const LAST: Step[] = ["pay", "release", "claim", "withdraw"];

export interface Move {
  readonly state: MoveState;
  subscribe(fn: (s: MoveState) => void): () => void;
  /** Starts a move. Refused unless the last one is idle, final or failed, and while a move of this account is kept (continue it or abandon it first). */
  start(input: MoveInput): Promise<MoveState>;
  /**
   * Picks up a move kept in storage after a reload (the newest of this account and party, or the one named); idle when there is none. It only reads, waits and shows where the move is:
   * it never asks the wallet or signs, so a move that needs a send ends in `paused`. A second call while the first runs gets the same promise.
   */
  resume(ref?: string): Promise<MoveState>;
  /** The moves kept for the current account and party, newest first: for the screens to show and choose from. */
  kept(): Checkpoint[];
  /** Carries on a paused move, or retries a failed one that is kept: this is the person's go for the next send. */
  proceed(): Promise<MoveState>;
  /** The person gives the move up: its record is removed. Rejects while a move is running. */
  abandon(ref?: string): Promise<void>;
}

export function createMove(d: Deps): Move {
  let state: MoveState = { phase: "idle" };
  let ck: Checkpoint | null = null;
  let running: Promise<MoveState> | null = null;
  const owner = () => ({ account: d.evm.account, party: d.canton.party() });
  const subs = new Set<(s: MoveState) => void>();
  const go = (next: MoveState) => { state = transition(state, next); subs.forEach((f) => f(state)); };
  const save = (patch: Partial<Checkpoint>) => { ck = { ...ck!, ...patch }; saveCheckpoint(d.store, ck); };
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
        return { asset, ...parseAmount(input.amount, asset.decimals), id, match: (l: BlockLeg) => l.kind === "payment" && same(l.legId, id) };
      }
      case "redeem": {
        const id = releaseIdOf(c.vault, ref), asset = assetOf(d.config.twins, input.asset);
        return { asset, ...parseAmount(input.amount, asset.decimals), id, match: (l: BlockLeg) => l.kind === "payment" && same(l.legId, id) };
      }
      case "deposit": {
        const id = depositIdOf(party, ref), asset = assetOf(d.config.wrapped, input.asset);
        return { asset, ...parseAmount(input.amount, asset.decimals), id, match: (l: BlockLeg) => l.kind === "deposit" && same(l.legId, id) };
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
  async function pickVault(asset: BridgeToken, base: bigint): Promise<Address> {
    for (const v of d.config.vaults) if ((await d.evm.balanceOf(asset.address, v)) >= base) return v;
    throw new Refused(`The vault does not hold enough ${asset.symbol} to release this amount.`);
  }

  /** A transaction of the account, at the saved nonce or after it, that makes exactly the call this move asked its wallet for (the same `to`, input data and value). A nonce alone proves nothing. */
  async function findCall(c: Checkpoint): Promise<Hex | null> {
    if (!c.call || c.nonce === undefined) return null;
    for (const h of await d.sentSince(c.account, c.nonce).catch(() => [] as Hex[])) {
      const t = await d.api.tx(h).catch(() => null);
      if (t && same(t.from, c.account) && t.to !== null && same(t.to, c.call.to) && t.input !== null && same(t.input, c.call.data) && (c.call.value === undefined || t.value === c.call.value)) return h;
    }
    return null;
  }
  /** The transaction that made a move's leg. A move with an id (lock, redeem, deposit) is found by that id and nothing else; a withdrawal, which has none, by the call it made. Null while the explorer has not got it. */
  const lookup = async (c: Checkpoint, id: Hex | null): Promise<Hex | null> =>
    id ? ((await d.leg(id).catch(() => null))?.txHash as Hex | null | undefined) ?? null : findCall(c);
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
    go({ phase: "sending-evm", step: name });
    save({ stage: "wallet", step: name, call, nonce: await d.evm.nonce() });
    let tx: Hex;
    try { tx = await send(); } catch (e) { save(reset()); throw e; }
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

  async function prove(first: Hex, p: Plan) {
    let tx = first, lost = false;
    go({ phase: "proving", tx });
    for (let i = 0; i < (d.maxPolls ?? 200); i++) {
      const t = await d.api.tx(tx).catch(() => null);
      lost = t?.status === "dropped" || t?.status === "replaced";
      if (lost) {
        // A speed-up or a replacement in the wallet is another hash for the same move: find it by the move's id, or by the nonce. The progress is kept either way.
        const other = await lookup(ck!, p.id);
        if (other && !same(other, tx)) { tx = other; save({ tx }); go({ phase: "proving", tx }); continue; }
      } else if (t?.status === "final") {
        if (t.success === false) throw new Refused("The transaction failed on Ostia.");
        if (!t.legs.some(p.match)) {
          // Not this move's transaction. If the id is not used (or a withdrawal has none) nothing of the move has happened: go back before the send and wait for the person.
          if (p.id !== null && (await d.evm.used(d.config.gateway, p.id))) throw new Refused("The transaction is final, but it made no leg of this move.");
          save(reset());
          throw new Pause("That transaction made no leg of this move, so the move has not happened on Ostia. Continue to send it again.");
        }
        go({ phase: "final", tx, block: t.block?.number ?? 0 });
        clearCheckpoint(d.store, ck!.ref);
        return;
      }
      await d.sleep(d.pollMs ?? 3000);
    }
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
    if (at() === "sent" && c.tx) return prove(c.tx, p);
    if (at() === "wallet") {
      // The wallet was asked at this step. A move with an id is decided by the id below. For a wrap, an approval or a withdrawal, the account's own transaction counts only when it makes exactly the saved call.
      if (c.call) {
        let h: Hex | null = c.tx ?? (await findCall(c));
        if (!h && c.nonce !== undefined && (await d.evm.nonce()) > c.nonce) h = await poll(() => findCall(c));
        if (h) {
          if (LAST.includes(c.step!)) return adopt(h, p);
          await mined(h, "The transaction");
        }
      }
      save(reset());
    }
    // An id that is already used was made by an earlier send: find its transaction and prove it, never send again.
    if (p.id && (at() === "start" || at() === "evm") && (await d.evm.used(d.config.gateway, p.id))) {
      const h = await poll(() => lookup(c, p.id));
      if (!h) throw new Waited("This move is already on Ostia, and the explorer has not shown its transaction yet. Reload this page to keep waiting.");
      return adopt(h, p);
    }
    const waitCanton = async (wait: () => Promise<void>) => { go({ phase: "waiting-canton", ref }); await wait(); save({ stage: "evm" }); };
    const sign = (f: () => Promise<void>) => { if (state.phase !== "signing-canton") go({ phase: "signing-canton" }); return f(); };
    switch (input.kind) {
      case "lock": {
        gate("Your lock is saved. Continue to ask your wallet.");
        const wraps = input.wrapNative === true;
        if (!wraps) await enough(p.asset, p.base);
        go({ phase: "sending-evm", step: "prepare" });
        const parts = await d.registry.lockParts({ receiver: input.receiver, ref });
        if (!same(parts.lockId, p.id!)) throw new Refused("The registry gave a lock id that is not the one this lock makes. Nothing was sent.");
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
        return last(p, "pay", () => d.evm.pay(d.config.gateway, p.id!, p.asset.address, c.vault, p.base));
      }
      case "redeem": {
        if (at() === "start" || at() === "signing") {
          gate("Your redeem is saved. Continue to sign it on Canton.");
          save({ stage: "signing" });
          await sign(() => d.canton.signRedeem({ asset: p.asset.address, amount: tenDecimals(p.twin), recipient: c.to!, ref }));
          save({ stage: "canton" });
        }
        if (at() === "canton") await waitCanton(() => d.canton.waitRedeem(ref));
        gate("Canton has your redeem. Continue to ask your wallet for the release.");
        return last(p, "release", () => d.evm.release(c.vault, ref, p.asset.address, c.to!, p.base));
      }
      case "deposit": {
        const a = { instrument: p.asset.instrument!, amount: tenDecimals(p.twin), label: ref };
        if (at() === "start" || at() === "signing") {
          gate("Your deposit is saved. Continue to allocate the tokens on Canton.");
          save({ stage: "signing" });
          await sign(() => d.canton.allocateDeposit(a));
          save({ stage: "allocated" });
        }
        if (at() === "allocated") {
          gate("The tokens are allocated on Canton. Continue to send the deposit request.");
          await sign(() => d.canton.signDeposit({ ...a, depositId: p.id!, recipient: c.account }));
          save({ stage: "canton" });
        }
        if (at() === "canton") await waitCanton(() => d.canton.waitDeposit(p.id!));
        gate("Canton has your deposit. Continue to ask your wallet for the claim.");
        return last(p, "claim", () => d.evm.claim(d.config.gateway, p.id!, p.asset.address, p.twin));
      }
      case "withdraw": {
        gate("Your withdrawal is saved. Continue to ask your wallet.");
        await enough(p.asset, p.base);
        return last(p, "withdraw", () => d.evm.withdraw(d.config.gateway, p.asset.address, p.base, c.party), withdrawCall(d.config.gateway, p.asset.address, p.base, c.party));
      }
    }
  }

  /** Runs one job at a time: `prep` gives the record, `confirmed` says whether the person has said go to the next send. */
  function run(prep: () => Promise<Checkpoint>, confirmed: boolean): Promise<MoveState> {
    if (state.phase === "failed" || state.phase === "final" || state.phase === "paused") go({ phase: "idle" });
    ck = null;
    const job = (async () => {
      try {
        ck = await prep();
        await execute(ck, confirmed);
      } catch (e) {
        if (e instanceof Pause) go({ phase: "paused", note: e.message });
        else {
          const known = e instanceof Refused || e instanceof AmountError || e instanceof LockRefused;
          const reason = known ? (e as Error).message : (e as { shortMessage?: string }).shortMessage ?? walletWords(e);
          // Once anything has been done the record stays, so the move can be finished; a move that failed before that leaves nothing behind.
          const kept = ck !== null && ck.stage !== "start";
          if (ck !== null && !kept) clearCheckpoint(d.store, ck.ref);
          go({ phase: "failed", reason, from: state.phase, kept });
        }
      }
      return state;
    })().finally(() => { running = null; });
    running = job;
    return job;
  }

  return {
    get state() { return state; },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    start(input) {
      if (running || !["idle", "final", "failed"].includes(state.phase)) return Promise.reject(new Refused("Another move is not finished yet."));
      if (keptMoves(d.store, owner()).length > 0) return Promise.reject(new Refused("An earlier move of this account is kept. Continue it, or give it up, before starting another."));
      return run(async () => {
        const ref = d.newRef();
        if (ref.length === 0 || ref.length > 128) throw new Refused("The move could not be given an id.");
        const account = d.evm.account, c: Checkpoint = { input, ref, account, party: d.canton.party(), vault: d.config.vault, to: input.kind === "redeem" ? input.to ?? account : undefined, stage: "start" };
        const p = plan(c);
        if (input.kind === "redeem") c.vault = await pickVault(p.asset, p.base);
        saveCheckpoint(d.store, c);
        return c;
      }, true);
    },
    resume(ref) {
      if (running) return running;
      const c = loadCheckpoint(d.store, ref, owner());
      return c ? run(async () => c, false) : Promise.resolve(state);
    },
    proceed() {
      if (running) return running;
      const c = ck;
      return c && (state.phase === "paused" || (state.phase === "failed" && state.kept)) ? run(async () => c, true) : Promise.resolve(state);
    },
    kept: () => keptMoves(d.store, owner()),
    abandon(ref) {
      if (running) return Promise.reject(new Refused("A move is running; wait until it stops before giving it up."));
      const id = ref ?? ck?.ref ?? keptMoves(d.store, owner())[0]?.ref;
      if (id !== undefined) clearCheckpoint(d.store, id);
      if (id === undefined || id === ck?.ref) { ck = null; if (state.phase !== "idle") go({ phase: "idle" }); }
      return Promise.resolve();
    },
  };
}
