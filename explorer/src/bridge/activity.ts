// The moves of a wallet account, for the Activity list: the ones kept in this browser that are not finished, and the ones that finished (a short list the page keeps when a move ends).
// A record holds no key and no secret.
import type { Address, Hex } from "viem";
import type { OpenState } from "./canton/accounts.ts";
import type { Marks } from "./marks.ts";
import { depositIdOf, keptMoves, STAGES, type Checkpoint, type MoveKind, type MoveState, type StoreLike } from "./moves/state.ts";
import type { Pair } from "./tokens.ts";

/** One move, finished or not, as the Activity list and the bar under the card show it. */
export interface Entry {
  ref: string;
  kind: MoveKind;
  asset: Address;
  /** The amount as it was typed. */
  amount: string;
  account: Address;
  party: string;
  /** When the move was last worked on (ms). */
  at: number;
  /** The transaction that made the move on Ostia, once it was sent. */
  tx: Hex | null;
  block: number | null;
  done: boolean;
  /** Where an unfinished move stopped (null for a finished one). */
  stage: Checkpoint["stage"] | null;
}

const HISTORY = "bridge-history", LIMIT = 50;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const entryOf = (c: Checkpoint, tx: Hex | null = c.tx ?? null): Entry =>
  ({ ref: c.ref, kind: c.input.kind, asset: c.input.asset, amount: c.input.amount, account: c.account, party: c.party, at: c.at ?? Date.now(), tx, block: null, done: false, stage: c.stage });

const isEntry = (e: unknown): e is Entry => {
  const x = e as Entry | null;
  return typeof x === "object" && x !== null && typeof x.ref === "string" && typeof x.kind === "string" && typeof x.asset === "string" && typeof x.amount === "string" && typeof x.account === "string" && typeof x.at === "number";
};
/** The moves that finished, newest first. */
export function finished(store: StoreLike | null): Entry[] {
  try { const l = JSON.parse(store?.getItem(HISTORY) ?? "[]") as unknown; return Array.isArray(l) ? l.filter(isEntry) : []; } catch { return []; }
}
/** Writes down a move that ended: `tx` and `block` are the transaction that made it and the block it is final in. The list keeps the latest 50. */
export function remember(store: StoreLike | null, e: Entry): void {
  try { store?.setItem(HISTORY, JSON.stringify([{ ...e, done: true, stage: null }, ...finished(store).filter((x) => x.ref !== e.ref)].slice(0, LIMIT))); } catch { /* the move is final either way; it just is not listed after a reload */ }
}

/** The moves of a wallet account, newest first: those kept and not finished, and those that finished. A finished move is listed once. */
export function rowsOf(store: StoreLike | null, account: string): Entry[] {
  const done = finished(store).filter((e) => same(e.account, account));
  const open = keptMoves(store).filter((c) => same(c.account, account) && !done.some((e) => e.ref === c.ref)).map((c) => entryOf(c));
  return [...open, ...done].sort((a, b) => b.at - a.at);
}

/**
 * Keeps the list of finished moves: it looks at the move's state as it changes, remembers the record that is kept, and when the move is final writes it down with its transaction and block.
 * `kept` is the move library's own list. Returns what stops the watching.
 */
export function track(move: { subscribe(fn: (s: MoveState) => void): () => void; kept(): Checkpoint[] }, store: StoreLike | null): () => void {
  let last: Entry | null = null;
  return move.subscribe((s) => {
    const k = move.kept()[0];
    if (k) last = entryOf(k, s.phase === "proving" || s.phase === "final" ? s.tx : k.tx ?? null);
    if (s.phase === "final" && last) { remember(store, { ...last, tx: s.tx, block: s.block }); last = null; }
  });
}

/** Whether Canton shows the move's request open (a redeem by its ref, a deposit by the id its party and ref make), from the account service's list of open requests. */
export function openOnCanton(e: Entry, open: Pick<OpenState, "redeemRequests" | "depositRequests">): boolean {
  if (e.kind === "redeem") return open.redeemRequests.some((r) => r.arguments.ref === e.ref);
  if (e.kind === "deposit") {
    const id = depositIdOf(e.party, e.ref).slice(2).toLowerCase();
    return open.depositRequests.some((r) => typeof r.arguments.depositId === "string" && r.arguments.depositId.replace(/^0x/, "").toLowerCase() === id);
  }
  return false;
}

const AFTER_CANTON: Checkpoint["stage"][] = ["evm", "wallet", "sent"];
/** Where an unfinished move stands, in words. `onCanton`: the account service lists the move's request as open (so Canton has it even when the record has not caught up). */
export function standing(e: Entry, chainName: string, onCanton = false): string {
  const stage = e.stage ?? "start";
  const viaCanton = e.kind === "redeem" || e.kind === "deposit";
  if (stage === "sent") return "Sent. Waiting for the block to be final.";
  if (stage === "wallet") return "Your wallet was asked. Check it, then continue.";
  if (viaCanton && (AFTER_CANTON.includes(stage) || (onCanton && STAGES.indexOf(stage) < STAGES.indexOf("evm")))) {
    return e.kind === "redeem" ? `Canton has it. Release it on ${chainName}.` : `Canton has it. Claim it on ${chainName}.`;
  }
  if (!viaCanton) return "Saved. Your wallet has not been asked yet.";
  if (stage === "canton") return "Signed on Canton. Waiting for Canton to show it.";
  return stage === "start" ? "Saved. Not signed on Canton yet." : "Signing on Canton was started.";
}

/** What the row's button says: the step it carries on with. */
export function continueWords(e: Entry, chainName: string, onCanton = false): string {
  const stage = e.stage ?? "start";
  const ready = (AFTER_CANTON.includes(stage) && stage !== "sent") || (onCanton && STAGES.indexOf(stage) < STAGES.indexOf("evm"));
  if (ready && e.kind === "redeem") return `Release on ${chainName}`;
  if (ready && e.kind === "deposit") return `Claim on ${chainName}`;
  return "Continue";
}

/** What moved, in words: "5 CC to Ostia" ("tokens" where this build no longer lists the token). */
export function whatMoved(e: Entry, pairs: Pair[], chainName: string): string {
  const pair = pairs.find((p) => same(p.erc20, e.asset));
  const toCanton = e.kind === "lock" || e.kind === "withdraw";
  const symbol = pair ? (toCanton ? pair.ostia.symbol : pair.canton.symbol) : "tokens";
  return `${e.amount} ${symbol} to ${toCanton ? "Canton" : chainName}`;
}

/** The marks a row starts from before the explorer is asked: a finished move is final in its block. */
export const seedOf = (e: Entry): Marks => ({ sent: e.tx !== null, proven: e.done, final: e.done, block: e.block, updateId: null });
