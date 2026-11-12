// The moves of a wallet account, for the Activity list: the ones kept in this browser that are not finished, and the ones that finished (a short list the page keeps when a move ends).
// A record holds no key and no secret.
import type { Address, Hex } from "viem";
import type { OpenRequest, OpenState } from "./canton/accounts.ts";
import type { Marks } from "./marks.ts";
import { depositIdOf, keptMoves, sameId, STAGES, type Checkpoint, type MoveKind, type MoveState, type Step, type StoreLike } from "./moves/state.ts";
import { holdingsOf, typedAmount } from "./adopt.ts";
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
  /** The Canton update that holds the block, once it was read (so a finished row is not looked up again). */
  updateId?: string | null;
  done: boolean;
  /** Where an unfinished move stopped (null for a finished one). */
  stage: Checkpoint["stage"] | null;
  /** Canton lists this move as open, but this browser has no record of it: it was started in another browser. */
  elsewhere?: boolean;
}

const HISTORY = "bridge-history", LIMIT = 50;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const OWN_STEPS: Step[] = ["pay", "release", "claim", "withdraw"];
/** The transaction that made the move: the record's `tx` only when it is the move's own (not the approval or the wrap that came before it). */
const ownTx = (c: Checkpoint): Hex | null => (c.stage === "sent" || (c.step !== undefined && OWN_STEPS.includes(c.step)) ? c.tx ?? null : null);

export const entryOf = (c: Checkpoint, tx: Hex | null = ownTx(c)): Entry =>
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

