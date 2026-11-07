import type { Address, Hex } from "viem";
import { ApiError, getTx, type ApiTx, type BlockLeg } from "../../api.ts";
import { walletWords } from "../../wallet.ts";
import { AmountError, parseAmount } from "../amounts.ts";
import type { EvmAdapter } from "../evm/adapter.ts";
import type { BridgeConfig, BridgeToken } from "../evm/config.ts";
import { LockRefused, type RegistryAdapter } from "../evm/registry.ts";
import {
  clearCheckpoint, depositIdOf, loadCheckpoint, lockIdOf, releaseIdOf, saveCheckpoint, transition,
  type Checkpoint, type MoveInput, type MoveState, type Step, type StoreLike,
} from "./state.ts";

/** The Canton side, built by the account slice: the user's own key signs, and each wait ends when the command is on the ledger. Amounts are in Canton's 10 decimals. */
export interface CantonAdapter {
  /** The user's Canton party id. */
  party(): string;
  signRedeem(a: { asset: Address; amount: bigint; recipient: Address; ref: string }): Promise<void>;
  waitRedeem(ref: string): Promise<void>;
  signDeposit(a: { instrument: { admin: string; id: string }; amount: bigint; label: string; depositId: Hex; recipient: Address }): Promise<void>;
  waitDeposit(depositId: Hex): Promise<void>;
}

export interface Deps {
  config: BridgeConfig;
  evm: EvmAdapter;
  registry: RegistryAdapter;
  canton: CantonAdapter;
  /** The explorer's /api/tx/{hash}; null while the explorer has not seen the transaction. */
  api: { tx(hash: Hex): Promise<ApiTx | null> };
  store: StoreLike | null;
  sleep(ms: number): Promise<void>;
  /** A fresh, unique ref (or deposit label). */
  newRef(): string;
  pollMs?: number;
  maxPolls?: number;
}

