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

/**
 * The marks of the transaction `hash`, from the explorer's own answer, looked up again every few seconds until it is final. A mark that was reached stays. `seed` is what is already known
 * (a finished move is final in its block) so nothing flickers before the first answer. `read` is the explorer's answer for a transaction.
 */
export function useMarks(hash: Hex | null, seed: Marks | null = null, read: (hash: Hex) => Promise<ApiTx | null> = explorerTx, everyMs = 3000): Marks {
  const start = seed ?? { ...NO_MARKS, sent: hash !== null };
  const [marks, setMarks] = useState<Marks>(start);
  const known = useRef(seed);
  known.current = seed;
  useEffect(() => {
    const base = known.current ?? { ...NO_MARKS, sent: hash !== null };
    setMarks(base);
    if (hash === null) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    let now = base;
    const look = async () => {
      try {
        now = merge(now, marksOf(await read(hash), true));
        if (live) setMarks(now);
      } catch { /* the explorer did not answer: the marks stay as they were */ }
      if (live && !now.final) timer = setTimeout(look, everyMs);
    };
    void look();
    return () => { live = false; clearTimeout(timer); };
  }, [hash]);   // eslint-disable-line react-hooks/exhaustive-deps
  return hash === null ? seed ?? NO_MARKS : marks;
}
