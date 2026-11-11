import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Address, Hex } from "viem";
import type { ApiTx } from "../api.ts";
import { continueWords, openOnCanton, otherMoves, recordOf, rememberUpdate, rowsOf, seedOf, standing, whatMoved, type Entry } from "../bridge/activity.ts";
import { NoLongerOpen } from "../bridge/adopt.ts";
import { noteOf, waitWords } from "../bridge/card.ts";
import type { OpenState } from "../bridge/canton/accounts.ts";
import type { MoveState, StoreLike } from "../bridge/moves/state.ts";
import type { Session } from "../bridge/session.ts";
import type { Pair } from "../bridge/tokens.ts";
import { moveWords } from "../bridge/words.ts";
import { dateTime } from "../format.ts";
import { MoveMarks } from "./MoveMarks.tsx";
import { useMarks, useMoveState } from "./moveWatch.ts";

import { StillStuck } from "../components/Help.tsx";export interface ActivityProps {
  /** The wallet's account, or null while the wallet is not connected. */
  account: string | null;
  /** The move's machinery, once the Canton account is open. Without it the list is shown, and a move cannot be continued. */
  session: Session | null;
  /** Where the moves are kept (the browser's own storage, unless a test says otherwise). */
  store: StoreLike | null;
  pairs: Pair[];
  chainName: string;
  onConnect(): void;
  onOpenAccount(): void;
  /** What the wallet or the page says of connecting, in plain words. */
  connectNote?: string | null;
  /** Puts the wallet on Ostia; says why not, in words, when it cannot. */
  ensureChain?(): Promise<string | null>;
  read?: (hash: Hex) => Promise<ApiTx | null>;
  /** How often an unfinished move's transaction is looked up again (ms). */
  pollMs?: number;
}

const RUNNING = ["signing-canton", "waiting-canton", "sending-evm", "proving"];

