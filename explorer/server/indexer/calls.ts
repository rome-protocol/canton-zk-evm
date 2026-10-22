/**
 * What stage 2 works out from one transaction's trace frames (design section 4.3): the internal calls (calls that move value, creations and
 * self-destructs, which is what Etherscan lists as internal transactions), the contracts the transaction made, and the accounts it destroyed.
 * Pure: the same frames always give the same rows, so a block that is derived again gives the same rows again.
 */
import { keccak256 } from "viem";
import type { TraceFrame } from "./reads.ts";

export interface InternalCall {
  txIndex: number;
  traceAddress: number[];
  callType: string;
  from: string;
  to: string | null;
  value: bigint;
  gas: number | null;
  gasUsed: number | null;
  selector: string | null;
  inputSize: number;
  error: string | null;
}

export interface CreatedContract {
  address: string;
  creator: string;
  txIndex: number;
  traceAddress: number[];
  runtimeCode: string;
  initCode: string;
}

export interface Destroyed { address: string; txIndex: number }

export interface FrameRows { calls: InternalCall[]; created: CreatedContract[]; destroyed: Destroyed[] }

/** What a frame says when it did not fail itself but a call above it did: its effects were undone with the parent's. */
export const PARENT_FAILED = "parent call failed";

const key = (path: number[]) => path.join(",");
const inputBytes = (hex: string) => (hex.length - 2) / 2;

/**
 * The rows for the frames of transaction `txIndex`. A frame took effect only when the transaction succeeded and no call above it, or it itself,
 * failed: a contract a failed call "created" does not exist, and an account that "destroyed itself" under a failed call is still there.
 */
export function deriveFrames(txIndex: number, succeeded: boolean, frames: TraceFrame[]): FrameRows {
  const failed = new Set<string>();
  for (const f of frames) if (f.error !== null) failed.add(key(f.traceAddress));
  const voided = (f: TraceFrame): boolean => {
    if (!succeeded) return true;
    for (let len = f.traceAddress.length; len >= 0; len--) if (failed.has(key(f.traceAddress.slice(0, len)))) return true;
    return false;
  };
  const rows: FrameRows = { calls: [], created: [], destroyed: [] };
  for (const f of frames) {
    const void_ = voided(f);
    if (!void_ && f.type === "create" && f.created && f.created.code !== "0x") {
      rows.created.push({ address: f.created.address, creator: f.from, txIndex, traceAddress: f.traceAddress, runtimeCode: f.created.code, initCode: f.input });
    }
    if (!void_ && f.type === "suicide") rows.destroyed.push({ address: f.from, txIndex });
    // The transaction's own call is the transaction; every other frame is an internal call when it moves value, creates or destroys.
    if (f.traceAddress.length === 0) continue;
    const moves = f.type === "call" ? f.callType === "call" && f.value > 0n : true;
    if (!moves) continue;
    rows.calls.push({
      txIndex, traceAddress: f.traceAddress, callType: f.callType, from: f.from, to: f.to, value: f.value, gas: f.gas, gasUsed: f.gasUsed,
      selector: f.type === "call" && inputBytes(f.input) >= 4 ? f.input.slice(0, 10) : null, inputSize: f.type === "suicide" ? 0 : inputBytes(f.input),
      error: f.error ?? (void_ ? PARENT_FAILED : null),
    });
  }
  return rows;
}

export const codeHash = (code: string): string => keccak256(code as `0x${string}`);
