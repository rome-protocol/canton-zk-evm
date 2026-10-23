/**
 * L5's verdict, as pure code so a test holds it without a chain. L5 asks the explorer's Etherscan-compatible API to do what developers' tools ask of Etherscan.
 * `l5.sh probe` decides first, from /api/openapi.json (paths['/api'].get['x-modules']), whether the door is there and which modules are in it. Once the door is there,
 * any check that fails fails the job, and a module that L5 tests and the door lacks is a failure too. A check with `skipped` set (none today) is never a pass:
 * a run with skips is "partial", and the job summary says so.
 */
export interface Check { name: string; ok: boolean; seconds: number; detail: string; /** the module the check needs and the door lacks; the check did not run */ skipped?: string }
export type Status = "passed" | "partial" | "failed" | "skipped";
export interface Summary { status: Status; checks: Check[]; failures: string[]; skipped: string[] }

/**
 * The summary of a run. "failed": a check ran and failed, or none ran at all with the door there is a defect too. "passed": every check ran and passed. "partial": the checks that ran
 * passed and some were skipped. "skipped": every check was skipped (no module of the door is one L5 tests).
 */
export function summarize(checks: Check[]): Summary {
  const ran = checks.filter((c) => c.skipped === undefined);
  const skipped = checks.filter((c) => c.skipped !== undefined).map((c) => `${c.name}: SKIPPED, the ${c.skipped} module is not in the door`);
  const failures = ran.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  if (checks.length === 0) return { status: "failed", checks, failures: ["no check ran"], skipped };
  if (failures.length) return { status: "failed", checks, failures, skipped };
  if (ran.length === 0) return { status: "skipped", checks, failures, skipped };
  return { status: skipped.length ? "partial" : "passed", checks, failures, skipped };
}
