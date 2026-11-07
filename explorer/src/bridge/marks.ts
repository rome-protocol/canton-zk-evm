// The three marks of a move on Ostia (Sent, Proven, Final), read from the explorer's own answer for the move's transaction: its state, its proof and its block. No timer decides a mark.
import type { Hex } from "viem";
import { ApiError, bridgeReads, type ApiTx } from "../api.ts";
import { timeoutSignal } from "../timeout.ts";

export interface Marks {
  /** The transaction was sent: the wallet gave its hash, or the explorer has it. */
  sent: boolean;
  /** Its block has been proven. */
  proven: boolean;
  /** Its block is final on Canton, and the transaction went through. */
  final: boolean;
  /** The block the transaction is in, once it is in one. */
  block: number | null;
  /** The Canton update that holds that block, once Canton has it. */
  updateId: string | null;
}

export const NO_MARKS: Marks = { sent: false, proven: false, final: false, block: null, updateId: null };
export const FINAL_MARKS = (block: number | null, updateId: string | null = null): Marks => ({ sent: true, proven: true, final: true, block, updateId });

export const MARK_NAMES = ["Sent", "Proven", "Final"] as const;

/** The marks of a transaction as the explorer shows it. `sent` says the transaction has a hash even when the explorer has not seen it yet. */
export function marksOf(tx: ApiTx | null, sent: boolean): Marks {
  if (tx === null) return { ...NO_MARKS, sent };
  const lost = tx.status === "replaced" || tx.status === "dropped";
  const final = tx.status === "final" && tx.success !== false;
  // A block is proven once its proof has ended; a block Canton holds (final, or final and not yet indexed) is proven too.
  const proven = !lost && (tx.status === "final" || tx.status === "unindexed" || (tx.lifecycle?.proofEndedAt ?? null) !== null);
  const updateId = tx.block?.updateId ?? tx.legs.find((l) => l.updateId)?.updateId ?? null;
  return { sent: true, proven, final, block: lost ? null : tx.block?.number ?? null, updateId: lost ? null : updateId };
}

/** What a later look adds to what was seen: a mark that was reached stays reached. */
export const merge = (a: Marks, b: Marks): Marks => ({
  sent: a.sent || b.sent, proven: a.proven || b.proven, final: a.final || b.final, block: b.block ?? a.block, updateId: b.updateId ?? a.updateId,
});

/** The explorer's answer for a transaction; null while it has not seen it. */
export async function readTx(hash: Hex): Promise<ApiTx | null> {
  try { return await bridgeReads.tx(hash, timeoutSignal()!); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
}
