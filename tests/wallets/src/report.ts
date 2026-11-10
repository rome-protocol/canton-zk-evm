// Makes the committed results from a run: results/wallets.json (for machines) and results/wallets.md (the table). Usage: node src/report.ts
// A wallet that was not run in this invocation keeps the row it has in the committed results (with its own date), so a run of one wallet changes one row.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "./paths.ts";

const RUN = join(HERE, "run"), OUT = join(HERE, "results");

export interface Row {
  id: string; name: string; status: "tested" | "not automated" | "not run"; reason?: string;
  version?: string; source?: string; downloadUrl?: string; sha256?: string; notes?: string; date: string;
  /** The first address the wallet gave is the throwaway seed's first account. When it is not (another derivation path), a signature that differs from the reference says nothing about signing. */
  addressIsReference?: boolean;
  /** The browser of the run that tested it: the image (digest) and the Chromium version in it. */
  browser?: { image: string; chromium: string };
  /** The day of the live check behind `opensLiveBridge`, and the reference it was made against (every run makes a new one). */
  liveDate?: string; liveReference?: string;
  sameTwice?: boolean; sameAfterRestart?: boolean; matchesReference?: boolean; rawMatchesReference?: boolean; form?: { v: string; lowS: boolean };
  /** The fingerprint of the throwaway key's reference in the run that tested this wallet. Every run makes a new seed, so wallets are compared with each other only within one run. */
  referenceFingerprint?: string; rawSha256?: string; normalisedSha256?: string; fingerprint?: string; matchesOtherWallets?: "same bytes" | "same after normalising" | "no" | "only one wallet tested";
  /** `yes`/`no`: the live check ran with this wallet and both wallets did / did not reach the reference's account. `incomplete`: it ran but reached no account (the site, the faucet or a screen failed). */
  opensLiveBridge?: "yes" | "no" | "incomplete" | "not tried";
}
export interface Doc { reference: { party: string; fingerprint: string }; live: any | null; /** A live check made after `live` that reached no account (a limit of the site's, a failed screen): it does not replace the check that did. */ liveAttempt?: any; wallets: Row[] }

/** Where the README says what is not covered (the table's file is the one most likely to be linked on its own). */
export const NOT_COVERED = "Not covered: hardware wallets (Ledger, Trezor) and smart-contract wallets, which this harness cannot test (see [Not covered](../README.md#not-covered) in the README), and any wallet or version that is not in the table.";

const yes = (b: boolean | undefined) => (b === undefined ? "not automated" : b ? "yes" : "NO");

/** The day of a live check and the reference it was made against, for the rows that carry its verdict. */
const liveStamp = (live: any): { liveDate?: string; liveReference?: string } => ({ liveDate: live?.date, liveReference: live?.referenceFingerprint });

/** A live check that reached accounts (it says something about the wallets), as against one that stopped before. */
const reachedAccounts = (l: any): boolean => Boolean(l?.firstParty && l?.secondParty);

/** A live check made before the check named its reference: when it matched the reference, its accounts are the reference's, so the fingerprint is theirs. */
const withReference = (l: any): any => (l && !l.referenceFingerprint && l.matchesReference && l.firstParty ? { ...l, referenceFingerprint: String(l.firstParty).split("::")[1] } : l);

/** What the live check says of one wallet that it named. */
function liveVerdict(live: any, id: string): Row["opensLiveBridge"] | null {
  if (!live || (live.firstWallet !== id && live.secondWallet !== id)) return null;
  if (!live.firstParty || !live.secondParty) return "incomplete";
  return live.sameAccount && live.matchesReference ? "yes" : "no";
}

/**
 * `wallets` are this run's results by id, `packages` what fetch.ts recorded, `names` every wallet in the manifest (in order), `live` the live check's result if it ran,
 * `notes` the manifest's background on a wallet, `pins` the manifest's SHA-256 by id, and `previous` the committed results to carry the other wallets' rows over from.
 */
