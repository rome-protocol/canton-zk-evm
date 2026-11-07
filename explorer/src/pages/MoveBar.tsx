import { useEffect, useState } from "react";
import type { Hex } from "viem";
import type { ApiTx } from "../api.ts";
import { entryOf, whatMoved, type Entry } from "../bridge/activity.ts";
import { waitWords } from "../bridge/card.ts";
import { FINAL_MARKS, merge } from "../bridge/marks.ts";
import { explorerTx } from "../bridge/moves/moves.ts";
import type { Session } from "../bridge/session.ts";
import type { Pair } from "../bridge/tokens.ts";
import { MoveMarks } from "./MoveMarks.tsx";
import { useMarks, useMoveState } from "./moveWatch.ts";

/**
 * The slim bar under the card, only while a move is on its way: what is moving, the three marks (Sent, Proven, Final) and the block once the transaction is in one. The marks come from the
 * explorer's own answer for the move's transaction. When the move ends the bar goes; the card says it is final.
 */
export function MoveBar({ session, pairs, chainName, read = explorerTx, pollMs }: { session: Session | null; pairs: Pair[]; chainName: string; read?: (hash: Hex) => Promise<ApiTx | null>; pollMs?: number }) {
  const state = useMoveState(session);
  const [entry, setEntry] = useState<Entry | null>(null);
  // The record the move keeps says what is moving; it is looked at as the state changes, and the last one seen stays once the move is final and its record is gone.
  useEffect(() => {
    if (!session) { setEntry(null); return; }
    const look = () => { const k = session.kept()[0]; if (k) setEntry(entryOf(k)); };
    look();
    return session.move.subscribe(look);
  }, [session]);
  const tx = state.phase === "proving" || state.phase === "final" ? state.tx : entry?.tx ?? null;
  const seen = useMarks(tx, null, read, pollMs);
  const on = ["signing-canton", "waiting-canton", "sending-evm", "proving"].includes(state.phase);
  if (!on || !entry) return null;
  const marks = state.phase === "final" ? merge(seen, FINAL_MARKS(state.block)) : seen;
  const words = tx !== null ? null : waitWords(state);
  return (
    <section className="flight card" aria-label="Move on its way">
      <span className="fl-what">{whatMoved(entry, pairs, chainName)}</span>
      <MoveMarks marks={marks} />
      {words && <span className="small muted">{words}</span>}
    </section>
  );
}
