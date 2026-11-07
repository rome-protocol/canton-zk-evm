import { createPublicKey, verify } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { fromBase64 } from "../src/bridge/canton/key.ts";
import { partyOf } from "../src/bridge/canton/topology.ts";
import { lockIdOf } from "../src/bridge/moves/state.ts";
import { freshChain, preparedRedeem, rpcResult, sendTransaction, TKA, twinsOverview, txAnswer, VAULT } from "./bridge-fakes.ts";

/**
 * Moves through the Bridge page's card, in a real browser at 360 px: the built pages (BRIDGE_E2E_DIST, as for bridge-account.test.ts), the same wallet that signs with a fixed key, and a fake
 * account service, now with a chain behind it (a gateway, a vault and one ERC-20 with a Canton twin: e2e/bridge-fakes.ts). One move goes from Ostia to Canton (approve, pay in) and one from Canton
 * back to Ostia (the page signs the redeem with the account's key, then releases it in the wallet). Runs only when BRIDGE_E2E_DIST is set (the `bridge-page` job of
 * .github/workflows/explorer.yml does, after bridge-account.test.ts: both listen on the same port, the one the pages are built for).
 */
const dist = process.env.BRIDGE_E2E_DIST;
const PORT = 4173, ORIGIN = `http://127.0.0.1:${PORT}`;
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
const STATUS = {
  chainId: 770101, chainName: "Ostia", networkName: "DevNet", coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: "0x" + "cd".repeat(32), rootC: "0x" + "cd".repeat(32), file: "session.txt" },
  ok: true, starting: false, problems: [], evm: true, canton: true, final: null, proving: null, latest: [], signers: null, faucet: { on: true }, publicRpc: true, indexHead: 1, indexLag: 0, deriveCursor: 1, chainInstance: "i1",
};
const GATEWAY_PARTY = "gateway::1220" + "03".repeat(32);   // the build's settings (the job sets VITE_CHAIN_GATEWAY to this)
const SETTINGS = { operator: "operator::1220" + "01".repeat(32), confirmer: "confirmer::1220" + "02".repeat(32), gateway: GATEWAY_PARTY, builder: "builder::1220" + "04".repeat(32) };

const body = (req: IncomingMessage) => new Promise<string>((done) => { let t = ""; req.on("data", (c) => (t += c)); req.on("end", () => done(t)); });

