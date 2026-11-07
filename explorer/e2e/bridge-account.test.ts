import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { fromBase64 } from "../src/bridge/canton/key.ts";
import { partyOf } from "../src/bridge/canton/topology.ts";

/**
 * The Bridge page in a real browser: the built pages (BRIDGE_E2E_DIST, built with the VITE_* settings of the job, VITE_SITE_ORIGIN being the origin below), a wallet that signs with a fixed key, and a fake account service. It runs only when
 * BRIDGE_E2E_DIST is set (the `bridge-page` job of .github/workflows/explorer.yml does), with PLAYWRIGHT_CORE naming the playwright-core of explorer/test/l4. The account opens and shows Ready,
 * the requests it signed are checked against its key, and the signing code is loaded only when the person signs in.
 */
const dist = process.env.BRIDGE_E2E_DIST;
const PORT = 4173, ORIGIN = `http://127.0.0.1:${PORT}`;
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
const STATUS = {
  chainId: 770101, chainName: "Ostia", networkName: "DevNet", coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: "0x" + "cd".repeat(32), rootC: "0x" + "cd".repeat(32), file: "session.txt" },
  ok: true, starting: false, problems: [], evm: true, canton: true, final: null, proving: null, latest: [], signers: null, faucet: { on: true }, publicRpc: true, indexHead: 1, indexLag: 0, deriveCursor: 1, chainInstance: "i1",
};

const body = (req: IncomingMessage) => new Promise<string>((done) => { let t = ""; req.on("data", (c) => (t += c)); req.on("end", () => done(t)); });

describe.skipIf(!dist)("the Bridge page, in a browser", () => {
  const wallet = privateKeyToAccount("0x" + "11".repeat(32));
  const seen = { topologies: [] as Uint8Array[], prepares: [] as { path: string; body: string; header: string }[], signRequests: 0 };
  let server: Server, browser: any, party = "";

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const path = new URL(req.url!, ORIGIN).pathname;
      const json = (status: number, answer: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); };
      if (path === "/api/status") return json(200, STATUS);
      if (path === "/api/faucet") return json(200, { on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 1 });
      if (path === "/api/twins") return json(200, { through: 1, registryService: null, vaults: [], twins: [], legs: [], canton: [] });
      if (path === "/accounts/v1/topology") {
        const publicKey = fromBase64(JSON.parse(await body(req)).publicKey);
        seen.topologies.push(publicKey);
        party = await partyOf(publicKey);
        return json(200, { party, exists: true });   // an account that is there already: the page needs no signature of the account's own
      }
      if (path === "/accounts/v1/prepare") {
        seen.prepares.push({ path, body: await body(req), header: String(req.headers["x-account-signature"] ?? "") });
        return json(409, { error: "the account has the open contracts it may" });   // the two acceptances are there already
      }
      if (path.startsWith("/api/") || path.startsWith("/accounts/")) return json(404, { error: "Not found." });
      let file = join(resolve(dist!), path);
      if (!existsSync(file) || !statSync(file).isFile()) file = join(resolve(dist!), "index.html");
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    });
    await new Promise<void>((done) => server.listen(PORT, "127.0.0.1", done));
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await new Promise((done) => server?.close(done)); });

  /** A page at the width of a phone, with the wallet: the fixed key signs in this process and the page asks it through a binding. */
  async function open(path: string) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const scripts: string[] = [];
    page.on("response", (r: any) => { if (r.request().resourceType() === "script") scripts.push(new URL(r.url()).pathname); });
    await page.exposeFunction("__wallet", async (method: string, params: any[]) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [wallet.address];
      if (method === "eth_chainId") return "0x" + (770101).toString(16);
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "eth_signTypedData_v4") {
        seen.signRequests++;
        const { domain, types, primaryType, message } = JSON.parse(params[1]);
        delete types.EIP712Domain;
        return wallet.signTypedData({ domain, types, primaryType, message });
      }
      throw new Error(`the wallet was asked ${method}`);
    });
    await page.addInitScript(() => { (window as any).ethereum = { request: ({ method, params }: any) => (window as any).__wallet(method, params ?? []), on() {}, removeListener() {} }; });
    await page.goto(ORIGIN + path, { waitUntil: "load" });
    return { page, scripts };
  }

  it("opens the account from one signature and shows it Ready, loading the signing code only when the person signs in", async () => {
    const home = await open("/");
    await home.page.waitForLoadState("networkidle");
    expect(home.scripts.filter((s) => /\/(Bridge|account)-/.test(s))).toEqual([]);   // the home page carries none of the bridge
    await home.page.close();

    const { page, scripts } = await open("/bridge");
    await page.getByRole("button", { name: "Connect MetaMask" }).click();
    await page.getByText(ORIGIN, { exact: true }).waitFor();   // the site's origin, beside the sign-in
    expect(scripts.some((s) => /\/Bridge-/.test(s))).toBe(true);
    expect(scripts.some((s) => /\/account-/.test(s))).toBe(false);
    await page.getByRole("button", { name: "Sign in MetaMask" }).click();
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
    expect(scripts.some((s) => /\/account-/.test(s))).toBe(true);

    expect(await page.getByRole("button", { name: "Copy account id" }).count()).toBe(1);
    expect(await page.getByTitle(party).count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);   // no sideways scroll at phone width
    await page.close();

    // One signature of the wallet made the key, and the account service saw the key's own signature on each request it was sent.
    expect(seen.signRequests).toBe(1);
    expect(seen.topologies).toHaveLength(1);
    expect(seen.topologies[0]!.length).toBe(32);
    expect(seen.prepares).toHaveLength(2);   // the twin acceptance and the withdrawal acceptance
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, seen.topologies[0]!]), format: "der", type: "spki" });
    for (const p of seen.prepares) {
      const dot = p.header.indexOf("."), seconds = p.header.slice(0, dot);
      const message = `accounts-v1\nPOST\n${p.path}\n${createHash("sha256").update(p.body).digest("hex")}\n${seconds}`;
      expect(verify(null, Buffer.from(message), key, Buffer.from(p.header.slice(dot + 1), "base64"))).toBe(true);
      expect(JSON.parse(p.body).party).toBe(party);
    }
  }, 90_000);
});
