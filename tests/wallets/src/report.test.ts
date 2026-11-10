// Tests of what needs no browser: the report's table and cross-wallet comparison, and the manifest. Run: node --experimental-transform-types --test src/report.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { build, table } from "./report.ts";
import { HERE } from "./paths.ts";

const names = { a: "Wallet A", b: "Wallet B", c: "Wallet C" };
const raw = (h: string) => ({ twice: [h, h], afterRestart: [h, h] });
const ok = (norm: string, rawHash: string) => ({ status: "tested", date: "2026-01-01", sameTwice: true, sameAfterRestart: true, matchesReference: true, normalisedSha256: norm, raw: raw(rawHash), form: { v: "0x1b", lowS: true } });
const liveOf = (over: object = {}) => ({ date: "2026-01-01", referenceFingerprint: "1220ab", firstWallet: "a", secondWallet: "b", firstParty: "rome::1220ab", secondParty: "rome::1220ab", sameAccount: true, matchesReference: true, ...over });
const packages = { a: { versionName: "1.0", source: "https://example.test/a.zip", sha256: "aa" }, b: { version: "2", source: "https://example.test/b.zip", sha256: "bb" }, c: { version: "3", source: "https://example.test/c.zip", sha256: "cc" } };
const ref = { party: "rome::1220ab", fingerprint: "1220ab" };

test("wallets with the same bytes match each other; a wallet that was not automated is listed with its reason", () => {
  const doc = build({ a: ok("n", "r"), b: ok("n", "r"), c: { status: "not automated", reason: "no approval screen", date: "2026-01-01" } }, packages, names, null, ref);
  assert.equal(doc.wallets[0]!.matchesOtherWallets, "same bytes");
  assert.equal(doc.wallets[2]!.status, "not automated");
  const md = table(doc);
  assert.match(md, /\| Wallet C \| 3 \|.*\| not automated \|/);
  assert.match(md, /- Wallet C: no approval screen/);
  const noted = table(build({ c: { status: "not automated", reason: 'stopped at "run 1: connect": x', date: "2026-01-01" } }, packages, { c: "Wallet C" }, null, ref, { c: "It opened nothing." }));
  // the run's own reason is printed, and the manifest's note only after it, as earlier findings
  assert.match(noted, /- Wallet C: stopped at "run 1: connect": x\. Earlier attempts found: It opened nothing\./);
});

test("the same signature in another form is reported as such, and a different one as no", () => {
  const form = build({ a: ok("n", "r1"), b: ok("n", "r2"), c: ok("m", "r3") }, packages, names, null, ref);
  assert.equal(form.wallets[0]!.matchesOtherWallets, "no");
  const two = build({ a: ok("n", "r1"), b: ok("n", "r2") }, packages, { a: "A", b: "B" }, null, ref);
  assert.equal(two.wallets[0]!.matchesOtherWallets, "same after normalising");
});

test("a wallet opens the live Bridge only when the live check names it and both wallets reached the reference account", () => {
  const live = liveOf();
  const doc = build({ a: ok("n", "r"), b: ok("n", "r"), c: ok("n", "r") }, packages, names, live, ref);
  assert.deepEqual(doc.wallets.map((r) => r.opensLiveBridge), ["yes", "yes", "not tried"]);
  const bad = build({ a: ok("n", "r"), b: ok("n", "r") }, packages, { a: "A", b: "B" }, { ...live, sameAccount: false }, ref);
  // a live check that ran and reached different accounts is a finding: "no", not "not tried"
  assert.deepEqual(bad.wallets.map((r) => r.opensLiveBridge), ["no", "no"]);
  const other = build({ a: ok("n", "r"), b: ok("n", "r") }, packages, { a: "A", b: "B" }, { ...live, matchesReference: false }, ref);
  assert.deepEqual(other.wallets.map((r) => r.opensLiveBridge), ["no", "no"]);
  // a check that reached no account (the faucet or a screen failed) is incomplete, not a finding about the wallets
  const none = build({ a: ok("n", "r"), b: ok("n", "r") }, packages, { a: "A", b: "B" }, { ...live, secondParty: null, sameAccount: false, matchesReference: false }, ref);
  assert.deepEqual(none.wallets.map((r) => r.opensLiveBridge), ["incomplete", "incomplete"]);
});