/** The explorer's own answer for a transaction; a 404 is a transaction it has not seen yet. */
export const explorerTx = async (hash: Hex): Promise<ApiTx | null> => {
  try { return await getTx(hash); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
};

/** A refusal with the words the person reads. */
export class Refused extends Error {}
/** The explorer did not show the move final in time. The transaction is sent, so the move is kept for a reload. */
class Waited extends Refused {}

const PARTY = /^[^:\s]+::1220[0-9a-f]{64}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface Move {
  readonly state: MoveState;
  subscribe(fn: (s: MoveState) => void): () => void;
  start(input: MoveInput): Promise<MoveState>;
  /** Picks up the move kept in session storage after a reload; idle when there is none. */
  resume(): Promise<MoveState>;
}

export function createMove(d: Deps): Move {
  let state: MoveState = { phase: "idle" };
  let ck: Checkpoint | null = null;
  const subs = new Set<(s: MoveState) => void>();
  const go = (next: MoveState) => { state = transition(state, next); subs.forEach((f) => f(state)); };
  const save = (patch: Partial<Checkpoint>) => { ck = { ...ck!, ...patch }; saveCheckpoint(d.store, ck); };
  const assetOf = (list: BridgeToken[], a: Address) => list.find((t) => same(t.address, a)) ?? (() => { throw new Refused("The bridge does not move this token."); })();

  /** What a move is about: the token, the amounts, the id its leg carries and the leg that shows it happened. */
  function plan(input: MoveInput, ref: string) {
    const account = d.evm.account;
    switch (input.kind) {
      case "lock": {
        if (!PARTY.test(input.receiver)) throw new Refused("The receiver is not a Canton party id (a name, then ::1220 and 64 hex digits).");
        const id = lockIdOf(input.receiver, ref), asset = assetOf(d.config.twins, input.asset);
        return { asset, ...parseAmount(input.amount, asset.decimals), id, match: (l: BlockLeg) => l.kind === "payment" && same(l.legId, id) };
      }
      case "redeem": {
        const id = releaseIdOf(d.config.vault, ref), asset = assetOf(d.config.twins, input.asset);
        return { asset, ...parseAmount(input.amount, asset.decimals), id, match: (l: BlockLeg) => l.kind === "payment" && same(l.legId, id) };
      }
      case "deposit": {
        const id = depositIdOf(d.canton.party(), ref), asset = assetOf(d.config.wrapped, input.asset);
        return { asset, ...parseAmount(input.amount, asset.decimals), id, match: (l: BlockLeg) => l.kind === "deposit" && same(l.legId, id) };
      }
      case "withdraw": {
        const asset = assetOf(d.config.wrapped, input.asset), a = parseAmount(input.amount, asset.decimals);
        return { asset, ...a, id: null, match: (l: BlockLeg) => l.kind === "withdrawal" && same(l.token, asset.address) && same(l.account, account) && l.amount === a.base.toString() };
      }
    }
  }

  /** Sends one EVM step. */
  const step = (name: Step, send: () => Promise<Hex>) => { go({ phase: "sending-evm", step: name }); return send(); };
  const mined = async (tx: Hex, what: string) => { if (!(await d.evm.waitReceipt(tx)).success) throw new Refused(`${what} failed on Ostia.`); };
  const enough = async (asset: BridgeToken, base: bigint) => { if ((await d.evm.balanceOf(asset.address)) < base) throw new Refused(`You do not hold enough ${asset.symbol}.`); };

  /** Sends the move's own transaction, keeps its hash, and waits for the explorer to show it final with its leg. */
  async function last(name: Step, send: () => Promise<Hex>, match: (l: BlockLeg) => boolean) {
    const tx = await step(name, send);
    save({ stage: "sent", tx });
    await prove(tx, match);
  }

  async function prove(tx: Hex, match: (l: BlockLeg) => boolean) {
    go({ phase: "proving", tx });
    for (let i = 0; i < (d.maxPolls ?? 200); i++) {
      const t = await d.api.tx(tx).catch(() => null);
      if (t?.status === "dropped" || t?.status === "replaced") throw new Refused("The transaction was dropped before it was in a block.");
      if (t?.status === "final") {
        if (t.success === false) throw new Refused("The transaction failed on Ostia.");
        if (!t.legs.some(match)) throw new Refused("The transaction is final, but it made no leg of this move.");
        go({ phase: "final", tx, block: t.block?.number ?? 0 });
        clearCheckpoint(d.store);
        return;
      }
      await d.sleep(d.pollMs ?? 3000);
    }
    throw new Waited("Waiting for the block took too long. Reload this page to keep waiting.");
  }

  async function execute(c: Checkpoint) {
    const { input, ref } = c, p = plan(input, ref), account = d.evm.account;
    if (c.stage === "sent" && c.tx) return prove(c.tx, p.match);
    switch (input.kind) {
      case "lock": {
        const wraps = input.wrapNative === true && d.config.wrapper !== null && same(p.asset.address, d.config.wrapper);
        if (!wraps) await enough(p.asset, p.base);
        go({ phase: "sending-evm", step: "prepare" });
        const parts = await d.registry.lockParts({ receiver: input.receiver, ref });
        if (!same(parts.lockId, p.id!)) throw new Refused("The registry gave a lock id that is not the one this lock makes. Nothing was sent.");
        if (wraps) {
          const held = await d.evm.balanceOf(p.asset.address);
          if (held < p.base) {
            if ((await d.evm.native()) < p.base - held) throw new Refused(`You do not hold enough ${d.config.chain.coin.symbol}.`);
            await mined(await step("wrap", () => d.evm.wrap(p.asset.address, p.base - held)), "The wrap");
          }
        }
        if ((await d.evm.allowance(p.asset.address, d.config.gateway)) < p.base) await mined(await step("approve", () => d.evm.approve(p.asset.address, d.config.gateway, p.base)), "The approval");
        return last("pay", () => d.evm.pay(d.config.gateway, p.id!, p.asset.address, d.config.vault, p.base), p.match);
      }
      case "redeem": {
        const to = input.to ?? account;
        if (c.stage === "start") {
          save({ stage: "canton" });
          go({ phase: "signing-canton" });
          await d.canton.signRedeem({ asset: p.asset.address, amount: p.twin, recipient: to, ref });
        }
        if (c.stage !== "evm") { go({ phase: "waiting-canton", ref }); await d.canton.waitRedeem(ref); save({ stage: "evm" }); }
        return last("release", () => d.evm.release(d.config.vault, ref, p.asset.address, to, p.base), p.match);
      }
      case "deposit": {
        if (c.stage === "start") {
          save({ stage: "canton" });
          go({ phase: "signing-canton" });
          await d.canton.signDeposit({ instrument: p.asset.instrument!, amount: p.twin, label: ref, depositId: p.id!, recipient: account });
        }
        if (c.stage !== "evm") { go({ phase: "waiting-canton", ref }); await d.canton.waitDeposit(p.id!); save({ stage: "evm" }); }
        return last("claim", () => d.evm.claim(d.config.gateway, p.id!, p.asset.address, p.twin), p.match);
      }
      case "withdraw": {
        await enough(p.asset, p.base);
        return last("withdraw", () => d.evm.withdraw(d.config.gateway, p.asset.address, p.base, d.canton.party()), p.match);
      }
    }
  }

  async function run(c: Checkpoint): Promise<MoveState> {
    if (state.phase === "failed" || state.phase === "final") go({ phase: "idle" });
    ck = c;
    try {
      await execute(c);
    } catch (e) {
      const known = e instanceof Refused || e instanceof AmountError || e instanceof LockRefused;
      const reason = known ? (e as Error).message : (e as { shortMessage?: string }).shortMessage ?? walletWords(e);
      if (!(e instanceof Waited)) clearCheckpoint(d.store);
      go({ phase: "failed", reason, from: state.phase });
    }
    return state;
  }

  return {
    get state() { return state; },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    start(input) {
      const c: Checkpoint = { input, ref: d.newRef(), stage: "start" };
      saveCheckpoint(d.store, c);
      return run(c);
    },
    resume() {
      const c = loadCheckpoint(d.store);
      return c ? run(c) : Promise.resolve(state);
    },
  };
}
