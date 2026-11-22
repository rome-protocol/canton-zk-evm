// What a transfer looks like on the page, as plain data: its steps, its words, and the one thing the person may do next. No clock and no wallet: everything comes from the record, what the bridge showed
// of its deposit at the last look, and the route's settings.
import { showUnits } from "../amounts.ts";
import type { Transfer } from "./record.ts";
import type { Deposit } from "./reads.ts";
import type { OpenRow, OstiaChain } from "./setup.ts";
import { sides } from "./transfer.ts";
import { clock, elapsedWords, feeCoin } from "./words.ts";

export type Phase = "unsent" | "unsure-send" | "sending" | "lost" | "waiting" | "ready" | "unsure-claim" | "claiming" | "arrived";
export interface StepView { key: string; label: string; state: "done" | "now" | "todo"; detail: string | null }
export interface View {
  phase: Phase;
  /** The heading: what is being sent, or that it arrived. */
  title: string;
  /** The short word of a list: Sent, Confirmed, Ready to claim, Arrived. */
  word: string;
  steps: StepView[];
  /** What the person may press: the send again, or the claim. */
  action: { kind: "send" | "claim"; label: string; note: string | null } | null;
  /** A line under the steps, and whether it is a problem. */
  note: { text: string; bad: boolean } | null;
  /** "4 min of about 16", only where a measured time is set. */
  progress: string | null;
  /** Whether this counts under Claim. */
  claimable: boolean;
  /** Whether it is on its way (not arrived, not lost). */
  open: boolean;
  /** The Ostia transaction whose marks the page shows (Sent, Proven, Final): the send going out, the claim coming in. */
  marksOf: "send" | "claim" | null;
}
export interface Names { ostia: OstiaChain; other: OpenRow; ostiaCoin: string }

export function viewOf(t: Transfer, deposit: Deposit | null, n: Names, nowMs: number): View {
  const s = sides({ ostia: n.ostia, other: n.other, topic0: "" }, t.dir);
  const amount = showUnits(BigInt(t.amount), t.decimals);
  const wrapped = t.native ? `W${t.symbol}` : t.symbol;
  const stage = deposit?.stage ?? "unknown";
  const paid = stage === "claimed" || t.done !== undefined;
  const readyNow = stage === "ready" || paid;
  const confirmed = stage === "confirmed" || readyNow;
  const forYou = t.dir === "in" ? n.other.claimedForYou.ostia : n.other.claimedForYou.remote;

  const phase: Phase =
    paid ? "arrived"
    : t.lost ? "lost"
    : t.send === null ? "unsent"
    : t.send.tx === null ? "unsure-send"
    : t.count === null ? "sending"
    : t.claim && t.claim.tx === null ? "unsure-claim"
    : t.claim ? "claiming"
    : stage === "ready" ? "ready"
    : "waiting";

  const sent = t.count !== null;
  const when = (iso: string | null | undefined) => (iso ? clock(iso) : null);
  const sendNow = !sent && phase !== "lost";
  const send: StepView = {
    key: "send", label: `Sent on ${s.sendName}`, state: sent ? "done" : sendNow ? "now" : "todo",
    detail: sent ? when(deposit?.sentAt) ?? clock(t.at) : phase === "sending" ? "Confirming…" : phase === "unsure-send" ? "Check your wallet" : phase === "unsent" ? "Not sent yet" : null,
  };
  const steps: StepView[] = t.dir === "in"
    ? [
        send,
        { key: "ready", label: `Ready to claim on ${s.claimName}`, state: readyNow ? "done" : sent ? "now" : "todo", detail: readyNow ? when(deposit?.readyAt) : sent ? "Confirming…" : null },
        { key: "claim", label: `Claim on ${s.claimName}`, state: paid ? "done" : phase === "ready" || phase === "claiming" || phase === "unsure-claim" ? "now" : "todo", detail: phase === "ready" ? (forYou ? null : "Your move") : phase === "claiming" ? "Claiming…" : phase === "unsure-claim" ? "Check your wallet" : null },
        { key: "arrived", label: "Arrived", state: paid ? "done" : "todo", detail: paid && t.done !== undefined ? clock(t.done) : null },
      ]
    : [
        send,
        { key: "confirmed", label: `Confirmed on ${s.claimName}`, state: confirmed ? "done" : sent ? "now" : "todo", detail: confirmed ? when(deposit?.confirmedAt) : sent ? "Confirming…" : null },
        { key: "ready", label: "Ready to claim", state: readyNow ? "done" : confirmed ? "now" : "todo", detail: readyNow ? when(deposit?.readyAt) : null },
        { key: "arrived", label: "Arrived", state: paid ? "done" : phase === "claiming" || phase === "unsure-claim" ? "now" : "todo", detail: paid && t.done !== undefined ? clock(t.done) : phase === "claiming" ? "Claiming…" : phase === "unsure-claim" ? "Check your wallet" : null },
      ];

  const title = paid
    ? t.dir === "in" ? `Arrived. ${amount} ${wrapped} is in your wallet.` : `Arrived. ${amount} ${t.symbol} is in your wallet on ${s.claimName}.`
    : `Sending ${amount} ${t.symbol} to ${s.claimName}`;
  const word = ({ arrived: "Arrived", lost: "Did not go through", unsent: "Not sent", "unsure-send": "Check your wallet", sending: "Sent", waiting: stage === "confirmed" && t.dir === "out" ? "Confirmed" : "Sent", ready: "Ready to claim", "unsure-claim": "Check your wallet", claiming: "Claiming" } as const)[phase];

  const claimNote = `Your wallet switches to ${s.claimName}. Its fee is paid in ${feeCoin(n.other, n.ostiaCoin, t.dir === "in" ? "ostia" : "other")}.`;
  const action: View["action"] =
    phase === "unsent" ? { kind: "send", label: `Send to ${s.claimName}`, note: null }
    : phase === "ready" && !forYou ? { kind: "claim", label: `Claim on ${s.claimName}`, note: claimNote }
    : null;
  const note: View["note"] =
    phase === "unsent" ? { text: "This transfer was started, but your wallet was never asked. Nothing was sent.", bad: false }
    : phase === "unsure-send" ? { text: `Your wallet did not say whether it sent this. Look in its activity on ${s.sendName}. Nothing more is sent until you have.`, bad: true }
    : phase === "unsure-claim" ? { text: `Your wallet did not say whether it sent the claim. Look in its activity on ${s.claimName}. Nothing more is sent until you have.`, bad: true }
    : phase === "lost" ? { text: t.lost === "failed" ? `This send did not go through on ${s.sendName}. Nothing was lost.` : `This send is on ${s.sendName}, but the page cannot tell which deposit it made, so it cannot carry on with it. Nothing is signed.`, bad: true }
    : phase === "ready" && t.claimFailed ? { text: "The claim did not go through. Nothing was lost. Claim again.", bad: true }
    : phase === "ready" && forYou ? { text: "It is on its way to your wallet.", bad: false }
    : null;

  const open = phase !== "arrived" && phase !== "lost";
  const range = n.other.times[t.dir];
  const progress = phase === "sending" || phase === "waiting" ? elapsedWords(range, (nowMs - t.at) / 1000) : null;
  return {
    phase, title, word, steps, action, note, progress, claimable: phase === "ready" && !forYou, open,
    marksOf: t.dir === "out" && t.send?.tx && (phase === "sending" || phase === "waiting" || phase === "ready") ? "send" : t.dir === "in" && t.claim?.tx && phase === "claiming" ? "claim" : null,
  };
}
