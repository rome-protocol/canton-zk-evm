// The way back to Canton as rows: the router's events for an account's Ostia address become episodes (a coin held, paid on, or sent back), the browser's own record of a send is joined to the episode it led
// to, and each row says where it is, in steps, with the one or two things the person may do next. Everything comes from the record, the events, the bridge's stage for the deposit, the setup's waits and the
// time: no clock of its own and no wallet.
import { showUnits } from "../amounts.ts";
import type { Transfer } from "../other/record.ts";
import type { Deposit } from "../other/reads.ts";
import type { StepView } from "../other/view.ts";
import { clock } from "../other/words.ts";
import { canPay, CANNOT_PAY_CLAIM, dayTime, FEE_STILL, FROM, LEFT_OUT_CLAIM, LEFT_OUT_ON, OSTIA_SIGNS, REASON_WORDS, refundFee, short, shortParty } from "./in.ts";
import type { BackEvent, RouteAsset, RouteIn, RouteOn } from "./setup.ts";

export interface Episode {
  inbox: string; erc20: string;
  state: "held" | "arrived" | "refunded";
  /** ms: when the coin was first held, when it can go back (null for a coin that was never held), and the time of the last event. */
  heldAt: number | null; refundAt: number | null; lastAt: number;
  balance: bigint | null; amount: bigint | null; fee: bigint | null; depositCount: number | null;
  txHash: string; block: number;
}

/** The episodes of the events given newest first, newest episode first. `held` starts one (a later `held` on a running clock joins it), `forwarded` and `refunded` end it, or are one of their own when nothing was held. */
export function episodes(events: BackEvent[]): Episode[] {
  const open = new Map<string, Episode>();
  const done: Episode[] = [];
  for (const e of [...events].reverse()) {
    if (e.kind === "opened" || e.erc20 === null) continue;
    const key = `${e.inbox}:${e.erc20}`;
    const at = Date.parse(e.at);
    const had = open.get(key);
    if (e.kind === "held") {
      const refundAt = Date.parse(e.refundAt!);
      if (had) Object.assign(had, { balance: e.balance, refundAt, lastAt: at, txHash: e.txHash, block: e.block });
      else open.set(key, { inbox: e.inbox, erc20: e.erc20, state: "held", heldAt: at, refundAt, lastAt: at, balance: e.balance, amount: null, fee: null, depositCount: null, txHash: e.txHash, block: e.block });
      continue;
    }
    const ended: Episode = { ...(had ?? { inbox: e.inbox, erc20: e.erc20, heldAt: null, refundAt: null, balance: null }), state: e.kind === "forwarded" ? "arrived" : "refunded", lastAt: at, amount: e.amount, fee: e.fee, depositCount: e.depositCount, txHash: e.txHash, block: e.block };
    open.delete(key);
    done.push(ended);
  }
  return [...done, ...open.values()].sort((a, b) => b.lastAt - a.lastAt);
}

export interface InRow {
  id: string;
  /** The browser's own record of the send, when this browser made it. */
  record: Transfer | null;
  episode: Episode | null;
  inbox: string;
  party: string | null;
  /** The way back's address: the wallet's own. */
  refundAddress: string | null;
  /** ms: when the send was started, or the episode's last event. */
  at: number;
}

/** A send is joined to the first later episode of its address that no earlier send took, or, when a held coin's clock was joined by a later send, to that send's episode; an episode with no send of this browser is a row of its own. Newest first. */
export function rowsOf(records: Transfer[], events: BackEvent[]): InRow[] {
  const opened = new Map(events.filter((e) => e.kind === "opened").map((e) => [e.inbox, e]));
  const free = episodes(events).reverse();
  const rows: InRow[] = [];
  for (const r of [...records].sort((a, b) => a.at - b.at)) {
    const inbox = r.receiver ?? "";
    const i = free.findIndex((x) => x.inbox === inbox && x.lastAt >= r.at - 120_000);
    // A second send into an address whose coin is held joins the running clock (one Held for the total): it shares the first send's episode, so that it ends with it.
    const episode = i >= 0 ? free.splice(i, 1)[0]! : rows.find((x) => x.inbox === inbox && x.episode !== null && x.episode.heldAt !== null && x.episode.lastAt >= r.at - 120_000)?.episode ?? null;
    rows.push({ id: r.id, record: r, episode, inbox, party: r.party ?? opened.get(inbox)?.party ?? null, refundAddress: opened.get(inbox)?.refundAddress ?? r.account, at: r.at });
  }
  for (const x of free) rows.push({ id: `${x.inbox}:${x.erc20}:${x.block}`, record: null, episode: x, inbox: x.inbox, party: opened.get(x.inbox)?.party ?? null, refundAddress: opened.get(x.inbox)?.refundAddress ?? null, at: x.lastAt });
  return rows.sort((a, b) => b.at - a.at);
}

