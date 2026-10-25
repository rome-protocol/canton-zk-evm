// The numbers of a finished load run, from its events file: counts by kind, how many transactions became final, blocks, proof and final times by block size,
// what the Canton ledger recorded per block. Writes report.json and report.md next to the events.
//   node scripts/load-report.mjs <name>
import { readFileSync, writeFileSync } from "node:fs";
import { cfg, RUN } from "./lib.mjs";
import { classify, emptyTally, passes } from "./classify.mjs";

const NAME = process.argv[2];
if (!NAME) { console.error("usage: load-report.mjs <name>"); process.exit(2); }
const DIR = `${RUN}/load/${NAME}`;
const lines = readFileSync(`${DIR}/events.ndjson`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const by = (e) => lines.filter((x) => x.e === e);
const sent = new Map(by("sent").map((x) => [x.hash, x]));
const finals = new Map(by("final").map((x) => [x.hash, x]));
const rejected = by("rejected");
const blocks = new Map(by("block").map((x) => [x.n, x]));
const phases = by("phase");
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r2 = (x) => (x == null ? "n/a" : Number(x).toFixed(2));
const stat = (a) => ({ n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), max: a.length ? Math.max(...a) : null });
const bucket = (n) => (n <= 10 ? "1-10" : n <= 100 ? "11-100" : n <= 1000 ? "101-1000" : "over 1000");
const BUCKETS = ["1-10", "11-100", "101-1000", "over 1000"];
const label = (x) => (x.sub && x.sub !== "lazy" ? `${x.kind}: ${x.sub}` : x.kind);

const rep = {};
// every final transaction is a success, a revert sent on purpose, or an unexpected revert with its reason (events of older runs carry no class: it is worked out here)
const reasons = new Map(by("revertReason").map((x) => [x.hash, x.reason]));
const cls = (h) => { const f = finals.get(h); return f && (f.class ?? classify({ success: f.success, expectRevert: !!sent.get(h)?.expectRevert })); };
const outcomes = emptyTally();
for (const h of finals.keys()) if (sent.has(h)) outcomes[cls(h)]++;
rep.outcomes = outcomes;
rep.pass = { rule: "no unexpected revert and no deliberate revert that went through", ok: passes(outcomes) };
rep.unexpectedRevertReasons = {};
for (const [h, f] of finals) if (cls(h) === "unexpectedRevert") { const k = `${label(sent.get(h) ?? { kind: "?" })}: ${reasons.get(h) ?? "reason not read"}`; rep.unexpectedRevertReasons[k] = (rep.unexpectedRevertReasons[k] ?? 0) + 1; }
// counts by kind
const kinds = {};
for (const [h, s] of sent) {
  const k = (kinds[label(s)] ??= { sent: 0, final: 0, success: 0, reverted: 0, expectedRevert: !!s.expectRevert });
  k.sent++;
  const f = finals.get(h);
  if (f) { k.final++; f.success ? k.success++ : k.reverted++; }
}
rep.kinds = kinds;
const accepted = sent.size, final = finals.size;
const notFinal = [...sent.values()].filter((s) => !finals.has(s.hash));
const unexpectedFail = [...sent.values()].filter((s) => finals.get(s.hash) && !finals.get(s.hash).success && !s.expectRevert);
const expectedOk = [...sent.values()].filter((s) => finals.get(s.hash)?.success && s.expectRevert);
rep.totals = { accepted, rejected: rejected.length, final, lost: notFinal.length, unexpectedFailures: unexpectedFail.length, deliberateRevertsThatSucceeded: expectedOk.length,
  deliberateReverts: [...sent.values()].filter((s) => s.expectRevert).length };
rep.lost = notFinal.map((s) => ({ hash: s.hash, kind: label(s), sentAt: new Date(s.sentAt).toISOString() }));
rep.rejections = rejected.reduce((o, r) => { const m = r.err.replace(/0x[0-9a-f]+/gi, "0x..").slice(0, 80); o[m] = (o[m] ?? 0) + 1; return o; }, {});
rep.unexpectedFailures = unexpectedFail.slice(0, 20).map((s) => ({ hash: s.hash, kind: label(s), block: finals.get(s.hash).block }));

