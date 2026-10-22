/**
 * The design's budgets (section 9) for W1, the costliest token block the 30 Mgas cap allows: B1 for stage 1, B2 for both stages. Provisional, and re-set from W1's
 * measured time with 25% headroom (docs/METRICS.md says when). The load test and the rehearsal's W1 both assert them.
 */
// Set from the rehearsal's first run of the new W1; the measured values replace them.
export const B1_MS = 10_000;
export const B2_MS = 30_000;
