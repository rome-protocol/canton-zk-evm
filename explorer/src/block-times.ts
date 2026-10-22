/** The producer's times for the attempt that made a block, as the block route serves them (null for one the journal did not write). */
export interface Lifecycle {
  strategy: string; cutReason: string; cutAt: string; builtAt: string | null; proofStartedAt: string | null; proofEndedAt: string | null; submittedAt: string | null; answeredAt: string | null;
}

/** A time in milliseconds, with the microseconds that Canton's record time carries (Date.parse keeps only whole milliseconds). */
export function at(iso: string): number {
  const m = /^(.*?)(?:\.(\d+))?Z$/.exec(iso);
  const whole = Date.parse(`${m?.[1] ?? iso}Z`);
  return m?.[2] ? whole + Number(`0.${m[2]}`) * 1000 : whole;
}

/** Seconds from milliseconds, to the places asked. */
export const secs = (ms: number, places = 2) => `${(Math.max(0, ms) / 1000).toFixed(places)} s`;

/** How long ago a time was, in the two largest units: seconds, minutes, hours or days. A time ahead of the clock is "0 s ago". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - at(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min ago` : `${h} h ago`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h ago` : `${Math.floor(h / 24)} d ago`;
}

export interface Step { name: string; clock: string | null; delta: string | null; note: string; source: "producer log" | "Canton record time" | null }
export interface BarPart { name: "prepare" | "proof" | "send" | "canton"; ms: number }
export interface Became {
  steps: Step[];
  /** The proof's own time, Canton's commit time and the whole way from the cut to final; null when a time they need is missing. */
  proofMs: number | null; commitMs: number | null; totalMs: number | null;
  /** The whole way in its four parts, or null when one of the times is missing. */
  bar: BarPart[] | null;
}

export const clock = (iso: string, digits: 3 | 6) => {
  const m = /T(\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(iso);
  return m ? `${m[1]}.${(m[2] ?? "").padEnd(digits, "0").slice(0, digits)}` : iso;
};

/** The six steps of a block's way to final, from the producer's journal and Canton's record time. Nothing is guessed: a time that is not there is null. */
export function howItBecameFinal(l: Lifecycle | null, recordTime: string | null, proofBytes: number | null = null): Became {
  const times: (string | null)[] = [l?.cutAt ?? null, l?.builtAt ?? null, l?.proofStartedAt ?? null, l?.proofEndedAt ?? null, l?.submittedAt ?? null, recordTime];
  const names = ["Cut", "Built", "Proof started", "Proof done", "Sent to Canton", "Final on Canton"];
  const notes = ["start", "reth made the block", "", proofBytes === null ? "ZisK" : `ZisK, ${proofBytes.toLocaleString("en-US")} bytes`, "ZkChain · Advance", ""];
  const steps = times.map((t, i): Step => {
    const prev = i > 0 ? times[i - 1] : null;
    return {
      name: names[i]!, clock: t === null ? null : clock(t, i === 5 ? 6 : 3),
      delta: t !== null && prev ? `+${((at(t) - at(prev)) / 1000).toFixed(3)} s` : null,
      note: notes[i]!, source: t === null ? null : i === 5 ? "Canton record time" : "producer log",
    };
  });
  const [cut, , started, ended, sent, record] = times;
  const between = (a: string | null | undefined, b: string | null | undefined) => (a && b ? at(b) - at(a) : null);
  const proofMs = between(started, ended), commitMs = between(sent, record), totalMs = between(cut, record);
  const parts = [between(cut, started), proofMs, between(ended, sent), commitMs];
  const bar = parts.every((p) => p !== null) ? (["prepare", "proof", "send", "canton"] as const).map((name, i): BarPart => ({ name, ms: parts[i]! })) : null;
  return { steps, proofMs, commitMs, totalMs, bar };
}
