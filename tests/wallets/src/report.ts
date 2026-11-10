// Makes the committed results from a run: results/wallets.json (for machines) and results/wallets.md (the table). Usage: node src/report.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "./paths.ts";

const RUN = join(HERE, "run"), OUT = join(HERE, "results");

export interface Row {
  id: string; name: string; status: "tested" | "not automated"; reason?: string;
  version?: string; source?: string; downloadUrl?: string; sha256?: string; notes?: string; date: string;
  sameTwice?: boolean; sameAfterRestart?: boolean; matchesReference?: boolean; rawMatchesReference?: boolean; form?: { v: string; lowS: boolean };
  normalisedSha256?: string; fingerprint?: string; matchesOtherWallets?: "same bytes" | "same after normalising" | "no" | "only one wallet tested"; opensLiveBridge?: "yes" | "not tried";
}

const yes = (b: boolean | undefined) => (b === undefined ? "not automated" : b ? "yes" : "NO");

export function build(wallets: Record<string, any>, packages: Record<string, any>, names: Record<string, string>, live: any | null, reference: { party: string; fingerprint: string }, notes: Record<string, string> = {}) {
  const rows: Row[] = Object.keys(names).map((id) => {
    const r = wallets[id], p = packages[id] ?? r?.package ?? null;
    const base = { id, name: names[id]!, version: p?.versionName ?? p?.version, source: p?.source, downloadUrl: p?.packageUrl, sha256: p?.sha256, ...(notes[id] ? { notes: notes[id] } : {}) };
    if (!r) return { ...base, status: "not automated", reason: "not run", date: "" } as Row;
    if (r.status !== "tested") return { ...base, status: "not automated", reason: r.reason, date: r.date } as Row;
    return {
      ...base, status: "tested", date: r.date, sameTwice: r.sameTwice, sameAfterRestart: r.sameAfterRestart, matchesReference: r.matchesReference, rawMatchesReference: r.rawMatchesReference,
      form: r.form, normalisedSha256: r.normalisedSha256, fingerprint: r.fingerprint,
      opensLiveBridge: live && (live.firstWallet === id || live.secondWallet === id) && live.sameAccount && live.matchesReference ? "yes" : "not tried",
    } as Row;
  });
  const tested = rows.filter((r) => r.status === "tested");
  const rawOf = (id: string) => wallets[id]?.raw?.twice?.[0];
  for (const r of tested) {
    const others = tested.filter((o) => o !== r);
    r.matchesOtherWallets = others.length === 0 ? "only one wallet tested" : others.every((o) => rawOf(o.id) === rawOf(r.id)) ? "same bytes" : others.every((o) => o.normalisedSha256 === r.normalisedSha256) ? "same after normalising" : "no";
  }
  return { reference: { party: reference.party, fingerprint: reference.fingerprint }, live, wallets: rows };
}

export function table(doc: ReturnType<typeof build>): string {
  const head = "| Wallet | Version | Package source and SHA-256 | Same signature twice | Same after restart | Matches reference | Matches other wallets | Opens on the live Bridge | Date |\n|---|---|---|---|---|---|---|---|---|";
  const lines = doc.wallets.map((r) => {
    const pkg = r.source ? `[package](${r.source}) \`${r.sha256}\`` : "none";
    if (r.status !== "tested") return `| ${r.name} | ${r.version ?? ""} | ${pkg} | not automated | not automated | not automated | not automated | not tried | ${r.date} |`;
    return `| ${r.name} | ${r.version} | ${pkg} | ${yes(r.sameTwice)} | ${yes(r.sameAfterRestart)} | ${yes(r.matchesReference)} | ${r.matchesOtherWallets} | ${r.opensLiveBridge} | ${r.date} |`;
  });
  const stage = (r: Row) => /stopped at "([^"]+)"/.exec(r.reason ?? "")?.[1];
  const reasons = doc.wallets.filter((r) => r.status !== "tested").map((r) => `- ${r.name}: ${r.notes ? `stopped at ${stage(r) ?? "an unknown stage"}. ${r.notes}` : r.reason}`);
  return [head, ...lines, ...(reasons.length ? ["", "Not automated, and why:", ...reasons] : [])].join("\n") + "\n";
}

if (import.meta.main) {
  const read = (f: string) => (existsSync(join(RUN, f)) ? JSON.parse(readFileSync(join(RUN, f), "utf8")) : null);
  const manifest = JSON.parse(readFileSync(join(HERE, "wallets.json"), "utf8")) as { wallets: { id: string; name: string; notes?: string }[] };
  const names = Object.fromEntries(manifest.wallets.map((w) => [w.id, w.name]));
  const notes = Object.fromEntries(manifest.wallets.filter((w) => w.notes).map((w) => [w.id, w.notes!]));
  const live = read("live.json")?.live ?? null;
  const ref = read("reference.json");
  const doc = build(read("results.json") ?? {}, read("packages.json") ?? {}, names, live, ref, notes);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "wallets.json"), JSON.stringify(doc, null, 2) + "\n");
  writeFileSync(join(OUT, "wallets.md"), table(doc));
  console.log(table(doc));
}
