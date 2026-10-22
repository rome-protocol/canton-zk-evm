/**
 * L5's verdict, as pure code so a test holds it without a chain. L5 asks the explorer's Etherscan-compatible API to do what developers' tools ask of Etherscan.
 * Until that API exists (E8b for the proxy module, E9b for the contract module) every check would fail for a reason that is not a defect, so `l5.sh probe` decides
 * first, from DOOR in this folder and a live probe that must agree with it. A skip is never a pass: the results say "skipped" and the job summary says so.
 * Once the door is there, any check that fails fails the job.
 */
export interface Check { name: string; ok: boolean; seconds: number; detail: string }
export type Status = "passed" | "failed";
export interface Summary { status: Status; checks: Check[]; failures: string[] }

/** The summary of a run. Whether L5 runs at all is decided before, by `l5.sh probe` (DOOR and a live probe); a skip is written by `l5.sh skipped`, never from here. */
export function summarize(checks: Check[]): Summary {
  const failures = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  if (checks.length === 0) return { status: "failed", checks, failures: ["no check ran"] };
  return { status: failures.length ? "failed" : "passed", checks, failures };
}
