// Walks a wallet's own screens (onboarding, unlock) with a list of button names, filling the seed and the password where the screen asks. The seed and the password are typed into fields, never printed.
import type { Page } from "playwright-core";
import { clickFirst, describe, DEBUG, log, sleep, type Root } from "./browser.ts";

export interface Secret { mnemonic: string; unlock: string }

/** Fills every visible password field, the seed (as one field, or as one field per word), and ticks every visible unticked checkbox. Says whether it changed anything. */
export async function fillAndTick(page: Root, s: Secret): Promise<boolean> {
  let did = false;
  const words = s.mnemonic.split(" ");
  // The seed as one field per word: twelve or more visible fields that are about the seed (in the order they are drawn)
  const numbered = page.locator("input:visible");
  const total = await numbered.count().catch(() => 0);
  const byWord: { i: number; f: ReturnType<typeof numbered.nth> }[] = [];
  for (let k = 0; k < Math.min(total, 40); k++) {
    const f = numbered.nth(k);
    if (/(word|phrase|seed|srp|recovery)/i.test((await f.getAttribute("data-testid").catch(() => "")) || "")) byWord.push({ i: k, f });
  }
  if (byWord.length >= words.length) {
    byWord.sort((a, b) => a.i - b.i);
    for (let k = 0; k < words.length; k++) { await byWord[k]!.f.fill(words[k]!); }
    did = true;
  } else {
    const one = page.locator('textarea:visible, input:visible:not([type="checkbox"]):not([type="password"]):not([type="radio"]):not([type="submit"]), input[type="password"][placeholder*="hrase" i]:visible, input[type="password"][placeholder*="eed" i]:visible');
    const n = await one.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const f = one.nth(i);
      const ph = ((await f.getAttribute("placeholder").catch(() => "")) || "") + ((await f.getAttribute("data-testid").catch(() => "")) || "") + ((await f.getAttribute("aria-label").catch(() => "")) || "") + ((await f.getAttribute("name").catch(() => "")) || "");
      if (/phrase|seed|mnemonic|srp|secret|recovery/i.test(ph) && (await f.inputValue().catch(() => "x")) === "") {
        await f.click({ timeout: 2500 }).catch(() => f.focus());
        // a wallet may warn about scams when the field is focused: that is acknowledged, and the seed typed after it
        await sleep(500);
        const ack = page.getByRole("button", { name: /^acknowledge$/i });
        if (await ack.isVisible().catch(() => false)) { await ack.click().catch(() => {}); await sleep(400); await f.click({ timeout: 2500 }).catch(() => f.focus()); }
        await f.fill("");
        await f.pressSequentially(s.mnemonic, { delay: 8 });
        did = true;
      }
    }
  }
  const pw = page.locator('input[type="password"]:visible');
  const m = await pw.count().catch(() => 0);
  if (m >= words.length) {
    // a screen of one password-type field per word is the seed's, not the password's
    for (let k = 0; k < words.length; k++) { if ((await pw.nth(k).inputValue().catch(() => "x")) === "") { await pw.nth(k).fill(words[k]!); did = true; } }
    return did;
  }
  for (let i = 0; i < m; i++) {
    const f = pw.nth(i);
    const ph = ((await f.getAttribute("placeholder").catch(() => "")) || "") + ((await f.getAttribute("data-testid").catch(() => "")) || "");
    if (/phrase|seed|srp|secret|recovery/i.test(ph)) continue;
    if ((await f.inputValue().catch(() => "x")) === "") { await f.fill(s.unlock); did = true; }
  }
  const user = page.locator('input[type="text"]:visible');
  if (/choose a username/i.test(await page.locator("body").innerText({ timeout: 1500 }).catch(() => "")) && (await user.count().catch(() => 0)) > 0 && (await user.first().inputValue().catch(() => "x")) === "") { await user.first().fill("wst" + Math.floor(Math.random() * 1e9)); did = true; }
  const boxes = page.locator('input[type="checkbox"]');
  const c = await boxes.count().catch(() => 0);
  for (let i = 0; i < c; i++) {
    const b = boxes.nth(i);
    const id = ((await b.getAttribute("data-testid").catch(() => "")) || "") + ((await b.getAttribute("name").catch(() => "")) || "");
    if (/opt-in|metric|marketing|analytic|usage|telemetry/i.test(id)) continue;   // never opt in to data collection
    if (!(await b.isChecked().catch(() => true))) { try { await b.check({ force: true, timeout: 2000 }); did = true; } catch { /* a custom checkbox: its label is clicked below */ } }
  }
  return did;
}

/** Repeats: fill the fields, click the first button of the list that is there, until `done` says the wallet is ready. */
export async function crawl(page: Page, s: Secret, buttons: RegExp[], done: (p: Root) => Promise<boolean>, what: string, seconds = 120, texts: RegExp[] = [], rootOf: (p: Page) => Promise<Root> = async (p) => p, closedIsDone = false): Promise<void> {
  const end = Date.now() + seconds * 1000;
  let last = "";
  while (Date.now() < end) {
    if (page.isClosed()) { if (closedIsDone) return; throw new Error(`${what}: the page closed`); }
    const root = await rootOf(page);
    if (await done(root)) return;
    const filled = await fillAndTick(root, s).catch((e) => { if (DEBUG) log(`[${what}] fill error`, String((e as Error).message).split("\n")[0]!.slice(0, 200)); return false; });
    let clicked = await clickFirst(root, buttons);
    // a choice that is drawn as text and not as a button
    for (const re of clicked ? [] : texts) {
      const t = root.getByText(re).first();
      if (await t.isVisible().catch(() => false)) { try { await t.click({ timeout: 3000 }); clicked = String(re); break; } catch { /* next */ }
      }
    }
    if (DEBUG) { const d = await describe(root); if (d !== last) { last = d; log(`[${what}]`, filled ? "filled" : "", clicked ?? "-", d); } }
    await sleep(clicked || filled ? 600 : 1000);
  }
  throw new Error(`${what}: the wallet did not get ready in ${seconds} s (last screen: ${await describe(await rootOf(page))})`);
}
