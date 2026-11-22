// Whether this browser keeps a move that is not over: the question the explorer's old /bridge address asks before it sends a person to the Bridge's own site. A browser's storage belongs to one site, so
// a move kept under the explorer's address is invisible on the Bridge site; the person must be able to finish it where it was started. "Not over" is what Activity shows as on its way or waiting
// for the person: a kept Canton move that is not in the finished list, and a kept transfer that has not arrived and has not been given up as lost.
import { finished } from "./activity.ts";
import { keptMoves, type StoreLike } from "./moves/state.ts";
import { loadTransfer } from "./other/record.ts";

/** The transfers' index in the store (the key record.ts keeps it under; the test writes a transfer with record.ts and so breaks if the key changes). */
const TRANSFERS = "agglayer-transfers";

export function hasUnfinished(store: StoreLike | null): boolean {
  if (store === null) return false;
  const done = finished(store);
  if (keptMoves(store).some((c) => !done.some((e) => e.ref === c.ref))) return true;
  let ids: unknown;
  try { ids = JSON.parse(store.getItem(TRANSFERS) ?? "[]"); } catch { return false; }
  if (!Array.isArray(ids)) return false;
  return ids.some((id) => {
    const t = typeof id === "string" ? loadTransfer(store, id) : null;
    return t !== null && t.done === undefined && !t.lost;
  });
}
