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
  assert.match(noted, /- Wallet C: stopped at run 1: connect\. It opened nothing\./);
});

test("the same signature in another form is reported as such, and a different one as no", () => {
  const form = build({ a: ok("n", "r1"), b: ok("n", "r2"), c: ok("m", "r3") }, packages, names, null, ref);
  assert.equal(form.wallets[0]!.matchesOtherWallets, "no");
  const two = build({ a: ok("n", "r1"), b: ok("n", "r2") }, packages, { a: "A", b: "B" }, null, ref);
  assert.equal(two.wallets[0]!.matchesOtherWallets, "same after normalising");
});

test("a wallet opens the live Bridge only when the live check names it and both wallets reached the reference account", () => {
  const live = { firstWallet: "a", secondWallet: "b", sameAccount: true, matchesReference: true };
  const doc = build({ a: ok("n", "r"), b: ok("n", "r"), c: ok("n", "r") }, packages, names, live, ref);
  assert.deepEqual(doc.wallets.map((r) => r.opensLiveBridge), ["yes", "yes", "not tried"]);
  const bad = build({ a: ok("n", "r"), b: ok("n", "r") }, packages, { a: "A", b: "B" }, { ...live, sameAccount: false }, ref);
  assert.deepEqual(bad.wallets.map((r) => r.opensLiveBridge), ["not tried", "not tried"]);
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
