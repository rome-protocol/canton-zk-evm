// The harness: for each wallet, set it up with the throwaway seed, ask for the Bridge's signature twice, close the browser, reopen the same profile, ask again, and write down what came back.
// Usage: node src/run.ts [wallet ...]   (all of drivers.ts when none is named). Results go to run/results.json; report.ts makes the committed files from them.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { DEBUG, launch, log, sleep, withApprovals } from "./browser.ts";
import { drivers } from "./drivers.ts";
import { fingerprintOf, form, normaliseSignature, reference, RUN, scrub, seed, sha256hex, TYPED_JSON } from "./lib.ts";
import { startServer } from "./server.ts";

const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const { servers, origin, chain, spki } = await startServer();
const secret = seed();
const ref = await reference();
const packages = existsSync(join(RUN, "packages.json")) ? JSON.parse(readFileSync(join(RUN, "packages.json"), "utf8")) : {};
const resultsFile = join(RUN, process.env.RESULTS_FILE ?? "results.json");
const results: Record<string, unknown> = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, "utf8")) : {};
mkdirSync(join(RUN, "profiles"), { recursive: true });

/** One call of the page's API, started by a real click (some wallets open their pop-up only for a click, as they do for a person). */
const call = async (pg: Page, name: string, args: unknown[]): Promise<any> => {
  await pg.evaluate(([n, a]) => (window as any).arm(n, a), [name, args] as const);
  await pg.click("#go");
  return pg.evaluate(() => (window as any).result);
};
const hashOf = (raw: string) => sha256hex(Buffer.from(raw.slice(2), "hex"));

for (const id of ids.length ? ids : Object.keys(drivers)) {
  const d = drivers[id];
  if (!d) { log(`${id}: no driver`); continue; }
  const profile = join(RUN, "profiles", id);
  rmSync(profile, { recursive: true, force: true });
  const out: Record<string, unknown> = { id, package: packages[id] ?? null, date: new Date().toISOString().slice(0, 10) };
  let ctx: BrowserContext | null = null;
  let stage = "start";
  try {
    // 1. a fresh profile: set the wallet up, connect, add the chain, sign twice
    stage = "start the browser"; let started = await launch(id, profile, spki); ctx = started.ctx;
    stage = "set the wallet up with the seed"; await d.onboard(ctx, started.extId, secret);
    log(id, "set up");
    const ask = async (what: string) => {
      const { ctx: c, extId } = started;
      const pg = await c.newPage();
      await pg.goto(origin);
      if (what === "run 1") out.providers = await pg.evaluate(() => (window as any).api.providers());
      const work = <T>(label: string, f: () => Promise<T>) => withApprovals(c, extId, d.popup, d.openRequests ? () => d.openRequests!(c, extId) : null, d.approve, f, `${what} ${label}`);
      const addChain = async () => { stage = `${what}: add the chain`; await work("chain", () => call(pg, "addChain", [d.rdns, chain])); };
      // Some wallets give a site permission only for the chains the wallet has when it connects: the chain is added first.
      if (d.chainFirst) await addChain();
      stage = `${what}: connect`;
      const accounts: string[] = await work("connect", () => call(pg, "connect", [d.rdns]));
      const address = accounts[0]!;
      if (!d.chainFirst) await addChain();
      const sigs: string[] = [];
      for (let i = 0; i < 2; i++) { stage = `${what}: sign ${i + 1}`; sigs.push(await work(`sign ${i + 1}`, () => call(pg, "sign", [d.rdns, address, TYPED_JSON]))); }
      return { address, sigs };
    };
    const first = await ask("run 1");
    out.address = first.address;
    out.addressIsReference = first.address.toLowerCase() === ref.address.toLowerCase();
    log(id, "signed twice", first.sigs[0] === first.sigs[1] ? "same" : "DIFFERENT");
    // 2. close the browser, reopen the same profile (the wallet is locked again), ask again
    await ctx.close(); ctx = null;
    await sleep(1500);
    stage = "reopen the profile"; started = await launch(id, profile, spki); ctx = started.ctx;
    stage = "unlock the wallet"; await d.unlock(ctx, started.extId, secret);
    const second = await ask("run 2");
    const all = [...first.sigs, ...second.sigs];
    out.raw = { twice: first.sigs.map(hashOf), afterRestart: second.sigs.map(hashOf) };
    out.sameTwice = first.sigs[0] === first.sigs[1];
    out.sameAfterRestart = all.every((s) => s === first.sigs[0]);
    out.form = form(first.sigs[0]!);
    const n = normaliseSignature(first.sigs[0]!);
    out.normalisedSha256 = hashOf(n);
    out.rawMatchesReference = first.sigs[0]!.toLowerCase() === ref.signature.toLowerCase();
    out.matchesReference = n === ref.normalised;
    out.fingerprint = await fingerprintOf(first.sigs[0]!);
    out.status = "tested";
    writeFileSync(join(RUN, `raw-${id}.json`), JSON.stringify({ signatures: all }), { mode: 0o600 });   // the signatures are the Canton key: they stay in the run folder
  } catch (e) {
    out.status = "not automated";
    out.reason = `stopped at "${stage}": ${scrub(String((e as Error).message)).split("\n")[0]!.slice(0, 300)}`;   // a failing screen's text may show the phrase
    log(id, "failed:", out.reason);
  } finally {
    await ctx?.close().catch(() => {});
  }
  results[id] = out;
  writeFileSync(resultsFile, JSON.stringify(results, null, 2) + "\n");
}
servers.forEach((x) => x.close());
process.exit(0);