export function build(wallets: Record<string, any>, packages: Record<string, any>, names: Record<string, string>, live: any | null, reference: { party: string; fingerprint: string }, notes: Record<string, string> = {}, previous: Doc | null = null, pins: Record<string, string> = {}): Doc {
  // A live check that reached no account does not replace an earlier one that did: the wallets' rows keep that verdict (for the package it was made with), and the attempt is kept beside it.
  const earlier = withReference(previous?.live ?? null);
  const fresh = reachedAccounts(live) ? live : null;
  const shown = fresh ?? (reachedAccounts(earlier) ? null : live);
  const rows: Row[] = Object.keys(names).map((id) => {
    const r = wallets[id], p = packages[id] ?? r?.package ?? null, old = previous?.wallets.find((o) => o.id === id);
    const base = { id, name: names[id]!, version: p?.versionName ?? p?.version, source: p?.source, downloadUrl: p?.packageUrl, sha256: p?.sha256 ?? pins[id], ...(notes[id] ? { notes: notes[id] } : {}) };
    if (!r) {
      // not run now: its row from the committed results stands (with its date), and a live check that named it may add to it
      if (old) { const v = liveVerdict(shown, id); return v ? { ...old, opensLiveBridge: v, ...liveStamp(shown) } : old; }
      return { ...base, status: "not run", reason: "not run, and there is no earlier result for it", date: "" } as Row;
    }
    if (r.status !== "tested") return { ...base, status: "not automated", reason: r.reason, date: r.date } as Row;
    // the live check belongs to the package it was made with: an earlier "yes" stands only if this is the same package
    const kept = old?.sha256 && old.sha256 === base.sha256 ? old.opensLiveBridge : undefined;
    const verdict = liveVerdict(shown, id);
    const stamp = verdict ? liveStamp(shown) : kept && kept !== "not tried" ? { liveDate: old?.liveDate ?? earlier?.date, liveReference: old?.liveReference ?? earlier?.referenceFingerprint } : {};
    return {
      ...base, status: "tested", date: r.date, sameTwice: r.sameTwice, sameAfterRestart: r.sameAfterRestart, matchesReference: r.matchesReference, rawMatchesReference: r.rawMatchesReference,
      form: r.form, referenceFingerprint: reference.fingerprint, rawSha256: r.raw?.twice?.[0], normalisedSha256: r.normalisedSha256, fingerprint: r.fingerprint,
      opensLiveBridge: verdict ?? kept ?? "not tried", ...stamp,
      addressIsReference: r.addressIsReference, browser: r.browser,
    } as Row;
  });
  const tested = rows.filter((r) => r.status === "tested");
  for (const r of tested.filter((t) => wallets[t.id]?.status === "tested")) {   // a row carried over keeps the comparison its own run made
    // every run has a new throwaway seed, so the signatures of wallets tested in different runs cannot be compared with each other
    const others = tested.filter((o) => o !== r && o.referenceFingerprint === r.referenceFingerprint);
    const sameRaw = (o: Row) => r.rawSha256 !== undefined && o.rawSha256 !== undefined && o.rawSha256 === r.rawSha256;
    r.matchesOtherWallets = others.length === 0 ? "only one wallet tested" : others.every(sameRaw) ? "same bytes" : others.every((o) => o.normalisedSha256 === r.normalisedSha256) ? "same after normalising" : "no";
  }
  // the live check shown is this run's, else the committed one (its wallets' rows say whether it still stands)
  const attempt = live && live !== shown ? { date: live.date, site: live.site, referenceFingerprint: live.referenceFingerprint, browser: live.browser, errors: live.errors } : undefined;
  return { reference: { party: reference.party, fingerprint: reference.fingerprint }, live: shown ?? earlier ?? null, ...(attempt ? { liveAttempt: attempt } : {}), wallets: rows };
}

/** The live column: the verdict, and the day the live check was made when it is a verdict (the row's date is the day of its own run, which can be later). */
const liveCell = (r: Row): string => (r.opensLiveBridge && r.opensLiveBridge !== "not tried" && r.liveDate ? `${r.opensLiveBridge} (${r.liveDate})` : (r.opensLiveBridge ?? "not tried"));

