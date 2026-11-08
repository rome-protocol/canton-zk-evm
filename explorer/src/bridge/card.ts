// What the move card says and does at each state, as plain functions: the button, the line under it, and the size of an amount's type.
import { TAKE_BACK_STAGES, type MoveState } from "./moves/state.ts";
import { moveWords } from "./words.ts";

export type ButtonAction = "connect" | "faucet" | "open" | "move" | "continue" | "none";

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
  /** What the button says for a paused or kept move: the step it carries on with ("Release on Ostia"). */
  continueLabel?: string;
  /** The Canton account is open but the move's machinery is not built yet. */
  preparing?: boolean;
  /** The chain's coin, when the wallet holds none of it and the site has a faucet: every move needs a little for fees, so the walk takes it first. */
  needCoin?: string;
  /** The faucet is being asked. */
  asking?: boolean;
}

/** How long a move takes from Move to Final, as the card says it, by the MetaMask pop-ups it needs (live: moves with one pop-up took 46 to 58 s; the approve and pay of the tROME lock took about 1 min 40 s; the tROME lock, with three, took 2 min 13 s). The one place for these figures. */
export const WAIT_WORDS = { short: "About 1 min", long: "About 2 min" } as const;
export const waitFor = (popups: number): string => (popups >= 2 ? WAIT_WORDS.long : WAIT_WORDS.short);

/** What a move that is running says while it waits. Null when no move is running. */
export function progressWords(s: MoveState, symbol: string): string | null {
  switch (s.phase) {
    case "signing-canton": return "Signing on Canton…";
    case "waiting-canton": return "Waiting for Canton…";
    case "sending-evm":
      return s.step === "prepare" ? "Getting ready…" : s.step === "wrap" ? `Wrap ${symbol} in your wallet, then wait for it to be final…` : s.step === "approve" ? `Approve ${symbol} in your wallet, then wait for it to be final…` : "Confirm in your wallet…";
    case "proving": return "Sent. Waiting for the block to be final…";
    default: return null;
  }
}

/** The short line the bar and the Activity rows say while a move waits, with no token named. Null when no move is running. */
export function waitWords(s: MoveState): string | null {
  switch (s.phase) {
    case "signing-canton": return "Signing on Canton…";
    case "waiting-canton": return "Waiting for Canton…";
    case "sending-evm": return s.step === "prepare" ? "Getting ready…" : "Confirm in your wallet…";
    case "proving": return "Sent. Waiting for the block to be final…";
    default: return null;
  }
}

/** The button of the card: its words, what pressing it does, and whether it can be pressed. */
export function buttonOf(i: ButtonInput): { label: string; action: ButtonAction; disabled: boolean } {
  const running = progressWords(i.move, i.symbol);
  if (running !== null) return { label: running, action: "none", disabled: true };
  if (i.move.phase === "paused" || (i.move.phase === "failed" && i.move.kept)) return { label: i.continueLabel ?? "Continue", action: "continue", disabled: false };
  // The wallet and the Canton account come first: they do not need the bridge's tokens.
  if (!i.connected) return { label: "Connect MetaMask", action: "connect", disabled: false };
  if (i.needCoin) return { label: i.asking ? "Asking the faucet…" : `Get test ${i.needCoin}`, action: "faucet", disabled: !!i.asking };
  if (!i.accountReady) return { label: "Open my Canton account", action: "open", disabled: false };
  if (i.config === "loading") return { label: "Looking up the bridge…", action: "none", disabled: true };
  if (i.config === "failed") return { label: "Not available here", action: "none", disabled: true };
  if (i.preparing) return { label: "Getting ready…", action: "none", disabled: true };
  if (i.amount !== "ok") return { label: "Enter an amount", action: "none", disabled: true };
  if (i.enough === false) return { label: `Not enough ${i.symbol}`, action: "none", disabled: true };
  return { label: `Move to ${i.to}`, action: "move", disabled: false };
}

/** The words of the action that takes a deposit's tokens back on Canton. */
export const TAKE_BACK_LABEL = "Take my tokens back on Canton";
/**
 * Whether the card offers to take a kept deposit's tokens back: a deposit with a Canton step begun (its claim may be asked for or sent but is not final), once the time to
 * settle it has passed (`due`, which the move says: it also knows the gateway shows no claim for it).
 */
export const offersTakeBack = (record: { input: { kind: string }; stage: string } | undefined, due: boolean): boolean =>
  due && record !== undefined && record.input.kind === "deposit" && (TAKE_BACK_STAGES as readonly string[]).includes(record.stage);

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