/** Writes down the Canton update of a finished move, once it is read, so the list does not ask the explorer for it again. */
export function rememberUpdate(store: StoreLike | null, ref: string, updateId: string): void {
  try {
    const l = finished(store);
    if (l.some((x) => x.ref === ref)) store?.setItem(HISTORY, JSON.stringify(l.map((x) => (x.ref === ref ? { ...x, updateId } : x))));
  } catch { /* it is read again the next time */ }
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
export function track(move: { readonly state: MoveState; readonly current: string | null; subscribe(fn: (s: MoveState) => void): () => void; kept(): Checkpoint[] }, store: StoreLike | null): () => void {
  let last: Entry | null = null, closing = false;
  const off = move.subscribe((s) => {
    const k = recordOf(move.kept(), move.current);
    if (k) last = entryOf(k, s.phase === "proving" || s.phase === "final" ? s.tx : ownTx(k));
    if (s.phase === "final" && last) { remember(store, { ...last, tx: s.tx, block: s.block }); last = null; }
    if (closing && !RUNNING.includes(s.phase)) off();
  });
  // Stopping lets a move that is still running finish being written down (the person may have switched account while it ran).
  return () => { closing = true; if (!RUNNING.includes(move.state.phase)) off(); };
}

const RUNNING: MoveState["phase"][] = ["signing-canton", "waiting-canton", "sending-evm", "proving"];
/** The kept record of the move that is running (or held) now: the one the move names, never just the newest. */
export const recordOf = (kept: Checkpoint[], current: string | null | undefined): Checkpoint | undefined => (current ? kept.find((c) => c.ref === current) : undefined);

/** Whether Canton shows the move's request open (a redeem by its ref, a deposit by the id its party and ref make), from the account service's list of open requests. */
export function openOnCanton(e: Entry, open: Pick<OpenState, "redeemRequests" | "depositRequests">): boolean {
  if (e.kind === "redeem") return open.redeemRequests.some((r) => r.arguments.ref === e.ref);
  if (e.kind === "deposit") {
    const id = depositIdOf(e.party, e.ref);
    return open.depositRequests.some((r) => sameId(r.arguments.depositId, id));
  }
  return false;
}

/** An open request of the account that no row here accounts for: a move started in another browser. `request` is what Canton lists; `canContinue` is false where this build cannot carry it on. */
export interface Elsewhere { entry: Entry; kind: "redeem" | "deposit"; request: OpenRequest; canContinue: boolean;
  /** A redeem whose holdings are not all among the account's holdings any more, or a deposit that is finished here already (an extra request of the same label): it can never go on, and can only be removed. */
  spent?: boolean }

/**
 * The account's open requests on Canton with no row here, newest-unknown first. A redeem names its token and amount (and can be carried on where the bridge moves that token); a deposit names
 * neither until its allocation is read, so its row says only that a deposit is open.
 */
export function otherMoves(open: Pick<OpenState, "redeemRequests" | "depositRequests">, rows: Entry[], o: { account: Address; party: string; pairs: Pair[]; held?: ReadonlySet<string> | null }): Elsewhere[] {
  const out: Elsewhere[] = [];
  const base = { account: o.account, party: o.party, at: 0, tx: null, block: null, done: false, stage: "canton" as const, elsewhere: true };
  for (const r of open.redeemRequests) {
    const ref = r.arguments.ref, erc20 = r.arguments.token, amount = r.arguments.amount, holder = r.arguments.holder;
    if (typeof ref !== "string" || (typeof holder === "string" && holder !== o.party) || rows.some((e) => e.kind === "redeem" && e.ref === ref && !e.done)) continue;
    // A request still open for a redeem this browser has finished is a dead duplicate: it is listed as spent, so it can be removed.
    const finished = rows.some((e) => e.kind === "redeem" && e.ref === ref && e.done);
    const asset = (typeof erc20 === "string" ? `0x${erc20.replace(/^0x/, "").toLowerCase()}` : "0x") as Address;
    const known = o.pairs.some((p) => p.kind === "twin" && same(p.erc20, asset));
    const spent = finished || (o.held != null && !holdingsOf(r).every((h) => o.held!.has(h)));
    out.push({ kind: "redeem", request: r, canContinue: known && typeof amount === "string" && !spent, spent, entry: { ...base, ref, kind: "redeem", asset, amount: typeof amount === "string" ? typedAmount(amount) : "" } });
  }
  for (const r of open.depositRequests) {
    const label = r.arguments.label, depositor = r.arguments.depositor;
    if (typeof label !== "string" || (typeof depositor === "string" && depositor !== o.party)) continue;
    const same = rows.filter((e) => e.kind === "deposit" && openOnCanton(e, { redeemRequests: [], depositRequests: [r] }));
    if (same.some((e) => !e.done)) continue;
    // A request still open for a deposit this browser has finished is a dead duplicate (its allocation was claimed by the request that went through): it is listed as spent, so it can be removed.
    const spent = same.length > 0;
    out.push({ kind: "deposit", request: r, canContinue: !spent, spent, entry: { ...base, ref: label, kind: "deposit", asset: "0x" as Address, amount: "" } });
  }
  return out;
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
  return `Continue to ${e.kind === "lock" || e.kind === "withdraw" ? "Canton" : chainName}`;
}

/** What moved, in words: "5 Canton Coin to Ostia" ("tokens" where this build no longer lists the token; "Tokens to Ostia" where the amount is not known). */
export function whatMoved(e: Entry, pairs: Pair[], chainName: string): string {
  const pair = pairs.find((p) => same(p.erc20, e.asset));
  const toCanton = e.kind === "lock" || e.kind === "withdraw";
  // What arrives is named: the chain's own coin coming back from Canton arrives as its wrapped form.
  const symbol = pair ? (toCanton ? pair.ostia.symbol : pair.wrapped ?? pair.canton.symbol) : "tokens";
  return `${e.amount === "" ? "Tokens" : `${e.amount} ${symbol}`} to ${toCanton ? "Canton" : chainName}`;
}

/** The marks a row starts from before the explorer is asked: a finished move is final in its block. */
export const seedOf = (e: Entry): Marks => ({ sent: e.tx !== null, proven: e.done, final: e.done, block: e.block, updateId: e.updateId ?? null });

/**
 * A Bridge account (a party named `${partyHint}::...`) that this browser's records name for this wallet address and that is not `party`: the moves kept here and the moves that finished carry the account they were made for.
 * Null when the records name no other. A move made with a connected Canton wallet carries that wallet's party, which is not a Bridge account, so it is left out. A wallet that now signs another way would make a second, empty account, and these records are how the page can tell.
 */
export function otherAccountOf(store: StoreLike | null, wallet: string, party: string, partyHint: string): string | null {
  const mine = (e: { account: string; party: string }) => same(e.account, wallet) && e.party.startsWith(`${partyHint}::`) && e.party !== party;
  const entry = [...keptMoves(store).map((c) => ({ account: c.account, party: c.party })), ...finished(store)].find(mine);
  return entry?.party ?? null;
}
