// Debug helper: opens a wallet and prints what each of its pages (and their frames) shows, every two seconds. Usage: node src/probe.ts <wallet> [rounds] [path to open]
import { launch, describe, sleep, log } from "./browser.ts";
import { join } from "node:path";
import { RUN } from "./lib.ts";
const id = process.argv[2]!;
const { ctx, extId } = await launch(id, join(RUN, "profiles", "probe-" + id));
log("extension", extId);
if (process.argv[4]) { const p = await ctx.newPage(); await p.goto(`chrome-extension://${extId}/${process.argv[4]}`); }
for (let i = 0; i < Number(process.argv[3] ?? 8); i++) {
  for (const p of ctx.pages()) {
    if (p.url() === "about:blank") continue;
    log("page", p.url().slice(0, 100), "|", (await describe(p)).slice(0, 400));
    for (const f of p.frames()) if (f !== p.mainFrame()) log("  frame", f.url().slice(0, 100), (await f.locator("body").innerText({ timeout: 1500 }).catch(() => "?")).replace(/\s+/g, " ").slice(0, 200));
  }
  await sleep(2500);
}
await ctx.close();
process.exit(0);
