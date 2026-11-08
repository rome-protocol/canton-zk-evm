import { sha256, stringToBytes, type Address, type Hex } from "viem";
import type { Call } from "../evm/adapter.ts";

/** The four moves. lock: an ERC-20 with a Canton twin, Ostia to Canton. redeem: the twin back. deposit: a Canton token to Ostia (claims the wrapped token). withdraw: a wrapped token back to Canton. */
export type MoveInput =
  | { kind: "lock"; asset: Address; amount: string; receiver: string; wrapNative?: boolean }
  | { kind: "redeem"; asset: Address; amount: string; to?: Address }
  | { kind: "deposit"; asset: Address; amount: string }
  | { kind: "withdraw"; asset: Address; amount: string };
export type MoveKind = MoveInput["kind"];

/** The step of the EVM work a move is on. */
export type Step = "prepare" | "wrap" | "approve" | "pay" | "release" | "claim" | "withdraw";

export type Phase = "idle" | "paused" | "signing-canton" | "waiting-canton" | "sending-evm" | "proving" | "final" | "failed";
export type MoveState =
  | { phase: "idle" }
  /** A move picked up after a reload, or one a send was refused for: its state is shown, and nothing is sent until the person continues. */
  | { phase: "paused"; note: string }
  | { phase: "signing-canton" }
  | { phase: "waiting-canton"; ref: string }
  | { phase: "sending-evm"; step: Step }
  /** The transaction is sent; the explorer has not yet shown its block final on Canton with the leg this move makes. */
  | { phase: "proving"; tx: Hex }
  | { phase: "final"; tx: Hex; block: number }
  /** `from` is the phase it stopped in. */
  | { phase: "failed"; reason: string; from: Phase; kept: boolean };

/** Which phase may follow which. A move that is picked up again after a reload enters at the phase it had reached. */
const NEXT: Record<Phase, Phase[]> = {
  idle: ["paused", "signing-canton", "waiting-canton", "sending-evm", "proving", "failed"],
  paused: ["idle"],
  "signing-canton": ["waiting-canton", "failed"],
  "waiting-canton": ["sending-evm", "paused", "failed"],
  "sending-evm": ["sending-evm", "proving", "paused", "failed"],
  proving: ["proving", "final", "paused", "failed"],
  final: ["idle"],
  failed: ["idle"],
};

export function transition(from: MoveState, to: MoveState): MoveState {
  if (!NEXT[from.phase].includes(to.phase)) throw new Error(`A move cannot go from ${from.phase} to ${to.phase}.`);
  return to;
}

/** The ids the chain derives (daml/src/Zk/Chain.daml, gateway/Vault.sol): SHA-256 of a tag and its parts. */
const idOf = (text: string): Hex => sha256(stringToBytes(text));
export const lockIdOf = (receiver: string, ref: string): Hex => idOf(`lock,${receiver},${ref}`);
export const depositIdOf = (depositor: string, label: string): Hex => idOf(`deposit,${depositor},${label}`);
export const releaseIdOf = (vault: Address, ref: string): Hex => idOf(`vault-release,${vault.slice(2).toLowerCase()},${ref}`);

