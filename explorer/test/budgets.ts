/**
 * The design's budgets (section 9) for W1, the costliest token block the 30 Mgas cap allows: B1 for stage 1, B2 for both stages. Provisional, and re-set from W1's
 * measured time on 2026-10-22 (docs/METRICS.md): the slowest of four rehearsal runs of `behind` (the CI runner varies by up to twice), 2,186 ms for stage 1 and
 * 10,188 ms for both stages, with 25% headroom. The load test and the rehearsal's W1 both assert them.
 */
export const B1_MS = 2750;
export const B2_MS = 12_750;
