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

export type Phase = "idle" | "signing-canton" | "waiting-canton" | "sending-evm" | "proving" | "final" | "failed";
export type MoveState =
  | { phase: "idle" }
  | { phase: "signing-canton" }
  | { phase: "waiting-canton"; ref: string }
  | { phase: "sending-evm"; step: Step }
  /** The transaction is sent; the explorer has not yet shown its block final on Canton with the leg this move makes. */
  | { phase: "proving"; tx: Hex }
  | { phase: "final"; tx: Hex; block: number }
  /** `from` is the phase it stopped in. */
  | { phase: "failed"; reason: string; from: Phase };

/** Which phase may follow which. A move that is picked up again after a reload enters at the phase it had reached. */
const NEXT: Record<Phase, Phase[]> = {
  idle: ["signing-canton", "waiting-canton", "sending-evm", "proving", "failed"],
  "signing-canton": ["waiting-canton", "failed"],
  "waiting-canton": ["sending-evm", "failed"],
  "sending-evm": ["sending-evm", "proving", "failed"],
  proving: ["final", "failed"],
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

/** What a reload needs to pick the move up: its input, its ref, how far it got, and the transaction once there is one. */
export interface Checkpoint {
  input: MoveInput;
  ref: string;
  /** start: nothing sent. canton: the Canton command may have been signed. evm: Canton is done. sent: the transaction is in `tx`. */
  stage: "start" | "canton" | "evm" | "sent";
  tx?: Hex;
}

export interface StoreLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const KEY = "bridge-move";

/** The tab's session storage, or null where there is none (a private window, a preview). */
export function sessionStore(): StoreLike | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
}
export function saveCheckpoint(store: StoreLike | null, c: Checkpoint): void {
  try { store?.setItem(KEY, JSON.stringify(c)); } catch { /* the move still runs; it just cannot be picked up after a reload */ }
}
export function clearCheckpoint(store: StoreLike | null): void {
  try { store?.removeItem(KEY); } catch { /* nothing to clear */ }
}
export function loadCheckpoint(store: StoreLike | null): Checkpoint | null {
  try {
    const c = JSON.parse(store?.getItem(KEY) ?? "null") as Checkpoint | null;
    return c && typeof c.ref === "string" && typeof c.input?.kind === "string" && ["start", "canton", "evm", "sent"].includes(c.stage) ? c : null;
  } catch { return null; }
}
