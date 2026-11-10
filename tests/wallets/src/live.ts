// The live check: open the Bridge account on the live DevNet site with one wallet (the faucet's 1 tROME first), close the browser, open it again in a new profile with a second wallet that holds the same key,
// and see that it reaches the same Canton account. Usage: node src/live.ts <first wallet> <second wallet>
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { clickFirst, describe, DEBUG, launch, log, sleep, withApprovals } from "./browser.ts";
import { drivers, type Driver } from "./drivers.ts";
import { reference, RUN, seed } from "./lib.ts";

const SITE = process.env.LIVE_SITE ?? "https://ostia.devnet.romeprotocol.xyz";
const [firstId, secondId] = [process.argv[2] ?? "metamask", process.argv[3] ?? "rabby"];
const ref = await reference();
const resultsFile = join(RUN, "live.json");
const WALLET_IDS = Object.keys(drivers);
if (!WALLET_IDS.includes(firstId) || !WALLET_IDS.includes(secondId) || firstId === secondId) throw new Error("name two different wallets this harness can drive");
const out: Record<string, unknown> = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, "utf8")) : {};

/** One visit: a fresh profile, the wallet set up with the seed, the live Bridge page, sign in; returns the account the page opened. */
async function visit(d: Driver, tag: string): Promise<{ party: string | null; shown: string; steps: string[] }> {
  const profile = join(RUN, "profiles", `live-${tag}-${d.id}`);
  rmSync(profile, { recursive: true, force: true });
  const { ctx, extId } = await launch(d.id, profile);
  const steps: string[] = [];
  try {
    await d.onboard(ctx, extId, seed());
    const page = await ctx.newPage();
    let party: string | null = null;
    page.on("response", async (r) => {
      if (r.url().includes("/accounts/v1/topology") && r.request().method() === "POST") {
        const j = (await r.json().catch(() => null)) as { party?: string } | null;
        if (j?.party) party = j.party;
      }
    });
    const approve = <T>(label: string, f: () => Promise<T>) => withApprovals(ctx, extId, d.popup, d.openRequests ? () => d.openRequests!(ctx, extId) : null, d.approve, f, `${tag} ${label}`, 500);
    await page.goto(`${SITE}/bridge`, { waitUntil: "domcontentloaded" });
    await sleep(4000);
    // The page's own steps, in the order a person meets them: connect, switch to the chain, the faucet's coin, sign in. Each is clicked when it is there; the wallet's pop-ups are approved meanwhile.
    const steps_: [string, RegExp][] = [
      ["connect", /^connect (metamask|wallet|browser wallet)/i],
      ["faucet", /^get (test )?[0-9.]* ?trome/i],
      ["open account sheet", /^open my canton account$/i],
      ["sign in", /^sign in with/i],
    ];
    const end = Date.now() + 420_000;
    let account: string | null = null;
    let shown = "";
    const once = new Set<string>();   // the faucet is asked once
    await approve("flow", async () => {
    // the chain: the API page's button adds it to the wallet (the same call the site makes), and the wallet then switches to it
    await page.goto(`${SITE}/docs/api`, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    if (await clickFirst(page, [/^add ostia to your wallet/i], ["button"])) { steps.push("add the network"); log(tag, "clicked add the network"); }
    await sleep(8000);
    while (Date.now() < end && !account) {
      for (const [label, re] of steps_) {
        if (once.has(label)) continue;
        if (!page.url().includes("/bridge")) await page.goto(`${SITE}/bridge`, { waitUntil: "domcontentloaded" });
        const clicked = await clickFirst(page, [re], ["button"]);
        if (clicked) await sleep(3000);
        if (clicked) { steps.push(label); log(tag, "clicked", label); if (label === "faucet" || label === "open account sheet" || label === "add the network") once.add(label); }
      }
      // the account's name on the page: "Your account on Canton" with the party, once it is open
      const body = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).replace(/\s+/g, " ");
      const m = /Your account on Canton\s+(rome::1220[0-9a-f]+…[0-9a-f]+)/i.exec(body);   // shown only when the account is open
      if (DEBUG) { const k = body.indexOf("Move Activity"); log(tag, "page", body.slice(k < 0 ? 0 : k, (k < 0 ? 0 : k) + 900)); }
      if (party && m) { account = party; shown = m[1]!; break; }
      await sleep(2500);
    }
    });
    return { party: account, shown, steps };
  } finally { await ctx.close(); }
}

const first = await visit(drivers[firstId]!, "first");
log("first wallet", firstId, "opened", first.shown);
await sleep(3000);
const second = await visit(drivers[secondId]!, "second");
log("second wallet", secondId, "opened", second.shown);
const lead = (shown: string, party: string | null) => party !== null && shown.length > 0 && party.startsWith(shown.split("…")[0]!) && party.endsWith(shown.split("…")[1]!);
out.live = {
  date: new Date().toISOString().slice(0, 10), site: SITE, firstWallet: firstId, secondWallet: secondId,
  firstParty: first.party, secondParty: second.party,
  firstShownMatches: lead(first.shown, first.party), secondShownMatches: lead(second.shown, second.party),
  sameAccount: first.party !== null && first.party === second.party,
  matchesReference: first.party === ref.party && second.party === ref.party,
  steps: { first: first.steps, second: second.steps },
};
writeFileSync(resultsFile, JSON.stringify(out, null, 2) + "\n");
log("live result", JSON.stringify(out.live));
process.exit(0);
