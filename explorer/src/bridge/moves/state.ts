import { sha256, stringToBytes, type Address, type Hex } from "viem";

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
  "sending-evm": ["sending-evm", "proving", "failed"],
  proving: ["proving", "final", "failed"],
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

export const STAGES = ["start", "signing", "allocated", "canton", "evm", "wallet", "sent"] as const;

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
  step?: Step; nonce?: number; tx?: Hex;
}

export interface StoreLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const KEY = "bridge-move:", INDEX = "bridge-moves";

/** The tab's session storage, or null where there is none (a private window, a preview). */
export function sessionStore(): StoreLike | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
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
/** The move kept under `ref`, or the newest one when none is named. */
export function loadCheckpoint(store: StoreLike | null, ref?: string): Checkpoint | null {
  try {
    const id = ref ?? listMoves(store).at(-1);
    const c = id === undefined ? null : (JSON.parse(store?.getItem(KEY + id) ?? "null") as Checkpoint | null);
    return c && typeof c.ref === "string" && typeof c.input?.kind === "string" && typeof c.account === "string" && typeof c.party === "string" && typeof c.vault === "string" && (STAGES as readonly string[]).includes(c.stage) ? c : null;
  } catch { return null; }
}
