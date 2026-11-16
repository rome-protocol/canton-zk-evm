import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../server/csp.ts";

/**
 * The Bridge page of a build without the Bridge account made from a wallet signature (VITE_BRIDGE_ACCOUNT unset, and no participant or party hint in the build: the TestNet shape), in a real browser at the width of a phone.
 * BRIDGE_E2E_DIST names that build. The built pages carry no key derivation, no kept-key store and no account client; the page asks the wallet for no signature and the account service for nothing; the card and the
 * sheet send the person to their own Canton wallet; and a key store that an earlier build of the site left in the browser is deleted. Runs only when BRIDGE_E2E_DIST is set (the `bridge-page` job of
 * .github/workflows/explorer.yml builds the pages again for this test).
 */
const dist = process.env.BRIDGE_E2E_DIST;
const PORT = 4173, ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
const STATUS = {
  chainId: 770101, chainName: "Ostia", networkName: "DevNet", coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: "0x" + "cd".repeat(32), rootC: "0x" + "cd".repeat(32), file: "session.txt" },
  ok: true, starting: false, problems: [], evm: true, canton: true, final: null, proving: null, latest: [], signers: null, faucet: { on: true }, publicRpc: true, indexHead: 1, indexLag: 0, deriveCursor: 1, chainInstance: "i1",
};
const ME = "0x" + "e3".repeat(20);
/** Every file the build made, as text (the pages are scripts, styles and one HTML file). */
const built = (dir: string): { name: string; text: string }[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.(js|css|html)$/.test(e.name)).map((e) => ({ name: join(e.parentPath, e.name).slice(dir.length + 1), text: readFileSync(join(e.parentPath, e.name), "utf8") }));

describe.skipIf(!dist)("the built pages of a build without the Bridge account", () => {
it("has no key derivation, kept-key store or account client in the built pages", () => {
  const files = built(resolve(dist!));
  expect(files.length).toBeGreaterThan(5);
  for (const f of files) {
    expect(f.text, f.name).not.toContain("ostia-bridge canton-key v1");      // the key's derivation (src/bridge/canton/key.ts)
    expect(f.text, f.name).not.toContain("Open my Canton account on Ostia");   // the words of the signature request
    expect(f.text, f.name).not.toContain("accounts-v1");                      // the account service's signed requests (src/bridge/canton/accounts.ts)
  }
  expect(files.map((f) => f.name).filter((n) => /(^|\/)(account|accounts|keystore|send)-[\w-]+\.js$/.test(n))).toEqual([]);
});
});

