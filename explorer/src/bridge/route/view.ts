// What one move out looks like on the page, as plain data: its four steps, its words and the one thing the person may do next. No clock and no wallet: everything comes from the move (the router's event or
// the open request), the bridge's stage for its deposit, the claim the browser has already asked for, and the setup's waits.
import { showUnits } from "../amounts.ts";
import type { Deposit } from "../other/reads.ts";
import type { StepView } from "../other/view.ts";
import { clock, elapsedWords } from "../other/words.ts";
import type { Move, RouteAsset, RouteOn } from "./setup.ts";
import { CLAIM_NOTE, DEST, lapsedWords, notTakenWords, READY_NOTE } from "./words.ts";

export type MovePhase = "sent" | "not-taken" | "lapsed" | "through" | "confirmed" | "ready" | "claiming" | "arrived";
export interface MoveView {
  phase: MovePhase;
  title: string;
  word: string;
  steps: StepView[];
  /** A line under the steps: what the move's state is in words. */
  note: string | null;
  progress: string | null;
  /** The person's own claim: offered once the move is ready and the set time has passed with no claim. */
  action: { label: string; note: string } | null;
  /** Whether it counts under Claim, and whether it is on its way (not arrived, not lapsed). */
  claimable: boolean;
  open: boolean;
  /** Ostia's transaction whose Sent, Proven and Final marks the page shows, once Ostia has taken the move. */
  marksOf: string | null;
}

/** `claiming`: the claim was already asked of the wallet from this browser (and is not yet seen as paid). */
export function viewOfMove(m: Move, deposit: Deposit | null, setup: RouteOn, asset: RouteAsset | null, claiming: boolean, nowMs: number): MoveView {
  const symbol = asset?.symbol ?? "CC", decimals = asset?.decimals ?? 10;
  const money = (v: bigint | null) => (v === null ? symbol : `${showUnits(v, decimals)} ${symbol}`);
  const stage = deposit?.stage ?? "unknown";
  const taken = m.state === "taken";
  const paid = taken && stage === "claimed";
  const ready = taken && (stage === "ready" || paid);
  const at = m.at === null ? null : Date.parse(m.at);
  const lapsed = !taken && m.settleBefore !== null && nowMs > Date.parse(m.settleBefore);
  const notTaken = !taken && !lapsed && at !== null && nowMs - at > setup.notTakenSeconds * 1000;
  const readyAt = deposit?.readyAt ? Date.parse(deposit.readyAt) : null;
  const offered = ready && !paid && !claiming && readyAt !== null && nowMs - readyAt > setup.ownClaimSeconds * 1000;
  const phase: MovePhase = paid ? "arrived" : lapsed ? "lapsed" : notTaken ? "not-taken" : !taken ? "sent" : claiming && ready ? "claiming" : ready ? (offered ? "ready" : "confirmed") : "through";

  const steps: StepView[] = [
    { key: "sent", label: "Sent from Canton", state: "done", detail: !taken && m.at ? clock(m.at) : null },
    { key: "through", label: "Through Ostia", state: taken ? "done" : lapsed ? "todo" : "now", detail: m.block === null ? null : `block ${m.block.toLocaleString("en-US")}` },
    { key: "confirmed", label: `Confirmed on ${DEST}`, state: ready ? "done" : taken ? "now" : "todo", detail: ready && deposit?.readyAt ? clock(deposit.readyAt) : null },
    { key: "arrived", label: "Arrived", state: paid ? "done" : claiming && ready ? "now" : "todo", detail: claiming && ready && !paid ? "Claiming…" : null },
  ];
  const amount = money(m.amount);
  const title = paid ? `Arrived. ${money(m.send)} is in your wallet on ${DEST}.` : `Sending ${amount} to ${DEST}`;
  const note = phase === "not-taken" && m.settleBefore ? notTakenWords(clock(m.settleBefore), amount) : phase === "lapsed" ? lapsedWords(amount) : phase === "ready" ? READY_NOTE : null;
  const word = ({ sent: "Sent from Canton", "not-taken": "Not taken yet", lapsed: "Not moved", through: "Through Ostia", confirmed: `Confirmed on ${DEST}`, ready: "Ready to claim", claiming: "Claiming", arrived: "Arrived" } as const)[phase];
  const open = phase !== "arrived" && phase !== "lapsed";
  return {
    phase, title, word, steps, note, open, claimable: phase === "ready", action: phase === "ready" ? { label: `Claim on ${DEST}`, note: CLAIM_NOTE } : null,
    progress: at !== null && open && phase !== "claiming" && !ready ? elapsedWords(setup.time, (nowMs - at) / 1000) : null,
    marksOf: taken && (phase === "through" || phase === "confirmed" || phase === "ready" || phase === "claiming") ? m.txHash : null,
  };
}