test("a wallet that was not run now keeps its committed row, and one that never had a result is 'not run', not 'not automated'", () => {
  const before = build({ a: ok("n", "r"), b: ok("n", "r") }, packages, { a: "A", b: "B", c: "C" }, liveOf(), ref);
  const after = build({ b: { ...ok("n", "r"), date: "2026-02-02" } }, { b: packages.b }, { a: "A", b: "B", c: "C" }, null, ref, {}, before, { c: "cc" });
  const [a, b, c] = after.wallets;
  assert.deepEqual(a, before.wallets[0]);   // untouched: version, SHA-256, date and live result stay
  assert.equal(b!.date, "2026-02-02");
  assert.equal(b!.opensLiveBridge, "yes");   // same package as when the live check ran
  assert.equal(c!.status, "not run");
  assert.equal(c!.sha256, "cc");
  assert.equal(after.live, before.live);
  const md = table(after);
  assert.match(md, /\| C \| .*\| not run \| not run \| not run \| not run \| not tried \|/);
  assert.doesNotMatch(md, /stopped at an unknown stage/);
  // another package than the one the live check was made with: the earlier result no longer stands
  const changed = build({ b: ok("n", "r") }, { b: { ...packages.b, sha256: "new" } }, { a: "A", b: "B", c: "C" }, null, ref, {}, before);
  assert.equal(changed.wallets[1]!.opensLiveBridge, "not tried");
  // the carried rows are compared with the new one by their stored hashes, when the same run made them
  assert.equal(changed.wallets[0]!.matchesOtherWallets, "same bytes");
  // a wallet tested in a later run (a new throwaway seed, another reference) is not compared with the rows of the earlier run
  const later = build({ b: ok("other", "r2") }, { b: packages.b }, { a: "A", b: "B", c: "C" }, null, { party: "rome::1220cd", fingerprint: "1220cd" }, {}, before);
  assert.equal(later.wallets[1]!.matchesOtherWallets, "only one wallet tested");
  assert.equal(later.wallets[0]!.matchesOtherWallets, "same bytes");   // a keeps what its own run found
});

test("the manifest pins every GitHub release by tag and names every Chrome Web Store extension by its id", () => {
  const m = JSON.parse(readFileSync(join(HERE, "wallets.json"), "utf8")) as { wallets: { id: string; source: { kind: string; tag?: string; asset?: string; extensionId?: string }; sha256: string | null }[] };
  assert.equal(new Set(m.wallets.map((w) => w.id)).size, m.wallets.length);
  for (const w of m.wallets) {
    if (w.source.kind === "github") assert.ok(w.source.tag && w.source.asset, w.id);
    else assert.match(w.source.extensionId ?? "", /^[a-p]{32}$/, w.id);
    assert.match(w.sha256 ?? "", /^[0-9a-f]{64}$/, `${w.id} has a pinned SHA-256`);
  }
});

test("a verdict of the live check is shown with the day it was made, and a rerun without it keeps that day, not the new run's", () => {
  const before = build({ a: ok("n", "r"), b: ok("n", "r") }, packages, { a: "A", b: "B" }, liveOf(), ref);
  assert.deepEqual([before.wallets[0]!.liveDate, before.wallets[0]!.liveReference], ["2026-01-01", "1220ab"]);
  assert.match(table(before), /\| yes \(2026-01-01\) \| 2026-01-01 \|/);
  // the same package rerun later without the live check: the date of the run is new, the live verdict is the old one with its own day
  const later = build({ a: { ...ok("n", "r"), date: "2026-03-03" } }, { a: packages.a }, { a: "A", b: "B" }, null, { party: "rome::1220cd", fingerprint: "1220cd" }, {}, before);
  assert.equal(later.wallets[0]!.date, "2026-03-03");
  assert.equal(later.wallets[0]!.liveDate, "2026-01-01");
  assert.equal(later.wallets[0]!.liveReference, "1220ab");
  assert.match(table(later), /\| yes \(2026-01-01\) \| 2026-03-03 \|/);
  // a wallet that was not live-checked has no day
  assert.match(table(build({ c: ok("n", "r") }, packages, { c: "C" }, null, ref)), /\| not tried \| 2026-01-01 \|/);
});

