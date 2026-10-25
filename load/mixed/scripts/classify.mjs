// How the load driver and its report read a receipt: every transaction that became final is one of
//   success           it did what it was sent to do
//   expectedRevert    it was sent to revert (expectRevert) and it did: a test of the contract's refusal, the chain worked as intended
//   unexpectedRevert  it was not sent to revert and it did (the kit's own fault, e.g. an empty wallet, or a real finding), kept with its reason
//   unexpectedSuccess it was sent to revert and it went through (the deliberate case is wrong)
// A soak passes only when it has no unexpected reverts, no deliberate revert that went through, and no lost transactions (accepted by the chain, never final).

export const CLASSES = ["success", "expectedRevert", "unexpectedRevert", "unexpectedSuccess"];

/** @param {{success: boolean, expectRevert?: boolean}} o */
export function classify({ success, expectRevert }) {
  if (success) return expectRevert ? "unexpectedSuccess" : "success";
  return expectRevert ? "expectedRevert" : "unexpectedRevert";
}

export const emptyTally = () => ({ success: 0, expectedRevert: 0, unexpectedRevert: 0, unexpectedSuccess: 0 });

/** The text of the per-minute line for these counts. */
export function tallyLine(t) {
  return `ok ${t.success}  reverted on purpose ${t.expectedRevert}  UNEXPECTED reverts ${t.unexpectedRevert}` + (t.unexpectedSuccess ? `  deliberate reverts that went through ${t.unexpectedSuccess}` : "");
}

/** The soak's pass rule on the counts: no unexpected revert, no deliberate revert that went through, and no lost transaction (`lost`: how many accepted ones never became final). */
export const passes = (t, lost = 0) => t.unexpectedRevert === 0 && t.unexpectedSuccess === 0 && lost === 0;

const PANIC = { 0x01: "assert failed", 0x11: "arithmetic overflow or underflow", 0x12: "division by zero", 0x21: "bad enum value", 0x22: "bad storage encoding", 0x31: "pop of an empty array", 0x32: "array index out of bounds", 0x41: "out of memory", 0x51: "call of an uninitialised function" };

// ABI string / uint256 reads by hand, so this file (and its test) needs no installed packages
const word = (hex, i) => hex.slice(2 + 64 * i, 2 + 64 * (i + 1));

/** The reason in a revert's return data: Error(string), Panic(uint256), a custom error (its 4-byte selector) or nothing. */
export function decodeRevert(data) {
  if (typeof data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length < 10) return "no reason given";
  const sel = data.slice(0, 10).toLowerCase(), body = "0x" + data.slice(10);
  try {
    if (sel === "0x08c379a0") {
      const off = Number(BigInt("0x" + word(body, 0))) / 32, len = Number(BigInt("0x" + word(body, off)));
      const hex = body.slice(2 + 64 * (off + 1), 2 + 64 * (off + 1) + len * 2);
      if (hex.length !== len * 2) return "undecodable revert data";
      return Buffer.from(hex, "hex").toString("utf8").slice(0, 200);
    }
    if (sel === "0x4e487b71") { const c = Number(BigInt("0x" + word(body, 0))); return `panic 0x${c.toString(16)}: ${PANIC[c] ?? "unknown"}`; }
  } catch { return "undecodable revert data"; }
  return `custom error ${sel}`;
}

/** The reason out of what an eth_call that reverted threw: the return data when the node sends it, else the node's own message. */
export function reasonFromError(e) {
  if (e && typeof e.data === "string" && e.data.length >= 10) return decodeRevert(e.data);
  const m = String(e?.message ?? e ?? "").replace(/^execution reverted:?\s*/i, "").replace(/0x[0-9a-f]{40,}/gi, "0x..").trim();
  return (m || "no reason given").slice(0, 200);
}

/**
 * Finds the reason of unexpected reverts by replaying the call (eth_call from the same wallet). It is bounded: at most `cap` replays per kind,
 * then the last reason of that kind is reused (marked "same kind as an earlier replay"), so a drained wallet cannot cost the RPC budget one call per revert.
 * @param {(rec: object) => Promise<string>} replay  returns the reason, or throws
 */
export function reasonFinder(replay, cap = 10) {
  const used = new Map(), last = new Map();
  return async (rec) => {
    const k = rec.sub && rec.sub !== "lazy" ? `${rec.kind}: ${rec.sub}` : rec.kind;
    if ((used.get(k) ?? 0) >= cap) return last.has(k) ? `${last.get(k)} (same kind as an earlier replay)` : "not replayed";
    used.set(k, (used.get(k) ?? 0) + 1);
    let r;
    try { r = await replay(rec); } catch (e) { r = `replay failed: ${String(e?.message ?? e).slice(0, 80)}`; }
    last.set(k, r);
    return r;
  };
}
