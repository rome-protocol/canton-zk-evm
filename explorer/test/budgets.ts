/**
 * The budgets (docs/METRICS.md, 'B1 and B2 on the reference machine and on the runner') for W1, the costliest token block the 30 Mgas cap allows: B1 for stage 1, B2 for both stages. Provisional, and re-set from W1's
 * measured time on 2026-10-22 (docs/METRICS.md): the slowest of four rehearsal runs of `behind` (the CI runner varies by up to twice), 2,186 ms for stage 1 and
 * 10,188 ms for both stages, with 25% headroom. The load test and the rehearsal's W1 both assert them.
 */
export const B1_MS = 2750;
export const B2_MS = 12_750;

/**
 * What the W1 test holds B2 to on GitHub's shared runner (see docs/METRICS.md, "B1 and B2 on the reference machine and on the runner"). B2_MS stays the budget. A provisional reference-machine measurement: W1 (rehearsal block 10: 5 transactions, 1,028 logs, 24,360,904 gas) measured there over 5 runs, B1 p50 806 ms (802 to 810) and B2 p50 3,998 ms (3,972 to 4,072).
 * On the shared runner B2 took 11.4 to 13.0 s on 2026-10-23 (failures at 13,026, 12,755 and 12,756 ms, passes at 11,410 and 12,367 ms), so there the test is
 * a regression check held to 1.25 x B2. B1 is held to B1_MS on both. `budgets.test.ts` keeps this at 1.25 x B2_MS, rounded to 250 ms.
 */
export const B2_RUNNER_MS = 16_000;

/**
 * The ordinary shapes of `tokens-load.test.ts` (5,000 holders, a sweep, the reindex's rebuild) are held to the design's first budgets: 1.0 s for one stage and 3.0 s for both, far inside
 * what they need on the reference machine (stage 2 took 150, 180 and 65 ms on a laptop). On GitHub's shared runner they are measured against a tolerance of 1.25 x the budget, as W1's
 * B2 is under the W1 ruling of 2026-10-23: the same 1.25 x for these ordinary shapes is recorded in docs/DESIGN.md, Budgets, by the design ruling of 2026-10-24. A stage 2 of 1,013 ms was seen
 * on the runner against the 1,000 ms limit, a slow runner and not a change in the code. `budgets.test.ts` keeps the tolerances at 1.25 x, rounded to 250 ms.
 */
export const LOAD_B1_MS = 1000;
export const LOAD_B2_MS = 3000;
export const LOAD_B1_RUNNER_MS = 1250;
export const LOAD_B2_RUNNER_MS = 3750;