test("a wallet whose first address is not the seed's is marked, not read as a signing difference; the browser is carried and printed", () => {
  const other = { ...ok("m", "r9"), matchesReference: false, addressIsReference: false, browser: { image: "img@sha256:aa", chromium: "131.0.1" } };
  const doc = build({ a: ok("n", "r"), b: other }, packages, { a: "A", b: "B" }, null, ref);
  assert.equal(doc.wallets[1]!.addressIsReference, false);
  assert.deepEqual(doc.wallets[1]!.browser, { image: "img@sha256:aa", chromium: "131.0.1" });
  const md = table(doc);
  assert.match(md, /\| B \| 2 \|.*\| NO \(another first address\) \|/);
  assert.match(md, /- B: its first account is not the throwaway seed's first account/);
  assert.match(md, /Browser: Chromium 131\.0\.1 in img@sha256:aa\./);
});

test("a note on a wallet that was tested is printed under the table", () => {
  assert.match(table(build({ a: ok("n", "r") }, packages, { a: "A" }, null, ref, { a: "Run it again if it stops." })), /Notes on the wallets that were tested:\n- A: Run it again if it stops\./);
});

test("the table's file says what is not covered", () => {
  assert.match(table(build({ a: ok("n", "r") }, packages, { a: "A" }, null, ref)), /Not covered: hardware wallets \(Ledger, Trezor\) and smart-contract wallets.*\(\.\.\/README\.md#not-covered\)/);
});

test("a live check that reached no account does not replace an earlier one that did: the rows keep its verdict and day, and the attempt is recorded beside it", () => {
  // the earlier check was made before checks named their reference: it matched, so its accounts are the reference's
  const { referenceFingerprint, ...old } = liveOf();
  const before = build({ a: ok("n", "r"), b: ok("n", "r") }, packages, { a: "A", b: "B" }, old, ref);
  assert.equal(before.live.referenceFingerprint, undefined);
  const stopped = { date: "2026-02-02", site: "https://site.test", referenceFingerprint: "1220cd", browser: { image: "i", chromium: "1" }, firstWallet: "a", secondWallet: "b", firstParty: null, secondParty: null, sameAccount: false, matchesReference: false, errors: { first: "the account service refused (429)", second: "not run" } };
  const after = build({ a: { ...ok("n", "r"), date: "2026-02-02" }, b: { ...ok("n", "r"), date: "2026-02-02" } }, packages, { a: "A", b: "B" }, stopped, { party: "rome::1220cd", fingerprint: "1220cd" }, {}, before);
  assert.deepEqual(after.wallets.map((r) => r.opensLiveBridge), ["yes", "yes"]);
  assert.deepEqual(after.wallets.map((r) => r.liveDate), ["2026-01-01", "2026-01-01"]);
  assert.deepEqual(after.wallets.map((r) => r.liveReference), ["1220ab", "1220ab"]);   // the reference the old check was made against, not the new run's
  assert.equal(after.live.firstParty, "rome::1220ab");
  assert.equal(after.live.referenceFingerprint, "1220ab");
  assert.equal(after.liveAttempt.errors.first, "the account service refused (429)");
  assert.equal(after.liveAttempt.date, "2026-02-02");
  assert.match(table(after), /\| yes \(2026-01-01\) \| 2026-02-02 \|/);
  assert.match(table(after), /The live check \(2026-01-01\) was made with the throwaway account of an earlier run \(`1220ab…`\), not this run's \(`1220cd…`\)/);
  assert.match(table(after), /A later live check \(2026-02-02\) reached no account: the account service refused \(429\)\./);
  // a package that changed since does not keep the verdict
  const changed = build({ a: ok("n", "r") }, { a: { ...packages.a, sha256: "new" } }, { a: "A", b: "B" }, stopped, ref, {}, before);
  assert.equal(changed.wallets[0]!.opensLiveBridge, "not tried");
});

test("a run with no live result carries the earlier attempt forward; a live check that reached accounts drops it", () => {
  const { referenceFingerprint, ...old } = liveOf();
  const before = build({ a: ok("n", "r"), b: ok("n", "r") }, packages, { a: "A", b: "B" }, old, ref);
  const stopped = { date: "2026-02-02", site: "https://site.test", referenceFingerprint: "1220cd", browser: { image: "i", chromium: "1" }, firstWallet: "a", secondWallet: "b", firstParty: null, secondParty: null, sameAccount: false, matchesReference: false, errors: { first: "refused (429)", second: "not run" } };
  const attempted = build({ a: ok("n", "r") }, packages, { a: "A", b: "B" }, stopped, ref, {}, before);
  const noLive = build({ a: { ...ok("n", "r"), date: "2026-02-03" } }, packages, { a: "A", b: "B" }, null, ref, {}, attempted);
  assert.equal(noLive.liveAttempt.date, "2026-02-02");
  assert.equal(noLive.liveAttempt.errors.first, "refused (429)");
  const reached = build({ a: ok("n", "r"), b: ok("n", "r") }, packages, { a: "A", b: "B" }, liveOf({ date: "2026-02-04" }), ref, {}, noLive);
  assert.equal(reached.liveAttempt, undefined);
});

test("a live check without refusedSignatures is noted as made before the signing guard; one with it is not", () => {
  const old = build({ a: ok("n", "r"), b: ok("n", "r") }, packages, { a: "A", b: "B" }, liveOf(), ref);
  assert.match(table(old), /The live check \(2026-01-01\) was made by an earlier version of the harness, before the signing guard/);
  const guarded = build({ a: ok("n", "r"), b: ok("n", "r") }, packages, { a: "A", b: "B" }, liveOf({ refusedSignatures: { first: 0, second: 0 } }), ref);
  assert.doesNotMatch(table(guarded), /earlier version of the harness/);
});
