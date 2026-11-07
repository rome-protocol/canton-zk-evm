// What the in-flight bar and the Activity list watch: the move library's state, and the explorer's answer for a move's transaction.
import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import type { ApiTx } from "../api.ts";
import { marksOf, merge, NO_MARKS, type Marks } from "../bridge/marks.ts";
import { explorerTx } from "../bridge/moves/moves.ts";
import type { MoveState } from "../bridge/moves/state.ts";
import type { Session } from "../bridge/session.ts";

/** The move's state, kept up to date. */
export function useMoveState(session: Session | null): MoveState {
  const [state, setState] = useState<MoveState>({ phase: "idle" });
  useEffect(() => {
    if (!session) { setState({ phase: "idle" }); return; }
    setState(session.move.state);
    return session.move.subscribe(setState);
  }, [session]);
  return state;
}

type Read = (hash: Hex) => Promise<ApiTx | null>;
interface Poll { last: ApiTx | null; asked: boolean; over: boolean; listeners: Set<(tx: ApiTx | null) => void>; timer?: ReturnType<typeof setTimeout>; stopped: boolean }
/** One look per transaction, whoever is watching it (the bar under the card, the Activity list): the polls are kept per explorer reader and hash. */
const polls = new WeakMap<Read, Map<Hex, Poll>>();
/** A look that has nothing more to find: the transaction is final (or failed in a final block), or it was replaced or dropped. */
const ended = (tx: ApiTx | null) => tx !== null && (tx.status === "final" || tx.status === "replaced" || tx.status === "dropped");

/** Watches `hash`: `on` gets each answer (null while the explorer has not seen the transaction). Looks every `everyMs` until the answer cannot change; stops when the last watcher leaves. Returns the way out. */
function watch(hash: Hex, read: Read, everyMs: number, on: (tx: ApiTx | null) => void): () => void {
  let byHash = polls.get(read);
  if (!byHash) polls.set(read, byHash = new Map());
  let poll = byHash.get(hash);
  if (!poll) {
    const mine: Poll = poll = { last: null, asked: false, over: false, listeners: new Set(), stopped: false };
    byHash.set(hash, mine);
    const look = async () => {
      try {
        mine.last = await read(hash);
        mine.asked = true;
        mine.over = ended(mine.last);
        mine.listeners.forEach((f) => f(mine.last));
      } catch { /* the explorer did not answer: what was seen stays */ }
      if (!mine.stopped && !mine.over) mine.timer = setTimeout(look, everyMs);
    };
    void look();
  } else if (poll.asked) on(poll.last);
  poll.listeners.add(on);
  const mine = poll;
  return () => {
    mine.listeners.delete(on);
    if (mine.listeners.size === 0) { mine.stopped = true; clearTimeout(mine.timer); if (byHash!.get(hash) === mine) byHash!.delete(hash); }
  };
}

/**
 * The marks of the transaction `hash`, from the explorer's own answer, looked up again every few seconds until it is final, replaced or dropped (a transaction that is replaced or dropped is not
 * looked at again). A mark that was reached stays. `seed` is what is already known (a finished move is final in its block) so nothing flickers before the first answer. `read` is the explorer's
 * answer for a transaction. Two watchers of one hash share one poll.
 */
export function useMarks(hash: Hex | null, seed: Marks | null = null, read: Read = explorerTx, everyMs = 3000): Marks {
  const start = seed ?? { ...NO_MARKS, sent: hash !== null };
  const [marks, setMarks] = useState<Marks>(start);
  const known = useRef(seed);
  known.current = seed;
  useEffect(() => {
    const base = known.current ?? { ...NO_MARKS, sent: hash !== null };
    setMarks(base);
    if (hash === null) return;
    let now = base;
    return watch(hash, read, everyMs, (tx) => { now = merge(now, marksOf(tx, true)); setMarks(now); });
  }, [hash]);   // eslint-disable-line react-hooks/exhaustive-deps
  return hash === null ? seed ?? NO_MARKS : marks;
}
