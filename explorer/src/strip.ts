import type { ApiHealth, ApiStatus, HealthCheck } from "./api.ts";
import { count, trim } from "./format.ts";

export type Dot = "ok" | "bad" | "off";
/** One name on the home page's health strip, with the dot that says whether its check passes. `title` is what the check says when it does not. */
export interface StripItem { key: string; text: string; dot: Dot; title?: string }

const dotOf = (c: Pick<HealthCheck, "status">): Dot => (c.status === "ok" ? "ok" : "bad");
const worst = (cs: HealthCheck[]): Dot => (cs.every((c) => c.status === "ok") ? "ok" : "bad");
const said = (cs: HealthCheck[]) => cs.filter((c) => c.status !== "ok" && c.detail).map((c) => c.detail).join("; ") || undefined;
/** A number from a check's value, or null where the check has not written it. */
const num = (c: HealthCheck | undefined, field: string): number | null => {
  const v = c?.value;
  const n = v && typeof v === "object" ? (v as Record<string, unknown>)[field] : null;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/**
 * The checks the indexer writes, as the top bar counts them: the API's own rows (each instance's reads, the faucet, the tracker) are left out,
 * so that the bar and the home page never give two counts.
 */
export const indexerChecks = (h: ApiHealth | undefined) => h?.checks.filter((c) => c.role !== "api");

/** The words of the first item: how many checks pass, from the list /api/health serves; without it, the status's own word. */
export function checksWord(s: ApiStatus, h: ApiHealth | undefined): { dot: Dot; text: string } {
  const list = indexerChecks(h);
  if (s.starting && !s.problems.length) return { dot: "off", text: "Starting" };
  if (!s.evm || !s.canton) return { dot: "off", text: "Checks" };
  if (s.problems.length) return { dot: "bad", text: "A check failed" };
  const bad = list?.filter((c) => c.status !== "ok").length ?? 0;
  if (list && bad) return { dot: "bad", text: `${bad} of ${count(list.length)} checks not ok` };
  if (!s.ok) return { dot: "off", text: "Checks" };
  return { dot: "ok", text: list ? `All ${count(list.length)} checks ok` : "Checks pass" };
}

/**
 * The names after the count, in the order of screen 01: the EVM node, the Canton ledger, the producer, the prover, the index lag, the faucet,
 * the verifier and the clock gap. The first two are the status's own reads. Each of the others appears only when its check is in the list, and a
 * number only when the check wrote it: nothing is filled in. The index lag falls back to the status's lag in blocks while the list is unread.
 */
export function stripItems(s: ApiStatus, h: ApiHealth | undefined): StripItem[] {
  const all = h?.checks ?? [];
  const by = (id: string) => all.find((c) => c.id === id);
  const items: StripItem[] = [
    { key: "evm", text: "EVM node", dot: s.evm ? "ok" : "bad" },
    { key: "canton", text: "Canton ledger", dot: s.canton ? "ok" : "bad" },
  ];
  const producer = ["producer_alive", "producer_state"].map(by).filter((c): c is HealthCheck => !!c);
  if (producer.length) items.push({ key: "producer", text: "Producer", dot: worst(producer), title: said(producer) });
  const prover = by("prover");
  if (prover) items.push({ key: "prover", text: "Prover", dot: dotOf(prover), title: said([prover]) });
  const lag = by("C5"), lagS = num(lag, "lagSeconds");
  if (lag && lagS !== null) items.push({ key: "lag", text: `Index lag ${trim(lagS, 1)} s`, dot: dotOf(lag), title: said([lag]) });
  else if (s.indexLag !== null) items.push({ key: "lag", text: `Index lag ${s.indexLag} block${s.indexLag === 1 ? "" : "s"}`, dot: s.indexLag > 0 ? "off" : "ok" });
  const faucet = by("faucet");
  if (faucet) items.push({ key: "faucet", text: "Faucet", dot: dotOf(faucet), title: said([faucet]) });
  const verifier = all.filter((c) => c.id.startsWith("verifier/"));
  if (verifier.length) items.push({ key: "verifier", text: "Verifier", dot: worst(verifier), title: said(verifier) });
  const clock = by("C9"), gap = num(clock, "worstMs");
  if (clock && gap !== null) items.push({ key: "clock", text: `Clock gap ${count(Math.round(gap))} ms`, dot: dotOf(clock), title: said([clock]) });
  return items;
}
