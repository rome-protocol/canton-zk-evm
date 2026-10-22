/**
 * L5's verdict, as pure code so a test holds it without a chain. L5 asks the explorer's Etherscan-compatible API to do what developers' tools ask of Etherscan.
 * Until that API exists (E8a for the account, transaction and proxy modules, E9b for the contract module) every check would fail for a reason that is not a defect,
 * so a probe asks first. No answer is a SKIP, and a skip is never a pass: the results say "skipped", the job summary says so, and the numbers of a pass are not
 * claimed. Once the probe is answered, any check that fails fails the job.
 */
export const SKIPPED_REASON = "SKIPPED: E8a/E9b not landed";

export interface Check { name: string; ok: boolean; seconds: number; detail: string }
export type Status = "skipped" | "passed" | "failed";
export interface Summary { status: Status; reason?: string; checks: Check[]; failures: string[] }

/** Whether a reply to GET /api?module=proxy&action=eth_blockNumber is an Etherscan-compatible door: JSON with a hex quantity in `result`. */
export function isDoor(httpStatus: number, body: string): boolean {
  if (httpStatus !== 200) return false;
  try {
    const parsed = JSON.parse(body) as { result?: unknown };
    return typeof parsed.result === "string" && /^0x[0-9a-fA-F]+$/.test(parsed.result);
  } catch {
    return false;
  }
}

/** The summary of a run: `checks` is null when the door was not there and nothing was run. */
export function summarize(checks: Check[] | null): Summary {
  if (checks === null) return { status: "skipped", reason: SKIPPED_REASON, checks: [], failures: [] };
  const failures = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  if (checks.length === 0) return { status: "failed", checks, failures: ["no check ran"] };
  return { status: failures.length ? "failed" : "passed", checks, failures };
}
