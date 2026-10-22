/**
 * The design's budgets (section 9) for W1, the costliest token block the 30 Mgas cap allows: B1 for stage 1, B2 for both stages. Provisional, and re-set from W1's
 * measured time on 2026-10-22 (docs/METRICS.md): the slowest of three rehearsal runs of `behind`, 1,845 ms for stage 1 and 7,528 ms for both stages, with 25% headroom.
 * The load test and the rehearsal's W1 both assert them.
 */
export const B1_MS = 2500;
export const B2_MS = 9500;