/** An own transaction of this browser that the row is waiting on. */
export interface KeptAct { kind: "claim" | "forward" | "refund"; hash: string; at: number }
export interface Action { kind: "claim" | "forward" | "refund" | "claim-sepolia" | "send-again"; label: string; notes: string[] }
export type InPhase = "sending" | "unsent" | "unsure" | "lost" | "waiting" | "ready" | "claiming" | "held" | "arrived" | "refunded" | "back-arrived";
export interface InView {
  phase: InPhase;
  title: string;
  word: string;
  steps: StepView[];
  /** Lines under the steps, in order; `bad` for the ones that name a problem. */
  notes: { text: string; bad: boolean }[];
  actions: Action[];
  /** Whether something waits for the person (under Claim), and whether the move is on its way. */
  claimable: boolean;
  open: boolean;
  /** An Ostia transaction of the person's own, whose Sent, Proven and Final marks the row shows. */
  marksOf: string | null;
  /** For a claim: whether it pays on to Canton in the same transaction, or only holds the coin. */
  claimPays: boolean;
}

export interface InCtx {
  setup: RouteOn;
  asset: RouteAsset;
  wallet: string;
  /** The deposit of the send (a send into Ostia) or of the send back (a way back to Ethereum Sepolia), as the bridge shows it. */
  deposit: Deposit | null;
  /** Whether the account takes withdrawals now; null when that is not known. */
  accepts: boolean | null;
  /** Whether the router would take a claim-and-pay now (the book's `checkIn` did not revert); null when not read. */
  checkIn: boolean | null;
  kept: KeptAct | null;
  /** Whether the kept transaction is in an Ostia block (it has a Sent mark): the left-out line is for one that is in none. */
  keptSeen?: boolean;
  coin: string;
  now: number;
}

const BAD = (text: string) => ({ text, bad: true });
const NOTE = (text: string) => ({ text, bad: false });

