/** Journal lines for the lifecycle tests, shaped as builder/README.md ("The journal") defines them. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyntheticChain } from "../../test/synthetic-chain.ts";

export const RUN1 = "11111111-1111-4111-8111-111111111111";
export const RUN2 = "22222222-2222-4222-8222-222222222222";

const made: string[] = [];
/** A folder of its own; `removeFolders` removes exactly the ones made here. */
export function makeFolder(): string {
  const d = mkdtempSync(join(tmpdir(), "explorer-journal-test-"));
  made.push(d);
  return d;
}
export function removeFolders(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}
export function putFile(dir: string, name: string, lines: string[], end = "\n"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.map((l) => l + "\n").join("") + (end === "\n" ? "" : end));
}
export function appendLines(dir: string, name: string, lines: string[]): void {
  appendFileSync(join(dir, name), lines.map((l) => l + "\n").join(""));
}

export const iso = (ms: number) => new Date(ms).toISOString();

/** The lines of one run, with the sequence numbers the producer gives them. */
export class Run {
  lines: string[] = [];
  seq = 0;
  constructor(readonly id: string) {}
  add(ms: number, event: string, fields: Record<string, unknown> = {}): string {
    const l = JSON.stringify({ v: 1, run: this.id, seq: ++this.seq, time: iso(ms), event, ...fields });
    this.lines.push(l);
    return l;
  }
  /** A line that is lost: its number is used and nothing is written. */
  lose(): void { this.seq++; }
  start(ms: number, settings: Record<string, unknown> = { gather_ms: 0, test: false }) {
    return this.add(ms, "run_started", { strategy: "on_demand", settings, source_commit: "abc1234" });
  }
  /** A block that Canton committed, from the cut to `final_seen`, around the record time of block `n` of the chain. */
  committed(attempt: number, n: number, chain: SyntheticChain, o: { answerMs?: number; txs?: string[]; cutReason?: string; leftOut?: { transaction: string; reason: string }[] } = {}): void {
    const b = chain.blocks[n - 1]!;
    const t = Date.parse(b.record.recordTime);
    this.add(t - 8000, "cut", { attempt, number: n, strategy: "on_demand", cut_reason: o.cutReason ?? "pool", pool_waiting: b.block.transactions.length, idle_before_cut_ms: 40, in_flight_at_cut: 0 });
    this.add(t - 7000, "built", { attempt, block_hash: b.block.hash, parent_hash: b.block.parentHash, tx_hashes: o.txs ?? b.block.transactions.map((x) => x.hash), gas_used: b.block.gasUsed, legs: 0, rebuilds: 0, left_out: o.leftOut ?? [] });
    this.add(t - 6900, "proof_queued", { attempt, prover: "prover-a" });
    this.add(t - 6800, "proof_started", { attempt, prover: "prover-a" });
    this.add(t - 100, "proof_ended", { attempt, prover: "prover-a", outcome: "ok", seconds: 6.7 });
    this.add(t - 50, "submitted", { attempt, command_id: `ostia-770101-${n}-${b.block.hash.slice(2, 18)}-${attempt}`, argument_bytes: 4321 });
    this.add(t + (o.answerMs ?? 40), "answered", { attempt, outcome: "committed", reason: null, update_id: b.record.updateId, completion_offset: n * 10, seconds: 0.9, traffic_bytes: 2048, traffic_before: null, traffic_after: null });
    this.add(t + 1000, "final_seen", { attempt, number: n });
  }
}
