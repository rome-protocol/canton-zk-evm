import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { contentSecurityPolicy } from "../server/csp.ts";
import { fakeWallet, WALLET_PARTY } from "../src/bridge/wallet/fake-wallet.ts";
import { lockIdOf } from "../src/bridge/moves/state.ts";
import { allocationFactory, CC_ADMIN, freshChain, GATEWAY, rpcResult, sendTransaction, twinsOverview, txAnswer, VAULT, WCC } from "./bridge-fakes.ts";

/**
 * A move through the Bridge page's card with a connected Canton wallet, in a real browser at 360 px: the pages built with VITE_CANTON_WALLETS=extension (BRIDGE_E2E_DIST names that build, as the other
 * browser tests', which are built without the switch), a fake wallet that announces itself in the page and speaks the dApp standard over the window's messages as a browser extension does (so the real SDK
 * connects it), a fake chain (e2e/bridge-fakes.ts) and a fake account service that has only the public registry route. Canton Coin goes to Ostia: the page opts the wallet's account in, the wallet
 * approves the allocation and the deposit request, and the claim is made in MetaMask. The page asks the account service for nothing signed and the browser wallet for no signature. Runs only when
 * BRIDGE_E2E_DIST is set (the `bridge-page` job of .github/workflows/explorer.yml builds the pages again for this test, with the switch on).
 */
const dist = process.env.BRIDGE_E2E_DIST;
const PORT = 4173, ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
const STATUS = {
  chainId: 770101, chainName: "Ostia", networkName: "DevNet", coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: "0x" + "cd".repeat(32), rootC: "0x" + "cd".repeat(32), file: "session.txt" },
  ok: true, starting: false, problems: [], evm: true, canton: true, final: null, proving: null, latest: [], signers: null, faucet: { on: true }, publicRpc: true, indexHead: 1, indexLag: 0, deriveCursor: 1, chainInstance: "i1",
};
const body = (req: IncomingMessage) => new Promise<string>((done) => { let t = ""; req.on("data", (c) => (t += c)); req.on("end", () => done(t)); });