describe.skipIf(!dist)("the Bridge page without the Bridge account, in a browser", () => {
  const seen = { signRequests: [] as string[], wallet: [] as string[], accountService: [] as string[], faucetPosts: 0 };
  let server: Server, browser: any;
  beforeEach(() => { Object.assign(seen, { signRequests: [], wallet: [], accountService: [], faucetPosts: 0 }); });
  const refused: string[] = [];
  beforeEach(() => { refused.length = 0; });
  afterEach(() => { expect(refused).toEqual([]); });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const path = new URL(req.url!, ORIGIN).pathname;
      const json = (status: number, answer: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); };
      if (path === "/api/status") return json(200, STATUS);
      if (path === "/api/faucet") return json(200, { on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 1 });
      if (path === "/api/twins") return json(200, { through: 1, registryService: null, vaults: [], twins: [], legs: [], canton: [] });
      if (path.startsWith("/accounts/")) { seen.accountService.push(path); return json(404, { error: "Not found." }); }
      if (path.startsWith("/api/")) return json(404, { error: "Not found." });
      let file = join(resolve(dist!), path);
      if (!existsSync(file) || !statSync(file).isFile()) file = join(resolve(dist!), "index.html");
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...(extname(file) === ".html" ? { "content-security-policy": contentSecurityPolicy() } : {}) });
      createReadStream(file).pipe(res);
    });
    await new Promise<void>((done) => server.listen(PORT, "127.0.0.1", done));
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await new Promise((done) => server?.close(done)); });

  /** A page at the width of a phone with a wallet that records what it is asked: any signature is refused and counted. */
  async function open(path: string) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const scripts: string[] = [];
    page.on("response", (r: any) => { if (r.request().resourceType() === "script") scripts.push(new URL(r.url()).pathname); });
    let connected = false;
    await page.exposeFunction("__wallet", async (method: string) => {
      seen.wallet.push(method);
      if (/sign/i.test(method)) { seen.signRequests.push(method); throw new Error("the wallet was asked to sign"); }
      if (method === "eth_requestAccounts") { connected = true; return [ME]; }
      if (method === "eth_accounts") return connected ? [ME] : [];
      if (method === "eth_chainId") return "0x" + (770101).toString(16);
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "eth_getBalance") return "0x" + (5n * 10n ** 18n).toString(16);
      throw new Error(`the wallet was asked ${method}`);
    });
    page.on("console", (m: any) => { if (/content security policy/i.test(m.text())) refused.push(m.text()); });
    await page.addInitScript(() => { (window as any).ethereum = { request: ({ method, params }: any) => (window as any).__wallet(method, params ?? []), on() {}, removeListener() {} }; });
    await page.goto(ORIGIN + path, { waitUntil: "load" });
    return { page, scripts };
  }

  it("sends the person to their own Canton wallet, and asks the wallet for no signature and the account service for nothing", async () => {
    const { page, scripts } = await open("/bridge");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    const card = page.getByRole("region", { name: "Move tokens" });
    expect(await card.getByRole("button", { name: "Open my Canton account" }).count()).toBe(0);
    await card.getByRole("button", { name: "Connect your Canton wallet" }).click();
    const sheet = page.getByRole("region", { name: "Your Canton account" });
    await sheet.getByText("Use the Canton wallet you already have. It shows each Canton step of a move and you approve it there.").waitFor();
    const connect = sheet.getByRole("button", { name: /Connect your Canton wallet/ });
    expect(await connect.isDisabled()).toBe(true);
    expect(await connect.innerText()).toContain("Coming soon");
    const text = await sheet.innerText();
    for (const gone of [/Sign in with your wallet/, /Get test Canton Coin/, /Use a Bridge account/, /You are on/, /No recovery/]) expect(text).not.toMatch(gone);
    expect(await page.getByRole("button", { name: /Sign in with your wallet|Get test Canton Coin|Remove my Canton key/ }).count()).toBe(0);
    const panel = await page.getByRole("region", { name: "Your addresses" }).innerText();
    expect(panel).toContain("Not connected");
    expect(panel).not.toContain("Not opened yet");
    await page.getByRole("tab", { name: "Activity" }).click();
    await page.getByRole("tab", { name: "Move" }).click();
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);   // no sideways scroll at phone width
    await page.close();

    expect(seen.signRequests).toEqual([]);
    expect(seen.accountService).toEqual([]);
    expect(scripts.filter((s) => /\/(account|accounts|keystore|send)-/.test(s))).toEqual([]);
  }, 90_000);

  it("deletes the kept-key store that an earlier build of the site left in the browser", async () => {
    const first = await open("/");   // the site's origin, with a store as an earlier build made it
    await first.page.evaluate(() => new Promise<void>((done, fail) => {
      const r = indexedDB.open("ostia-bridge-canton", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("accounts", { keyPath: "wallet" });
      r.onsuccess = () => { r.result.close(); done(); };
      r.onerror = () => fail(r.error as unknown as Error);
    }));
    expect(await first.page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).toContain("ostia-bridge-canton");
    await first.page.close();

    const { page } = await open("/bridge");
    await page.waitForFunction(async () => !(await indexedDB.databases()).some((d) => d.name === "ostia-bridge-canton"), undefined, { timeout: 15_000 });
    await page.close();
    expect(seen.signRequests).toEqual([]);
  }, 60_000);
});