export function viewOfRow(row: InRow, c: InCtx): InView {
  const flow = c.setup.in as RouteIn;
  const a = c.asset, sym = a.symbol;
  const n = (v: bigint | null) => (v === null ? sym : `${showUnits(v, a.decimals)} ${sym}`);
  const { record: t, episode: ep } = row;
  const who = row.party === null ? "the Canton account" : `Canton account ${shortParty(row.party)}`;
  const stage = c.deposit?.stage ?? "unknown";
  const readyIn = ep !== null || stage === "ready" || stage === "claimed";
  const ofKept = (kind: KeptAct["kind"], windowSeconds: number) => (c.kept?.kind === kind && (c.keptSeen === true || c.now - c.kept.at < windowSeconds * 1000) ? c.kept : null);
  const leftOutSeconds = flow.claimOstia?.leftOutSeconds ?? 0;
  const staleKept = (kind: KeptAct["kind"]) => c.kept?.kind === kind && flow.claimOstia !== null && c.keptSeen !== true && c.now - c.kept.at >= leftOutSeconds * 1000;
  const sent = t === null || t.count !== null;
  const sentAt = c.deposit?.sentAt ?? (t ? new Date(t.at).toISOString() : null);
  const steps = (third: StepView, fourth: boolean): StepView[] => [
    { key: "sent", label: `Sent from ${FROM}`, state: sent ? "done" : "now", detail: sent ? (sentAt ? clock(sentAt) : null) : "Confirming…" },
    { key: "ready", label: "Ready on Ostia", state: readyIn ? "done" : sent ? "now" : "todo", detail: readyIn && c.deposit?.readyAt ? clock(c.deposit.readyAt) : null },
    third,
    { key: "arrived", label: "Arrived in the Canton account", state: fourth ? "done" : "todo", detail: null },
  ];
  const view = (v: Partial<Omit<InView, "claimable">> & Pick<InView, "phase" | "title" | "word" | "steps">): InView => ({ notes: [], actions: [], open: true, marksOf: null, claimPays: false, ...v, claimable: (v.actions ?? []).some((x) => x.kind !== "send-again") });

  // A send that is not yet a deposit: the wallet was not asked, was not heard from, or the send did not go through.
  if (t !== null && ep === null && (t.lost || t.send === null || t.send.tx === null || t.count === null)) {
    const amount = n(BigInt(t.amount));
    const phase: InPhase = t.lost ? "lost" : t.send === null ? "unsent" : t.send.tx === null ? "unsure" : "sending";
    const text = ({
      lost: BAD(t.lost === "failed" ? `This send did not go through on ${FROM}. Nothing was lost.` : `This send is on ${FROM}, but the page cannot tell which deposit it made, so it cannot carry on with it. Nothing is signed.`),
      unsent: NOTE(`Nothing has been sent from your wallet since this was started. Check your wallet: if it still has this request open, turn it down, then send again.`),
      unsure: BAD(`Your wallet did not say whether it sent this. Look in its activity on ${FROM}. Nothing more is sent until you have.`),
      sending: null,
    } as const)[phase];
    return view({
      phase, title: `Sending ${amount} to Canton`, word: ({ lost: "Did not go through", unsent: "Not sent", unsure: "Check your wallet", sending: "Sent" } as const)[phase], steps: steps({ key: "through", label: "Through Ostia to Canton", state: "todo", detail: null }, false),
      notes: text ? [text] : [], actions: phase === "unsent" ? [{ kind: "send-again", label: "Send to Canton", notes: [] }] : [], open: phase !== "lost",
    });
  }

  // The coin was sent back to the way back's address.
  if (ep?.state === "refunded") {
    if (ep.amount === 0n) {
      const where0 = row.refundAddress === null ? "your wallet" : short(row.refundAddress);
      return view({
        phase: "refunded", title: `Sent back. The whole balance went to the fee, so nothing goes back to ${where0}.`, word: "Done", open: false,
        steps: [{ key: "back", label: "Sent back from Ostia", state: "done", detail: clock(ep.lastAt) }],
      });
    }
    const amount = n(ep.amount), arrived = stage === "claimed";
    const readyAt = c.deposit?.readyAt ? Date.parse(c.deposit.readyAt) : null;
    const offered = stage === "ready" && readyAt !== null && c.now - readyAt > c.setup.ownClaimSeconds * 1000;
    const where = row.refundAddress === null ? `your wallet on ${FROM}` : `${short(row.refundAddress)} on ${FROM}`;
    return view({
      phase: arrived ? "back-arrived" : "refunded", title: arrived ? `Arrived back. ${amount} is in your wallet on ${FROM}.` : `Sent back. ${amount} goes back to ${where}.`, word: arrived ? "Arrived back" : stage === "ready" ? "Ready to claim" : "Sent back",
      steps: [
        { key: "back", label: "Sent back from Ostia", state: "done", detail: clock(ep.lastAt) },
        { key: "confirmed", label: `Confirmed on ${FROM}`, state: stage === "confirmed" || stage === "ready" || arrived ? "done" : "now", detail: null },
        { key: "arrived", label: "Arrived back", state: arrived ? "done" : "todo", detail: null },
      ],
      notes: offered ? [NOTE(`Ready to claim on ${FROM}. You can claim it now with your wallet.`)] : [],
      actions: offered ? [{ kind: "claim-sepolia", label: `Claim on ${FROM}`, notes: [`Your wallet switches to ${FROM}. Its fee is paid in Sepolia ETH.`] }] : [], open: !arrived,
    });
  }

  if (ep?.state === "arrived") {
    return view({ phase: "arrived", title: `Arrived. ${n(ep.amount)} is in ${who}.`, word: "Arrived", steps: steps({ key: "through", label: "Through Ostia to Canton", state: "done", detail: clock(ep.lastAt) }, true), open: false });
  }

  // Held on Ostia: Canton could not pay, or the claim only held the coin.
  if (ep?.state === "held") {
    const balance = ep.balance ?? 0n;
    const rest = balance > a.feeIn ? balance - a.feeIn : 0n;
    const pays = canPay(flow.payout, c.accepts, a.erc20, rest);
    const backAt = ep.refundAt!;
    const canGoBack = c.now >= backAt;
    const renews = flow.payout?.assets[a.erc20.toLowerCase()]?.renewsAt ?? null;
    const notes = [];
    if (pays.ok === false) notes.push(NOTE(`Canton cannot pay this account right now: ${REASON_WORDS[pays.reason]}.${pays.reason === "limit" && renews ? ` Canton can pay out again from ${clock(renews)}.` : ""}${canGoBack ? "" : ` From ${dayTime(new Date(backAt).toISOString())} you can send it back.`}`));
    else if (pays.ok === true) notes.push(NOTE("Canton can pay this account again."));
    if (canGoBack) notes.push(NOTE(`Held on Ostia since ${dayTime(new Date(ep.heldAt ?? ep.lastAt).toISOString())}. It can go back now.`));
    const moveOn = flow.claimOstia !== null && pays.ok === true && c.checkIn !== false && ep.heldAt !== null && c.now - ep.heldAt > flow.claimOstia.afterSeconds * 1000 && ofKept("forward", leftOutSeconds) === null;
    if (ofKept("forward", leftOutSeconds)) notes.push(NOTE("Sending on to Canton…"));
    else if (staleKept("forward")) notes.push(BAD(LEFT_OUT_ON));
    const actions: Action[] = [];
    if (moveOn) actions.push({ kind: "forward", label: "Send on to Canton", notes: [FEE_STILL(`${showUnits(a.feeIn, a.decimals)} ${sym}`), OSTIA_SIGNS(c.coin)] });
    if (canGoBack && ofKept("refund", leftOutSeconds) === null) actions.push({ kind: "refund", label: `Send back to ${FROM}`, notes: [`Goes back to ${row.refundAddress === null ? "your wallet" : short(row.refundAddress)}. ${FEE_STILL(`${showUnits(refundFee(a), a.decimals)} ${sym}`)}`, OSTIA_SIGNS(c.coin)] });
    const marks = ofKept("forward", leftOutSeconds)?.hash ?? ofKept("refund", leftOutSeconds)?.hash ?? null;
    return view({
      phase: "held", title: `${n(balance)} is held on Ostia for ${who}`, word: "Held on Ostia", steps: steps({ key: "through", label: "Held on Ostia", state: "now", detail: ep.heldAt === null ? null : clock(ep.heldAt) }, false), notes, actions, marksOf: marks,
    });
  }

  // The deposit is on its way into Ostia, or ready to be claimed there.
  const amount = n(BigInt(t!.amount));
  const claimWait = flow.claimOstia?.afterSeconds ?? 0;
  const readyAt = c.deposit?.readyAt ? Date.parse(c.deposit.readyAt) : null;
  const claiming = ofKept("claim", leftOutSeconds);
  const ready = stage === "ready" || stage === "claimed";
  const offered = stage === "ready" && flow.claimOstia !== null && claiming === null && readyAt !== null && c.now - readyAt > claimWait * 1000;
  const rest = BigInt(t!.amount) > a.feeIn ? BigInt(t!.amount) - a.feeIn : 0n;
  const pays = canPay(flow.payout, c.accepts, a.erc20, rest);
  const claimPays = c.checkIn === true && pays.ok === true && !staleKept("claim");
  const notes = [];
  if (offered) notes.push(NOTE(`Ready on Ostia. You can claim it now with any EVM wallet.`));
  if (claiming) notes.push(NOTE("Claiming…"));
  else if (staleKept("claim")) notes.push(BAD(LEFT_OUT_CLAIM));
  return view({
    phase: claiming ? "claiming" : ready ? "ready" : "waiting", title: `Sending ${amount} to Canton`, word: claiming ? "Claiming" : ready ? "Ready on Ostia" : "Sent",
    steps: steps({ key: "through", label: "Through Ostia to Canton", state: ready || claiming ? "now" : "todo", detail: claiming ? "Claiming…" : null }, false), notes,
    actions: offered ? [{ kind: "claim", label: "Claim on Ostia", notes: [FEE_STILL(`${showUnits(a.feeIn, a.decimals)} ${sym}`), ...(claimPays ? [] : [CANNOT_PAY_CLAIM]), OSTIA_SIGNS(c.coin)] }] : [],
    marksOf: claiming?.hash ?? null, claimPays,
  });
}