/** An id as 32 bytes: 64 hex digits in lower case, with or without 0x. Null when it is not one. The chain's ids come with 0x from this page and without it from the registry. */
export const idBytes = (id: unknown): string | null => {
  if (typeof id !== "string") return null;
  const t = id.replace(/^0x/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
};
/** Whether two ids are the same 32 bytes, however each is written. An id that is not 32 bytes is never the same as anything. */
export const sameId = (a: unknown, b: unknown): boolean => { const x = idBytes(a); return x !== null && x === idBytes(b); };

export const STAGES = ["start", "signing", "allocated", "canton", "evm", "wallet", "sent"] as const;
/** The stages of a kept deposit whose tokens may be locked on Canton: every stage after its first Canton step began. Its claim may or may not have been sent. */
export const TAKE_BACK_STAGES: readonly (typeof STAGES)[number][] = ["signing", "allocated", "canton", "evm", "wallet", "sent"];

/**
 * Everything a reload needs to finish the move, and to refuse to finish it as someone else. One record per move, under its ref.
 * Stages: start: nothing done. signing: the first Canton command (a redeem, or a deposit's allocation) is started and may or may not be on the ledger; doing it again is safe. allocated: a deposit's allocation is done. canton: the Canton command is on the ledger (a redeem, or the deposit request): only the wait is left.
 * evm: Canton is done. wallet: the wallet is about to be asked for `step` at `nonce` (saved before it is asked). sent: the transaction is in `tx`.
 */
export interface Checkpoint {
  input: MoveInput;
  /** The move's id: random, at most 128 characters. */
  ref: string;
  /** The EVM account and the Canton party the move was started under, and the vault it pays into or releases from. */
  account: Address; party: string; vault: Address;
  /** A redeem's recipient on Ostia, as it was resolved when the move started. */
  to?: Address;
  stage: (typeof STAGES)[number];
  /** The step the wallet is asked for, the exact call it makes, and the nonce the send took: a guess (a lower bound) until the wallet returns the hash, then the transaction's own. */
  step?: Step; call?: Call; nonce?: number; tx?: Hex;
  /** When the record was last written (ms). A record more than 30 days old is no longer listed. */
  at?: number;
}

export interface StoreLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const KEY = "bridge-move:", INDEX = "bridge-moves";

/** The browser's local storage, so a kept move outlives the tab and the browser; null where there is none (a private window, a preview). A record holds no key and no secret. */
export function moveStore(): StoreLike | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
/** The refs of the moves kept, oldest first. */
export function listMoves(store: StoreLike | null): string[] {
  try { const l = JSON.parse(store?.getItem(INDEX) ?? "[]") as unknown; return Array.isArray(l) ? l.filter((r): r is string => typeof r === "string") : []; } catch { return []; }
}
export function saveCheckpoint(store: StoreLike | null, c: Checkpoint): void {
  try {
    store?.setItem(KEY + c.ref, JSON.stringify(c));
    if (!listMoves(store).includes(c.ref)) store?.setItem(INDEX, JSON.stringify([...listMoves(store), c.ref]));
  } catch { /* the move still runs; it just cannot be picked up after a reload */ }
}
export function clearCheckpoint(store: StoreLike | null, ref: string): void {
  try { store?.removeItem(KEY + ref); store?.setItem(INDEX, JSON.stringify(listMoves(store).filter((r) => r !== ref))); } catch { /* nothing to clear */ }
}
const valid = (c: Checkpoint | null): c is Checkpoint =>
  c !== null && typeof c.ref === "string" && typeof c.input?.kind === "string" && typeof c.account === "string" && typeof c.party === "string" && typeof c.vault === "string" && (STAGES as readonly string[]).includes(c.stage);
const read = (store: StoreLike | null, ref: string): Checkpoint | null => {
  try { const c = JSON.parse(store?.getItem(KEY + ref) ?? "null") as Checkpoint | null; return valid(c) ? c : null; } catch { return null; }
};
/** Who a move belongs to: the EVM account (any case) and the Canton party. */
export interface Owner { account: string; party: string }
const owns = (o: Owner | undefined, c: Checkpoint) => o === undefined || (o.account.toLowerCase() === c.account.toLowerCase() && o.party === c.party);
/** A record this old is dropped when the moves are listed. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** The moves kept, newest first, only those of `owner` when one is named: for the screens to show and choose from. Records older than 30 days are dropped (and removed) here. */
export function keptMoves(store: StoreLike | null, owner?: Owner, now: number = Date.now()): Checkpoint[] {
  const all = listMoves(store).reverse().map((r) => read(store, r)).filter((c): c is Checkpoint => c !== null);
  for (const c of all) if (c.at !== undefined && now - c.at > MAX_AGE_MS) clearCheckpoint(store, c.ref);
  return all.filter((c) => (c.at === undefined || now - c.at <= MAX_AGE_MS) && owns(owner, c));
}
/** The move kept under `ref`, or the newest one (of `owner`, when named) when no ref is given. */
export function loadCheckpoint(store: StoreLike | null, ref?: string, owner?: Owner): Checkpoint | null {
  return ref !== undefined ? read(store, ref) : keptMoves(store, owner)[0] ?? null;
}