// time to final
const ttf = (x) => (x.finalAt - x.sentAt) / 1000;
const all = [...finals.values()].map(ttf);
rep.timeToFinal = { all: stat(all), byPhase: {}, byBlockSize: {} };
for (const p of phases) {
  const v = [...finals.values()].filter((f) => sent.get(f.hash)?.phase === p.name || (p.name.startsWith("best") && sent.get(f.hash)?.phase === "best")).map(ttf);
  rep.timeToFinal.byPhase[p.name] = stat(v);
}
for (const b of BUCKETS) rep.timeToFinal.byBlockSize[b] = stat([...finals.values()].filter((f) => blocks.get(f.block) && bucket(blocks.get(f.block).txCount) === b).map(ttf));

// blocks
const mine = new Map();
for (const f of finals.values()) mine.set(f.block, (mine.get(f.block) ?? 0) + 1);
const used = [...mine.keys()].map((n) => blocks.get(n)).filter(Boolean);
rep.blocks = { withOurTxs: used.length, ourTxsPerBlock: stat([...mine.values()]), allTxsPerBlock: stat(used.map((b) => b.txCount)), gasUsed: stat(used.map((b) => b.gasUsed)) };
rep.bySize = {};
for (const b of BUCKETS) {
  const v = used.filter((x) => bucket(x.txCount) === b);
  rep.bySize[b] = { blocks: v.length, proofSeconds: stat(v.map((x) => x.proofSeconds).filter((x) => x != null)), finalSeconds: stat(v.map((x) => x.finalSeconds).filter((x) => x != null)), commitSeconds: stat(v.map((x) => x.commitSeconds).filter((x) => x != null)) };
}
const busiest = used.slice().sort((a, b) => b.txCount - a.txCount)[0];
rep.busiestBlock = busiest ? { number: busiest.n, txCount: busiest.txCount, ours: mine.get(busiest.n), gasUsed: busiest.gasUsed, proofSeconds: busiest.proofSeconds, finalSeconds: busiest.finalSeconds, commitSeconds: busiest.commitSeconds, url: `${cfg.explorer}/block/${busiest.n}` } : null;

// gas per kind
rep.gas = {};
for (const [h, f] of finals) { const s = sent.get(h); if (s && f.success) (rep.gas[label(s)] ??= []).push(f.gasUsed); }
for (const k of Object.keys(rep.gas)) rep.gas[k] = stat(rep.gas[k]);

// the RPC
const mins = by("rpcMinute");
const end = by("end")[0];
rep.rpc = { budgetPerMinute: end?.rpc?.budget, peakCallsInAMinute: mins.length ? Math.max(...mins.map((m) => m.used)) : null, calls: end?.rpc?.calls, limitedAnswers: end?.rpc?.httpLimited, waitedForBudgetSeconds: end ? Math.round(end.rpc.waitedMs / 1000) : null, receiptsChecked: end?.receipts?.checked, receiptMismatches: end?.receipts?.mismatched };
rep.phases = phases.map((p) => { const pe = by("phaseEnd").find((x) => x.name === p.name.replace(/ \(.*\)$/, "")) ?? by("phaseEnd").find((x) => x.rate === p.rate); const ok = by("phaseOk").find((x) => x.name === p.name.replace(/ \(.*\)$/, "")); return { name: p.name, target: p.rate, achieved: pe?.achieved, everyTxFinal: ok?.ok, minutes: Math.round((p.end - p.start) / 60000) }; });
rep.redstone = { tried: by("redstone").length, gotPrices: by("redstone").filter((x) => x.ok).length, vaultRecords: kinds.vaultRecord?.sent ?? 0, vaultReads: by("vaultRead").filter((x) => !x.err).length };
rep.merces = { proofs: by("proof").length, proofMs: stat(by("proof").map((x) => x.ms)) };
rep.run = { name: NAME, start: lines[0] && new Date(lines[0].t).toISOString(), end: end && new Date(end.t).toISOString(), wallets: end?.wallets, skipped: end?.skipped };