describe.skipIf(!dist)("the Bridge page's moves, in a browser", () => {
  const wallet = privateKeyToAccount(`0x${"11".repeat(32)}`);
  let chain = freshChain();
  const seen = { redeemRef: "", executed: 0, signedOk: false, signRequests: 0 };
  const service = { has: { twin: false, withdrawal: false }, redeemOpen: false, prepared: null as null | { hash: string } };
  let server: Server, browser: any, party = "", publicKey: Uint8Array = new Uint8Array();
  beforeEach(() => {
    chain = freshChain();
    Object.assign(seen, { redeemRef: "", executed: 0, signedOk: false, signRequests: 0 });
    Object.assign(service, { has: { twin: false, withdrawal: false }, redeemOpen: false, prepared: null });
  });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const path = new URL(req.url!, ORIGIN).pathname;
      const json = (status: number, answer: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); };
      if (path === "/api/status") return json(200, STATUS);
      if (path === "/api/faucet") return json(200, { on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 1 });
      if (path === "/api/twins") return json(200, twinsOverview(`${ORIGIN}/twin-registry`));
      if (path.startsWith("/api/tx/")) { const t = txAnswer(chain, decodeURIComponent(path.slice(8))); return t ? json(200, t) : json(404, { error: "Not found." }); }
      if (path === "/rpc") {
        const call = JSON.parse(await body(req));
        try { return json(200, { jsonrpc: "2.0", id: call.id, result: rpcResult(chain, wallet.address, call.method, call.params ?? []) }); }
        catch (e) { return json(200, { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: (e as Error).message } }); }
      }
      if (path === "/twin-registry/twin/v1/lock-parts") {
        const { receiver, ref } = JSON.parse(await body(req));
        chain.lastLock = { receiver, ref, lockId: lockIdOf(receiver, ref) };
        return json(200, { lockId: chain.lastLock.lockId, vaults: [VAULT] });
      }
      if (path === "/accounts/v1/topology") {
        publicKey = fromBase64(JSON.parse(await body(req)).publicKey);
        party = await partyOf(publicKey);
        return json(200, { party, exists: true });
      }
      if (path === "/accounts/v1/prepare") {
        const text = await body(req);
        const command = JSON.parse(text).commands[0].CreateCommand;
        const entity = command.templateId.split(":").pop();
        if (entity === "RedeemRequest") {
          seen.redeemRef = command.createArguments.ref;
          const prepared = await preparedRedeem(party, command.createArguments);
          service.prepared = { hash: prepared.preparedTransactionHash };
          return json(200, prepared);
        }
        if (entity === "TwinAcceptance") service.has.twin = true;
        if (entity === "WithdrawalAcceptance") service.has.withdrawal = true;
        return json(409, { error: "already_accepted", message: "the account already has this acceptance open" });
      }
      if (path === "/accounts/v1/execute") {
        const { partySignatures } = JSON.parse(await body(req));
        const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, publicKey]), format: "der", type: "spki" });
        seen.signedOk = verify(null, Buffer.from(service.prepared!.hash, "base64"), key, Buffer.from(partySignatures[0].signature, "base64"));   // the account's own key signed the hash the page computed
        seen.executed++;
        service.redeemOpen = seen.signedOk;
        return json(200, { updateId: "1220" + "ef".repeat(32) });
      }
      if (path === `/accounts/v1/open/${party}`) {
        const held = (on: boolean) => (on ? { contractId: "00aa", arguments: {} } : null);
        return json(200, { party, depositRequests: [], redeemRequests: service.redeemOpen ? [{ contractId: "00bb", arguments: { ref: seen.redeemRef } }] : [], twinAcceptance: held(service.has.twin), withdrawalAcceptance: held(service.has.withdrawal) });
      }
      if (path === `/accounts/v1/holdings/${party}`) {
        return json(200, { holdings: [{ contractId: "00" + "ee".repeat(40), instrumentId: { admin: GATEWAY_PARTY, id: `erc20:${TKA.slice(2)}` }, amount: "20.0000000000", locked: false }] });
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

  /** A page at 360 px (a small phone), with the wallet: the fixed key signs in this process, and the chain's sends go to the fake chain. */
  async function open(path: string) {
    const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
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
      if (method === "eth_sendTransaction") return sendTransaction(chain, { ...params[0], from: wallet.address });
      return rpcResult(chain, wallet.address, method, params ?? []);
    });
    await page.addInitScript(() => { (window as any).ethereum = { request: ({ method, params }: any) => (window as any).__wallet(method, params ?? []), on() {}, removeListener() {} }; });
    await page.goto(ORIGIN + path, { waitUntil: "load" });
    return page;
  }
  /** Connects, opens the Canton account from the wallet, and waits until the card asks for an amount. */
  async function signedIn(page: any) {
    await page.getByRole("button", { name: "Connect MetaMask" }).click();
    await page.getByRole("button", { name: "Open my Canton account" }).click();
    await page.getByRole("button", { name: "Sign in with MetaMask" }).click();
    await page.getByRole("button", { name: "Enter an amount" }).waitFor({ timeout: 30_000 });
  }
  const noSideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  it("moves a token from Ostia to Canton: approve, then pay in, two pop-ups, then final", async () => {
    const page = await open("/bridge");
    await signedIn(page);
    expect(await page.getByText("About 30 s · 2 MetaMask pop-ups").count()).toBe(1);
    await page.getByRole("textbox", { name: "Amount to move" }).fill("1.5");
    await page.getByRole("button", { name: "Move to Canton" }).click();
    await page.getByText(/Done\. It is final in/).waitFor({ timeout: 60_000 });
    expect(await page.getByRole("link", { name: "block 36512" }).getAttribute("href")).toBe("/block/36512");
    expect([...chain.sent.values()].map((t) => t.to.toLowerCase())).toEqual([TKA, expect.any(String)]);   // the approval, then the payment to the gateway
    expect(chain.allowance).toBe(15n * 10n ** 17n);
    expect(chain.lastLock!.receiver).toBe(party);   // the lock is for the person's own Canton account
    expect([...chain.sent.values()][1]!.leg).toEqual({ kind: "payment", legId: chain.lastLock!.lockId });
    expect(await noSideways(page)).toBe(true);
    await page.close();
  }, 120_000);

  it("moves the token back from Canton to Ostia: the page signs the redeem with the account's key, then one release in the wallet", async () => {
    const page = await open("/bridge");
    await signedIn(page);
    await page.getByRole("button", { name: "Swap direction" }).click();
    await page.getByRole("textbox", { name: "Amount to move" }).fill("5");
    expect(await page.getByText("About 30 s · 1 MetaMask pop-up").count()).toBe(1);
    await page.getByRole("button", { name: "Move to Ostia" }).click();
    await page.getByText(/Done\. It is final in/).waitFor({ timeout: 90_000 });
    expect(seen.executed).toBe(1);
    expect(seen.signedOk).toBe(true);
    expect(seen.signRequests).toBe(1);   // the wallet signed once (the key); the redeem was signed by the account's key, with no pop-up
    const sent = [...chain.sent.values()];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(VAULT);
    expect(sent[0]!.leg).toMatchObject({ kind: "payment" });
    expect(seen.redeemRef).not.toBe("");
    expect(await noSideways(page)).toBe(true);
    await page.close();
  }, 150_000);

  it("keeps a long amount whole at 360 px: no sideways scroll, and the field holds every digit", async () => {
    const page = await open("/bridge");
    const field = page.getByRole("textbox", { name: "Amount to move" });
    await field.waitFor();
    const long = "123456789012.1234567890";
    await field.fill(long);
    expect(await field.inputValue()).toBe(long);
    expect(await noSideways(page)).toBe(true);
    const box = await field.evaluate((el: HTMLTextAreaElement) => ({ cut: el.scrollHeight > el.clientHeight + 1, right: el.getBoundingClientRect().right, width: document.documentElement.clientWidth }));
    expect(box.cut).toBe(false);   // the field is as tall as its text: nothing is hidden below
    expect(box.right).toBeLessThanOrEqual(box.width);
    const top = async (name: string) => (await page.getByRole(name === "token" ? "button" : "textbox", { name: name === "token" ? /^From token/ : "Amount to move" }).boundingBox()).y;
    expect(await top("amount")).toBeGreaterThan(await top("token"));   // on a phone the amount has its own line, under the token
    await page.close();
  }, 60_000);
});
