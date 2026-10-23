import type { TraceFrame } from "../api.ts";

/** What a call says when it did not fail itself but a call above it did (or the transaction failed): its effects were undone with the parent's. */
export const PARENT_FAILED = "parent call failed";

const key = (path: number[]) => path.join(",");

/**
 * For each frame, whether its effects were undone: the transaction failed, or the frame itself or a call above it failed. This is the rule the
 * server applies when it derives the internal-call rows, so the tab and the address pages agree.
 */
export function voidedFrames(frames: readonly TraceFrame[], succeeded: boolean): boolean[] {
  const failed = new Set<string>();
  for (const f of frames) if (f.error !== null) failed.add(key(f.traceAddress));
  return frames.map((f) => {
    if (!succeeded) return true;
    for (let len = f.traceAddress.length; len >= 0; len--) if (failed.has(key(f.traceAddress.slice(0, len)))) return true;
    return false;
  });
}

/**
 * Whether a frame moved coin: a plain call (a delegatecall, callcode or staticcall shows its caller's value), a creation or a self-destruct (its value is
 * the balance sent to the refund address), with a value, that took effect. The same split the server makes when it derives the internal-call rows.
 */
export const movesCoin = (f: TraceFrame, voided: boolean): boolean =>
  !voided && f.value !== "0" && (f.type === "call" ? f.callType === "call" : true);