export function table(doc: Doc): string {
  const head = "| Wallet | Version | Package source and SHA-256 | Same signature twice | Same after restart | Matches reference | Matches other wallets | Opens on the live Bridge | Date |\n|---|---|---|---|---|---|---|---|---|";
  const lines = doc.wallets.map((r) => {
    const pkg = r.source ? `[package](${r.source}) \`${r.sha256}\`` : r.sha256 ? `\`${r.sha256}\`` : "none";
    if (r.status !== "tested") { const s = r.status === "not run" ? "not run" : "not automated"; return `| ${r.name} | ${r.version ?? ""} | ${pkg} | ${s} | ${s} | ${s} | ${s} | ${liveCell(r)} | ${r.date} |`; }
    // a wallet whose first address is not the seed's: its signature differs from the reference because the key is another, not because of how it signs
    const matches = r.addressIsReference === false ? "NO (another first address)" : yes(r.matchesReference);
    return `| ${r.name} | ${r.version} | ${pkg} | ${yes(r.sameTwice)} | ${yes(r.sameAfterRestart)} | ${matches} | ${r.matchesOtherWallets} | ${liveCell(r)} | ${r.date} |`;
  });
  // the run's own reason first; the manifest's background (what earlier attempts found) only as extra context after it
  const end = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
  const reasons = doc.wallets.filter((r) => r.status !== "tested").map((r) => `- ${r.name}: ${end(r.reason ?? "no reason recorded")}${r.notes ? ` Earlier attempts found: ${r.notes}` : ""}`);
  const other = doc.wallets.filter((r) => r.status === "tested" && r.addressIsReference === false).map((r) => `- ${r.name}: its first account is not the throwaway seed's first account, so its signature is not expected to equal the reference's; the signing columns still compare the wallet with itself.`);
  const liveNotes: string[] = [];
  if (doc.live?.referenceFingerprint && doc.live.referenceFingerprint !== doc.reference.fingerprint) liveNotes.push(`The live check (${doc.live.date}) was made with the throwaway account of an earlier run (\`${String(doc.live.referenceFingerprint).slice(0, 16)}…\`), not this run's (\`${doc.reference.fingerprint.slice(0, 16)}…\`); its verdict stands for the package it was made with.`);
  if (doc.liveAttempt) liveNotes.push(`A later live check (${doc.liveAttempt.date}) reached no account: ${end(String(doc.liveAttempt.errors?.first ?? "no reason recorded"))}`);
  const browsers = [...new Set(doc.wallets.filter((r) => r.status === "tested" && r.browser).map((r) => `Chromium ${r.browser!.chromium} in ${r.browser!.image}`))];
  const noted = doc.wallets.filter((r) => r.status === "tested" && r.notes).map((r) => `- ${r.name}: ${end(r.notes!)}`);
  return [head, ...lines, "", NOT_COVERED, ...(noted.length ? ["", "Notes on the wallets that were tested:", ...noted] : []), ...(liveNotes.length ? ["", ...liveNotes] : []), ...(browsers.length ? ["", `Browser: ${browsers.join("; ")}.`] : []), ...(other.length ? ["", "Another first address:", ...other] : []), ...(reasons.length ? ["", "Not automated or not run, and why:", ...reasons] : [])].join("\n") + "\n";
}

if (import.meta.main) {
  const read = (f: string) => (existsSync(join(RUN, f)) ? JSON.parse(readFileSync(join(RUN, f), "utf8")) : null);
  const manifest = JSON.parse(readFileSync(join(HERE, "wallets.json"), "utf8")) as { wallets: { id: string; name: string; notes?: string; sha256?: string | null }[] };
  const names = Object.fromEntries(manifest.wallets.map((w) => [w.id, w.name]));
  const notes = Object.fromEntries(manifest.wallets.filter((w) => w.notes).map((w) => [w.id, w.notes!]));
  const pins = Object.fromEntries(manifest.wallets.filter((w) => w.sha256).map((w) => [w.id, w.sha256!]));
  const live = read("live.json")?.live ?? null;
  const ref = read("reference.json");
  const committed = join(OUT, "wallets.json");
  const previous = existsSync(committed) ? (JSON.parse(readFileSync(committed, "utf8")) as Doc) : null;
  const doc = build(read("results.json") ?? {}, read("packages.json") ?? {}, names, live, ref, notes, previous, pins);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(committed, JSON.stringify(doc, null, 2) + "\n");
  writeFileSync(join(OUT, "wallets.md"), table(doc));
  console.log(table(doc));
}