// Canton: what the ledger records for each block of the run
const get = async (path) => { for (let i = 0; i < 5; i++) { const r = await fetch(cfg.explorer + path, { headers: { "user-agent": "Rome Protocol rome@romeprotocol.com" } }); if (r.status === 429) { await new Promise((x) => setTimeout(x, 1500)); continue; } return r.ok ? r.json() : null; } return null; };
const found = (o, re, path = "", out = {}) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (v && typeof v === "object") found(v, re, `${path}.${k}`, out); else if (re.test(k) && v != null) out[`${path}.${k}`.slice(1)] = v; } return out; };
const arg = [], traffic = [], fields = new Set(), perTx = [];
for (const b of used) {
  if (!b.updateId) continue;
  const u = await get(`/api/canton/updates/${b.updateId}`);
  if (!u) continue;
  const a = u.producerRecord?.argumentBytes; if (a != null) { arg.push(a); perTx.push(a / b.txCount); }
  const t = found(u, /traffic/i); for (const [k, v] of Object.entries(t)) { fields.add(k); if (typeof v === "number" && /bytes|cost/i.test(k)) traffic.push(v); }
  await new Promise((x) => setTimeout(x, 120));
}
rep.canton = { blocksRead: arg.length, argumentBytesPerBlock: stat(arg), argumentBytesPerTx: stat(perTx), trafficFieldsSeen: [...fields], trafficValuesPerBlock: stat(traffic) };
writeFileSync(`${DIR}/report.json`, JSON.stringify(rep, null, 2) + "\n");

