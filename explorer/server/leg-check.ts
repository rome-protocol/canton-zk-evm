/**
 * The leg check. A transaction that asks the gateway or a vault for a Canton leg whose Canton side does not exist (a lock for a receiver that has not accepted
 * twins, a withdrawal to a party with no standing acceptance, a payment with no terms) is never mined: the block builder leaves it out of every block, and its
 * sender's later transactions with it. The block builder runs a small service on its own machine that says, for a call, whether a leg it would record has a
 * Canton side now. The public RPC asks it before it sends a transaction to reth, and refuses the transaction with the reason when the answer is no.
 *
 * It is a help, never a gate: when the service is not there, is busy, answers with anything but a clear no, or takes longer than the limit, the transaction goes on
 * as if there were no check.
 */

/** What the service is asked about: the call a transaction makes. */
export interface CheckedCall { from: string; to: string; data: string; value: string; gas: string }
/** The reason a transaction is refused, or null when it may go on. */
export type LegCheck = (call: CheckedCall) => Promise<string | null>;

/** The longest a reason is kept. */
const MAX_REASON = 600;

export function createLegCheck(baseUrl: string, timeoutMs = 3000, fetcher: typeof fetch = fetch): LegCheck {
  const target = baseUrl.replace(/\/+$/, "") + "/v1/leg-check";
  return async (call) => {
    try {
      const res = await fetcher(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call), signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null; // busy, or not what it answers
      const body: unknown = await res.json();
      if (typeof body !== "object" || body === null) return null;
      const { ok, reason } = body as { ok?: unknown; reason?: unknown };
      return ok === false && typeof reason === "string" && reason.length > 0 ? reason.slice(0, MAX_REASON) : null;
    } catch {
      return null; // down, too slow, or not JSON: no check
    }
  };
}