function Row({ e, props, state, live, onCanton, busy, onContinue, canContinue = true, spent = false, onRemove }: {
  e: Entry; props: ActivityProps; state: MoveState; live: boolean; onCanton: boolean; busy: boolean; onContinue(e: Entry): void; canContinue?: boolean;
  spent?: boolean;
  /** Removes the open request of a move started in another browser (a redeem, or an extra request of a deposit that is finished). */
  onRemove?: (e: Entry) => void;
}) {
  // A finished move whose block and update are known is not looked up again.
  const known = e.done && e.block !== null && !!e.updateId;
  const marks = useMarks(known ? null : e.tx, seedOf(e), props.read, props.pollMs);
  useEffect(() => { if (e.done && !e.updateId && marks.updateId) rememberUpdate(props.store, e.ref, marks.updateId); }, [marks.updateId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const note = live ? noteOf(state) : null;
  const running = live && RUNNING.includes(state.phase);
  const where = running ? waitWords(state) ?? "" : note ? note.text : e.done ? "" : e.elsewhere ? `Started in another browser. ${!spent ? standing(e, props.chainName, onCanton) : e.kind === "deposit" ? "This deposit is finished already, so this extra request cannot settle. Remove it." : "Its tokens were spent by another move, so it cannot be released. Remove it."}` : standing(e, props.chainName, onCanton);
  const mine = props.session !== null;
  return (
    <li className="act-row">
      <div className="act-top"><b>{whatMoved(e, props.pairs, props.chainName)}</b>{e.at > 0 && <span className="muted small">{dateTime(e.at)}</span>}</div>
      <div className="act-marks"><MoveMarks marks={marks} block={false} /></div>
      {where && <p className={`small ${note?.bad ? "bad" : "muted"}`}>{where}</p>}
      {(marks.block !== null || marks.updateId !== null) && (
        <p className="act-links small">
          {marks.block !== null && <Link to={`/block/${marks.block}`}>{props.chainName} block {marks.block}</Link>}
          {marks.updateId !== null && <Link to={`/canton/${marks.updateId}`}>Canton update</Link>}
        </p>
      )}
      {!e.done && !running && canContinue && (mine
        ? <button type="button" className="btn ghost" disabled={busy} onClick={() => onContinue(e)}>{continueWords(e, props.chainName, onCanton)}</button>
        : <button type="button" className="btn ghost" onClick={props.onOpenAccount}>Open my Canton account to continue</button>)}
      {!e.done && !running && mine && e.elsewhere && onRemove && <button type="button" className="btn ghost" disabled={busy} onClick={() => onRemove(e)}>Remove</button>}
    </li>
  );
}

/** One row per move of the wallet's account: when, what moved, how far it got, and links to its block on Ostia and its update on Canton. A move that is not finished carries on from its row. */
export function Activity(props: ActivityProps) {
  const { account, session, store } = props;
  const state = useMoveState(session);
  const [stamp, setStamp] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenState | null>(null);
  const [held, setHeld] = useState<Set<string> | null>(null);   // the ids of the account's holdings on Canton (null until read, or where they cannot be read)
  // The list is read again when the move changes state: a move that ends moves from the unfinished rows to the finished ones.
  const rows = useMemo(() => (account ? rowsOf(store, account) : []), [store, account, state.phase, stamp]);   // eslint-disable-line react-hooks/exhaustive-deps
  // What Canton says is open for the account: one look when the list is shown (and one after a move is carried on), so a move whose record is behind Canton is shown as it stands, and a move
  // that was started in another browser is listed too.
  useEffect(() => { setOpen(null); setHeld(null); }, [session]);
  useEffect(() => {
    if (!session) return;
    let live = true;
    session.open().then((o) => { if (live) setOpen(o); }, () => {});
    session.holdingIds().then((h) => { if (live) setHeld(h); }, () => {});
    return () => { live = false; };
  }, [session, stamp]);
  // A move that reaches its end while the list is shown (started on the Move tab, or carried on from a row) has archived its request on Canton: what Canton says is open is read again,
  // so the request is not listed as a dead duplicate of the move that was just finished.
  const lastPhase = useRef(state.phase);
  useEffect(() => {
    if (state.phase === "final" && lastPhase.current !== "final") setStamp((n) => n + 1);
    lastPhase.current = state.phase;
  }, [state.phase]);
  const others = useMemo(() => (open && account && session ? otherMoves(open, rows, { account: account as Address, party: session.party, pairs: props.pairs, held }) : []), [open, held, rows, account, session, props.pairs]);
  const liveRef = session ? recordOf(session.kept(), session.move.current)?.ref : undefined;

  const onContinue = useCallback(async (e: Entry) => {
    if (!session || busy) return;
    setBusy(true); setProblem(null);
    try {
      // A move started in another browser is kept here first (nothing is signed or sent), then goes on like any kept move.
      const other = others.find((o) => o.entry.ref === e.ref && e.elsewhere);
      if (other && (await session.adopt(other.kind, other.request)) === null) { setProblem("This move cannot be finished here. Open the bridge in the browser that started it."); return; }
      // A move already picked up here goes on at once; one that is not is picked up first (that only reads and waits, and never asks the wallet), then goes on.
      // The wallet goes to Ostia before the move goes on (resume only reads; proceed asks the wallet).
      const paused = (s: MoveState) => s.phase === "paused" || (s.phase === "failed" && s.kept);
      const now = e.ref === liveRef && paused(session.move.state) ? session.move.state : await session.move.resume(e.ref);
      let end = now;
      if (paused(now) && session.move.current === e.ref) {
        const why = await props.ensureChain?.();
        if (why) { setProblem(why); return; }
        end = await session.move.proceed();
      }
      if (end.phase === "failed" && !end.kept) setProblem(moveWords(end.reason));   // a failed move that is kept says it in its own row
    } catch (x) { setProblem(x instanceof NoLongerOpen ? x.message : moveWords(x instanceof Error ? x.message : null)); }
    finally { setBusy(false); setStamp((n) => n + 1); }
  }, [session, busy, liveRef, props.ensureChain, others]);

  const onRemove = useCallback(async (e: Entry) => {
    if (!session || busy) return;
    setBusy(true); setProblem(null);
    try { await (e.kind === "deposit" ? session.removeDeposit(e.ref) : session.removeRedeem(e.ref)); } catch (x) { setProblem(moveWords(x instanceof Error ? x.message : null)); }
    finally { setBusy(false); setStamp((n) => n + 1); }
  }, [session, busy]);

  if (!account) return <section className="card" aria-label="Activity"><p className="muted">Connect your wallet to see your moves.</p><button type="button" className="btn go" onClick={props.onConnect}>Connect wallet</button>{props.connectNote && <p className="small bad" role="alert">{props.connectNote}</p>}</section>;
  const going = RUNNING.includes(state.phase);
  return (
    <section className="card activity" aria-label="Activity">
      {rows.length === 0 && others.length === 0 ? <p className="muted">No moves yet. A move you make here is listed with how far it has got.</p> : (
        <ul className="act-list">
          {others.map((o) => <Row key={`other:${o.entry.ref}`} e={o.entry} props={props} state={state} live={false} onCanton busy={busy || going} canContinue={o.canContinue} spent={o.spent} onContinue={onContinue} onRemove={o.kind === "redeem" || o.spent ? onRemove : undefined} />)}
          {rows.map((e) => <Row key={e.ref} e={e} props={props} state={state} live={e.ref === liveRef} onCanton={open !== null && openOnCanton(e, open)} busy={busy || (going && e.ref !== liveRef)} onContinue={onContinue} />)}
        </ul>
      )}
      {problem && <><p className="small bad" role="alert">{problem}</p><StillStuck /></>}
    </section>
  );
}