// markdown
const fmt = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k}: ${v}`).join("; ") || "none";
const row = (...c) => `| ${c.join(" | ")} |`;
const out = [];
out.push(`## Counts by kind`, "", row("kind", "sent", "final", "succeeded", "reverted"), row("---", "---:", "---:", "---:", "---:"));
for (const [k, v] of Object.entries(kinds).sort((a, b) => b[1].sent - a[1].sent)) out.push(row(k, v.sent, v.final, v.success, v.reverted + (v.expectedRevert ? " (on purpose)" : "")));
out.push("", `Accepted ${accepted}, final ${final}, lost ${notFinal.length}, refused by the RPC at send ${rejected.length}, unexpected failures ${unexpectedFail.length}.`, "");
out.push(`## Phases`, "", row("phase", "target tx/s", "sent tx/s", "minutes", "every tx final", "time to final p50 / p95 (s)"), row("---", "---:", "---:", "---:", "---", "---:"));
for (const p of rep.phases) { const t = rep.timeToFinal.byPhase[p.name]; out.push(row(p.name, p.target, r2(p.achieved), p.minutes, p.everyTxFinal, t ? `${r2(t.p50)} / ${r2(t.p95)}` : "n/a")); }
out.push("", `## Proof and final time by block size`, "", row("txs in the block", "blocks", "proof p50 / p95 (s)", "final p50 / p95 (s)", "commit p50 / p95 (s)", "our tx time to final p50 / p95 (s)"), row("---", "---:", "---:", "---:", "---:", "---:"));
for (const b of BUCKETS) { const s = rep.bySize[b], t = rep.timeToFinal.byBlockSize[b]; out.push(row(b, s.blocks, `${r2(s.proofSeconds.p50)} / ${r2(s.proofSeconds.p95)}`, `${r2(s.finalSeconds.p50)} / ${r2(s.finalSeconds.p95)}`, `${r2(s.commitSeconds.p50)} / ${r2(s.commitSeconds.p95)}`, `${r2(t.p50)} / ${r2(t.p95)}`)); }
out.push("", `Time to final for every transaction: p50 ${r2(rep.timeToFinal.all.p50)} s, p95 ${r2(rep.timeToFinal.all.p95)} s, max ${r2(rep.timeToFinal.all.max)} s (from the moment it was sent to the moment its block was first seen final).`);
out.push("", `## Blocks`, "", `${rep.blocks.withOurTxs} blocks carried our transactions: ${rep.blocks.ourTxsPerBlock.p50} of ours per block (median), ${rep.blocks.ourTxsPerBlock.max} at most; ${rep.blocks.allTxsPerBlock.p50} transactions per block in all (median), ${rep.blocks.allTxsPerBlock.max} at most; gas per block median ${rep.blocks.gasUsed.p50}, at most ${rep.blocks.gasUsed.max} of 30,000,000.`);
if (busiest) out.push("", `Busiest block: ${busiest.n}, ${busiest.txCount} transactions (${mine.get(busiest.n)} ours), ${busiest.gasUsed} gas, proof ${r2(busiest.proofSeconds)} s, final ${r2(busiest.finalSeconds)} s, commit ${r2(busiest.commitSeconds)} s.`);
out.push("", `## Canton ledger`, "", `${rep.canton.blocksRead} blocks read from /api/canton/updates: argument bytes per block p50 ${r2(rep.canton.argumentBytesPerBlock.p50)}, p95 ${r2(rep.canton.argumentBytesPerBlock.p95)}, max ${r2(rep.canton.argumentBytesPerBlock.max)}; per transaction p50 ${r2(rep.canton.argumentBytesPerTx.p50)}. Traffic fields the explorer showed: ${rep.canton.trafficFieldsSeen.join(", ") || "none"}.`);
out.push("", `## RPC`, "", `Budget ${rep.rpc.budgetPerMinute} calls a minute; the most used in any minute: ${rep.rpc.peakCallsInAMinute}; ${rep.rpc.calls} calls in all; ${rep.rpc.limitedAnswers} answers of "too many requests"; the driver waited ${rep.rpc.waitedForBudgetSeconds} s for budget; ${rep.rpc.receiptsChecked} receipts read through the RPC (${rep.rpc.receiptMismatches} differed from the explorer).`);
out.push("", `## Outcome of the final transactions`, "", row("class", "count"), row("---", "---:"), row("success", outcomes.success), row("reverted on purpose (a test of a contract's refusal; the chain worked as intended)", outcomes.expectedRevert), row("UNEXPECTED revert", outcomes.unexpectedRevert), row("deliberate revert that went through", outcomes.unexpectedSuccess));
out.push("", `Pass rule: ${rep.pass.rule}. This run: ${rep.pass.ok ? "PASS" : "FAIL"}.`);
if (outcomes.unexpectedRevert) out.push("", `Unexpected reverts by reason: ${fmt(rep.unexpectedRevertReasons)}.`);
out.push("", `## Reverts`, "", `Deliberate reverts (sent to fail): ${Object.values(kinds).reduce((a, v) => a + (v.expectedRevert ? v.reverted : 0), 0)} reverted as intended, ${rep.totals.deliberateRevertsThatSucceeded} succeeded when they should not have. Unexpected failures: ${unexpectedFail.length}${unexpectedFail.length ? ` (${rep.unexpectedFailures.map((u) => `${u.kind} ${u.hash} in block ${u.block}`).join("; ")})` : ""}.`);
out.push("", `## Lost transactions and refusals`, "", `Lost (accepted by the RPC, never seen in a final block): ${rep.lost.length}${rep.lost.length ? ` (${rep.lost.slice(0, 20).map((l) => `${l.kind} ${l.hash}`).join("; ")})` : ""}.`, "", `Refused by the RPC at send, by reason: ${fmt(rep.rejections)}.`);
out.push("", `## Kinds that did not run`, "", `Skipped because they could not be built when their turn came: ${fmt(rep.run.skipped)}.`);
out.push("", `## RedStone`, "", `The feeder asked RedStone's gateways ${rep.redstone.tried} times and got signed prices ${rep.redstone.gotPrices} times; ${rep.redstone.vaultRecords} PriceVault.record transactions were sent and ${rep.redstone.vaultReads} price reads (eth_call with a payload) answered.${rep.redstone.gotPrices === 0 ? " The public gateways refused every request (they are being switched off and stop on 2026-10-29), so the oracle consumer recorded no price in this run." : ""}`);
out.push("", `## Merces (private transfers)`, "", `Client side only: ${rep.merces.proofs} Groth16 transfer proofs were made on the sending machine (${rep.merces.proofs ? `median ${r2(rep.merces.proofMs.p50)} ms` : "none"}); deposits and transfers were sent to the Merces contract, whose verifier checks each proof. Nothing is settled: no MPC node runs, so the queued actions are never processed and no balance moves. See the kinds table for how many of each were final.`);
writeFileSync(`${DIR}/report.md`, out.join("\n") + "\n");
console.log(out.join("\n"));