describe.skipIf(!dist)("the Bridge page's move with a connected Canton wallet, in a browser", () => {
  const metamask = privateKeyToAccount(`0x${"11".repeat(32)}`);
  let chain = freshChain();
  let canton = fakeWallet();
  const seen = { signRequests: 0, factoryAsked: 0, factoryBody: null as any, signedHeader: false, accountService: 0 };
  let server: Server, browser: any;
  beforeEach(() => {
    chain = freshChain();
    canton = fakeWallet();
    canton.holding("20.0000000000", { admin: CC_ADMIN, id: "Amulet" });
    Object.assign(seen, { signRequests: 0, factoryAsked: 0, factoryBody: null, signedHeader: false, accountService: 0 });
  });
  const refused: string[] = [], logs: string[] = [];
  beforeEach(() => { refused.length = 0; });
  afterEach(() => { expect(refused).toEqual([]); });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const path = new URL(req.url!, ORIGIN).pathname;
      const json = (status: number, answer: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); };
      if (path === "/api/status") return json(200, STATUS);
      if (path === "/api/faucet") return json(200, { on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 1 });
      if (path === "/api/twins") return json(200, twinsOverview(`${ORIGIN}/twin-registry`, { wrapped: true }));
      if (path.startsWith("/api/tx/")) { const t = txAnswer(chain, decodeURIComponent(path.slice(8))); return t ? json(200, t) : json(404, { error: "Not found." }); }
      if (path === "/rpc") {
        const call = JSON.parse(await body(req));
        try { return json(200, { jsonrpc: "2.0", id: call.id, result: rpcResult(chain, metamask.address, call.method, call.params ?? []) }); }
        catch (e) { return json(200, { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: (e as Error).message } }); }
      }
      if (path.startsWith("/twin-registry/twin/v1/lock-parts")) {
        const { receiver, ref } = JSON.parse(await body(req));
        chain.lastLock = { receiver, ref, lockId: lockIdOf(receiver, ref) };
        return json(200, { lockId: chain.lastLock.lockId.slice(2), receiver, ref, acceptance: "00" + "ac".repeat(33), vaults: [VAULT] });
      }
      if (path === `/accounts/v1/public-registry/${CC_ADMIN}/allocation-factory`) {   // the one route a wallet's account needs: no signature, no party
        seen.factoryAsked++;
        seen.factoryBody = JSON.parse(await body(req));
        seen.signedHeader ||= req.headers["x-account-signature"] !== undefined;
        return json(200, allocationFactory());
      }
      if (path.startsWith("/accounts/")) { seen.accountService++; return json(404, { error: "Not found." }); }
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

  /** A page at 360 px with MetaMask (the fixed key; the chain's sends go to the fake chain) and the fake Canton wallet that announces itself and answers over the window's messages. */
  async function open(path: string) {
    const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
    let connected = false;
    await page.exposeFunction("__wallet", async (method: string, params: any[]) => {
      if (method === "eth_requestAccounts") { connected = true; return [metamask.address]; }
      if (method === "eth_accounts") return connected ? [metamask.address] : [];
      if (method === "eth_chainId") return "0x" + (770101).toString(16);
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "eth_signTypedData_v4") { seen.signRequests++; throw new Error("User rejected the request."); }   // a Canton wallet needs no signature of MetaMask's
      if (method === "eth_sendTransaction") return sendTransaction(chain, { ...params[0], from: metamask.address });
      return rpcResult(chain, metamask.address, method, params ?? []);
    });
    await page.exposeFunction("__cantonWallet", async (method: string, params: unknown) => {
      try { return await canton.provider.request({ method, params }); }
      catch (e) { throw new Error(`code:${(e as { code?: number }).code ?? 0} ${(e as Error).message}`); }
    });
    canton.provider.on("txChanged", (payload) => { page.evaluate((p: unknown) => window.postMessage({ type: "SPLICE_WALLET_REQUEST", target: "fake", request: { jsonrpc: "2.0", method: "txChanged", params: p } }, "*"), payload).catch(() => {}); });
    page.on("console", (m: any) => { logs.push(m.type() + ": " + m.text()); if (/content security policy/i.test(m.text())) refused.push(m.text()); });
    page.on("pageerror", (e: Error) => logs.push("pageerror: " + e.message));
    await page.addInitScript(() => {
      (window as any).ethereum = { request: ({ method, params }: any) => (window as any).__wallet(method, params ?? []).catch((e: Error) => { throw Object.assign(new Error(e.message), /rejected/i.test(e.message) ? { code: 4001 } : {}); }), on() {}, removeListener() {} };
      // A browser-extension wallet: answers the SDK's handshake, announces itself, and answers each request (the standard's JSON-RPC over the window's messages).
      const post = (m: unknown) => window.postMessage(m, "*");
      window.addEventListener("message", async (e) => {
        const d = e.data;
        if (!d) return;
        if (d.type === "SPLICE_WALLET_EXT_READY" && d.target === "fake") return post({ type: "SPLICE_WALLET_EXT_ACK", target: "fake" });
        if (d.type !== "SPLICE_WALLET_REQUEST" || d.target !== "fake" || d.request?.id == null) return;
        try { post({ type: "SPLICE_WALLET_RESPONSE", response: { jsonrpc: "2.0", id: d.request.id, result: await (window as any).__cantonWallet(d.request.method, d.request.params ?? null) } }); }
        catch (err) { const m = /^code:(-?\d+) /.exec((err as Error).message); post({ type: "SPLICE_WALLET_RESPONSE", response: { jsonrpc: "2.0", id: d.request.id, error: { code: m ? Number(m[1]) : -32603, message: (err as Error).message } } }); }
      });
      window.addEventListener("canton:requestProvider", () => window.dispatchEvent(new CustomEvent("canton:announceProvider", { detail: { id: "fake", name: "Fake Canton Wallet", target: "fake" } })));
    });
    await page.goto(ORIGIN + path, { waitUntil: "load" });
    return page;
  }
  const noSideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  /** Connects MetaMask, then the Canton wallet, and opts the wallet's account in. */
  async function connected(page: any) {
    await page.getByRole("textbox", { name: "Amount to move" }).waitFor();
    await page.getByRole("button", { name: "Connect MetaMask" }).click();
    await page.getByRole("button", { name: "Open my Canton account" }).click();
    await page.getByRole("button", { name: "Connect your Canton wallet" }).click();
    await page.getByText("Connected", { exact: true }).waitFor({ timeout: 30_000 }).catch(async (e: Error) => { console.log("PAGE TEXT:", (await page.locator(".account").innerText()).slice(0, 600), "\nLOG:", logs.join("\n").slice(0, 2000)); throw e; });
  }

  it("connects the wallet, opts in with two approvals in it, and moves Canton Coin to Ostia: the wallet approves the allocation and the deposit request, one claim in MetaMask, then final", async () => {
    const page = await open("/bridge");
    await connected(page);
    const sheet = page.getByRole("region", { name: "Your Canton account" });
    expect(await sheet.innerText()).toContain("Fake Canton Wallet");
    expect(await page.getByTitle(WALLET_PARTY).first().innerText()).toBe("alice::1220a1a1a…a1a1a1");
    expect(await page.getByRole("region", { name: "Your addresses" }).innerText()).toContain("Sending and accepting are done in Fake Canton Wallet itself.");
    expect(await page.getByRole("button", { name: "Get test Canton Coin" }).count()).toBe(0);   // the page's faucet is for Bridge accounts only
    await page.getByRole("button", { name: "Opt in", exact: true }).click();
    await page.getByText(/Each Canton step of a move opens in Fake Canton Wallet/).waitFor({ timeout: 30_000 });
    expect(canton.commands().map((c) => c.CreateCommand.templateId)).toEqual(["#ostia-twin:Twin.Twin:TwinAcceptance", "#canton-zk-evm:Zk.Chain:WithdrawalAcceptance"]);

    await page.getByRole("button", { name: /^From token/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^Canton Coin on Canton$/ }).click();
    await page.getByRole("textbox", { name: "Amount to move" }).fill("5");
    expect(await page.getByText("About 1 min · 1 MetaMask pop-up").count()).toBe(1);
    await page.getByRole("button", { name: "Move to Ostia" }).click();
    await page.getByText(/Done\. It is final in/).waitFor({ timeout: 90_000 });

    const steps = canton.commands();
    expect(steps.slice(2).map((c) => (c.CreateCommand ? c.CreateCommand.templateId.split(":").pop() : c.ExerciseCommand.choice))).toEqual(["AllocationFactory_Allocate", "DepositRequest"]);
    expect(steps[2].ExerciseCommand.choiceArgument.allocation.transferLeg).toMatchObject({ sender: WALLET_PARTY, amount: "5.0000000000" });
    expect(seen.factoryAsked).toBe(1);
    expect(seen.factoryBody).toMatchObject({ excludeDebugFields: true });
    expect(seen.factoryBody).not.toHaveProperty("party");
    expect(seen.signedHeader).toBe(false);   // the public route takes no account signature
    expect(seen.accountService).toBe(0);   // nothing else of the account service was asked for
    expect(seen.signRequests).toBe(0);   // MetaMask was not asked for a signature: no Bridge account was made
    const sent = [...chain.sent.values()];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(GATEWAY.toLowerCase());   // the claim
    expect(sent[0]!.leg).toMatchObject({ kind: "deposit", erc20: WCC });
    expect(sent[0]!.leg!.legId.replace(/^0x/, "").toLowerCase()).toBe(steps[3].CreateCommand.createArguments.depositId);
    expect(await noSideways(page)).toBe(true);
    await page.close();
  }, 180_000);

  it("keeps the wallet connected across a reload, with no click, and the account stays opted in", async () => {
    const page = await open("/bridge");
    await connected(page);
    await page.getByRole("button", { name: "Opt in", exact: true }).click();
    await page.getByText(/Each Canton step of a move opens in/).waitFor({ timeout: 30_000 });
    const before = canton.commands().length;
    await page.reload({ waitUntil: "load" });
    await page.getByRole("button", { name: "Connect MetaMask" }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Open my Canton account" }).or(page.getByText("Connected", { exact: true })).first().waitFor({ timeout: 30_000 });
    if (await page.getByText("Connected", { exact: true }).count() === 0) await page.getByRole("button", { name: "Open my Canton account" }).click();
    await page.getByText(/Each Canton step of a move opens in/).waitFor({ timeout: 30_000 });
    expect(canton.commands().length).toBe(before);   // nothing was asked of the wallet again
    expect(await noSideways(page)).toBe(true);
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.getByRole("button", { name: "Connect your Canton wallet" }).waitFor();
    await page.close();
  }, 120_000);
});
