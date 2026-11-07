// What the move card says and does at each state, as plain functions: the button, the line under it, and the size of an amount's type.
import type { MoveState } from "./moves/state.ts";
import { moveWords } from "./words.ts";

export type ButtonAction = "connect" | "open" | "move" | "continue" | "none";

export interface ButtonInput {
  connected: boolean;
  /** The Canton account is open. */
  accountReady: boolean;
  config: "loading" | "ready" | "failed";
  /** "empty": nothing typed; "bad": text the bridge will not take; "ok". */
  amount: "empty" | "bad" | "ok";
  /** Whether the From balance covers the amount; null while it is not known. */
  enough: boolean | null;
  symbol: string;
  /** The chain the move ends on: "Ostia" or "Canton". */
  to: string;
  move: MoveState;
  /** A failed move whose record is kept can be continued. */
  kept?: boolean;
}

/** What a move that is running says while it waits. Null when no move is running. */
export function progressWords(s: MoveState, symbol: string): string | null {
  switch (s.phase) {
    case "signing-canton": return "Signing on Canton…";
    case "waiting-canton": return "Waiting for Canton…";
    case "sending-evm":
      return s.step === "prepare" ? "Getting ready…" : s.step === "wrap" ? `Confirm wrapping ${symbol} in your wallet…` : s.step === "approve" ? `Confirm approving ${symbol} in your wallet…` : "Confirm in your wallet…";
    case "proving": return "Sent. Waiting for the block to be final…";
    default: return null;
  }
}

/** The button of the card: its words, what pressing it does, and whether it can be pressed. */
export function buttonOf(i: ButtonInput): { label: string; action: ButtonAction; disabled: boolean } {
  const running = progressWords(i.move, i.symbol);
  if (running !== null) return { label: running, action: "none", disabled: true };
  if (i.move.phase === "paused" || (i.move.phase === "failed" && i.move.kept)) return { label: "Continue", action: "continue", disabled: false };
  // The wallet and the Canton account come first: they do not need the bridge's tokens.
  if (!i.connected) return { label: "Connect MetaMask", action: "connect", disabled: false };
  if (!i.accountReady) return { label: "Open my Canton account", action: "open", disabled: false };
  if (i.config === "loading") return { label: "Looking up the bridge…", action: "none", disabled: true };
  if (i.config === "failed") return { label: "Not available here", action: "none", disabled: true };
  if (i.amount !== "ok") return { label: "Enter an amount", action: "none", disabled: true };
  if (i.enough === false) return { label: `Not enough ${i.symbol}`, action: "none", disabled: true };
  return { label: `Move to ${i.to}`, action: "move", disabled: false };
}

/** The line under the button: what the move is doing or has done, and whether it is an error. */
export function noteOf(s: MoveState): { text: string; bad: boolean } | null {
  if (s.phase === "paused") return { text: moveWords(s.note), bad: false };
  if (s.phase === "failed") return { text: moveWords(s.reason), bad: true };
  return null;
}

/** The size class of an amount's type: it shrinks as the amount grows, so a long amount stays whole (the field then wraps it, and never cuts it). */
export function amountSize(text: string): "xl" | "l" | "m" | "s" {
  const n = text.length;
  return n <= 9 ? "xl" : n <= 14 ? "l" : n <= 22 ? "m" : "s";
}
