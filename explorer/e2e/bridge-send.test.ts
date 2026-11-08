import { createPublicKey, verify } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { fromBase64 } from "../src/bridge/canton/key.ts";
import { partyOf } from "../src/bridge/canton/topology.ts";
import { CC_ADMIN, CC_HOLDING, freshChain, preparedAccept, preparedTransfer, rpcResult, TKA, transferFactory, twinsOverview } from "./bridge-fakes.ts";

/**
 * Send on Canton and Incoming, in a real browser at 360 px: the built pages (BRIDGE_E2E_DIST, as for bridge-account.test.ts), the same wallet that signs with a fixed key, and a fake account service whose
 * prepared transactions are made from real ones of the pinned Canton (e2e/bridge-fakes.ts), so the page's own checks are the ones that accept them. The person types a token, an amount and an address, confirms the
 * line, and the page signs with the account's key (the wallet is asked once, to sign in, and never again); an offer made to the account is accepted from the Incoming list, and the balance then shows it.
 * Runs only when BRIDGE_E2E_DIST is set (the `bridge-page` job of .github/workflows/explorer.yml does, after the other two: all three listen on the port the pages are built for).
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
const RECEIVER = "bridge::1220" + "ab".repeat(32), SENDER = "friend::1220" + "cd".repeat(32);
const OFFER = "00" + "b1".repeat(40), SEND_UPDATE = "1220" + "ef".repeat(32);

const body = (req: IncomingMessage) => new Promise<string>((done) => { let t = ""; req.on("data", (c) => (t += c)); req.on("end", () => done(t)); });

describe.skipIf(!dist)("Send on Canton and Incoming, in a browser", () => {
  const wallet = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const chain = freshChain();
  const seen = { signRequests: 0, walletSends: 0, factories: [] as any[], prepares: [] as any[], executed: 0, verified: 0, accepts: 0 };
  const service = { kind: "offer" as "offer" | "direct", prepared: null as null | { hash: string }, offered: false, accepted: false, sendFails: false };
  let server: Server, browser: any, party = "", publicKey: Uint8Array = new Uint8Array();
  beforeEach(() => {
    Object.assign(seen, { signRequests: 0, walletSends: 0, factories: [], prepares: [], executed: 0, verified: 0, accepts: 0 });
    Object.assign(service, { kind: "offer", prepared: null, offered: false, accepted: false, sendFails: false });
  });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const path = new URL(req.url!, ORIGIN).pathname;
      const json = (status: number, answer: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); };
      if (path === "/api/status") return json(200, STATUS);
      if (path === "/api/faucet") return json(200, { on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 1 });
      if (path === "/api/twins") return json(200, twinsOverview(`${ORIGIN}/twin-registry`, { wrapped: true }));
      if (path === "/rpc") {
        const call = JSON.parse(await body(req));
        try { return json(200, { jsonrpc: "2.0", id: call.id, result: rpcResult(chain, wallet.address, call.method, call.params ?? []) }); }
        catch (e) { return json(200, { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: (e as Error).message } }); }
      }
      if (path === "/accounts/v1/topology") {
        publicKey = fromBase64(JSON.parse(await body(req)).publicKey);
        party = await partyOf(publicKey);
        return json(200, { party, exists: true });
      }
      if (/^\/accounts\/v1\/registry\/[^/]+\/transfer-factory$/.test(path)) {
        seen.factories.push({ admin: decodeURIComponent(path.split("/")[4]!), ...JSON.parse(await body(req)) });
        return json(200, transferFactory(service.kind));
      }
      if (/^\/accounts\/v1\/registry\/[^/]+\/transfer-instruction\/[^/]+\/accept-context$/.test(path)) {
        seen.accepts++;
        return json(200, { choiceContextData: { values: {} }, disclosedContracts: [] });
      }
      if (path === "/accounts/v1/prepare") {
        const first = JSON.parse(await body(req)).commands[0];
        seen.prepares.push(first);
        if (first.ExerciseCommand?.choice === "TransferFactory_Transfer") {
          const prepared = await preparedTransfer(party, first.ExerciseCommand, "splice-amulet");
          service.prepared = { hash: prepared.preparedTransactionHash };
          return json(200, prepared);
        }
        if (first.ExerciseCommand?.choice === "TransferInstruction_Accept") {
          const prepared = await preparedAccept(party, first.ExerciseCommand, "splice-amulet");
          service.prepared = { hash: prepared.preparedTransactionHash };
          return json(200, prepared);
        }
        return json(409, { error: "already_accepted", message: "the account already has this acceptance open" });   // the two standing acceptances
      }
      if (path === "/accounts/v1/execute") {
        const { partySignatures } = JSON.parse(await body(req));
        const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, publicKey]), format: "der", type: "spki" });
        const ok = verify(null, Buffer.from(service.prepared!.hash, "base64"), key, Buffer.from(partySignatures[0].signature, "base64"));
        seen.executed++;
        if (ok) seen.verified++;
        if (ok && service.offered) service.accepted = true;
        return json(200, { updateId: SEND_UPDATE });
      }
      if (path === `/accounts/v1/open/${party}`) {
        const held = { contractId: "00aa", arguments: {} };
        return json(200, { party, depositRequests: [], redeemRequests: [], twinAcceptance: held, withdrawalAcceptance: held });
      }
      if (path === `/accounts/v1/holdings/${party}`) {
        return json(200, { holdings: [
          { contractId: "00" + "ee".repeat(40), instrumentId: { admin: GATEWAY_PARTY, id: `erc20:${TKA.slice(2)}` }, amount: "20.0000000000", locked: false },
          { contractId: CC_HOLDING, instrumentId: { admin: CC_ADMIN, id: "Amulet" }, amount: "20.0000000000", locked: false },
          ...(service.accepted ? [{ contractId: "00" + "e2".repeat(40), instrumentId: { admin: CC_ADMIN, id: "Amulet" }, amount: "2.5000000000", locked: false }] : []),
        ] });
      }
      if (path === `/accounts/v1/transfers/${party}`) {
        const offer = { contractId: OFFER, packageName: "splice-amulet", transfer: { sender: SENDER, receiver: party, amount: "2.5000000000", instrumentId: { admin: CC_ADMIN, id: "Amulet" }, requestedAt: new Date(Date.now() - 60_000).toISOString(), executeBefore: new Date(Date.now() + 3600_000).toISOString() }, status: null };
        return json(200, { party, transfers: service.offered && !service.accepted ? [offer] : [], more: false });
      }
      if (path === `/accounts/v1/allocations/${party}`) return json(200, { allocations: [] });
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

  /** A page at 360 px, with the wallet: the fixed key signs in this process. A transaction sent from the wallet is counted: sending on Canton must never ask for one. */
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
      if (method === "eth_sendTransaction" || method === "personal_sign" || method === "eth_sign") { seen.walletSends++; throw new Error("User rejected the request."); }
      return rpcResult(chain, wallet.address, method, params ?? []);
    });
    await page.addInitScript(() => { (window as any).ethereum = { request: ({ method, params }: any) => (window as any).__wallet(method, params ?? []), on() {}, removeListener() {} }; });
    await page.goto(ORIGIN + path, { waitUntil: "load" });
    return page;
  }
  async function signedIn(page: any) {
    await page.getByRole("textbox", { name: "Amount to move" }).waitFor();
    await page.getByRole("button", { name: "Connect MetaMask" }).click();
    await page.getByRole("button", { name: "Open my Canton account" }).click();
    await page.getByRole("button", { name: "Sign in with MetaMask" }).click();
    await page.getByRole("group", { name: "Send on Canton" }).waitFor({ timeout: 30_000 });
  }
  const noSideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  /** Every control of the panel is inside the screen, left to right. */
  const inside = (page: any) => page.evaluate(() => [...document.querySelectorAll(".send input, .send select, .send button, .incoming button")].every((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; }));

  async function fill(page: any, amount: string, receiver: string) {
    const send = page.getByRole("group", { name: "Send on Canton" });
    await send.getByRole("combobox", { name: "Token" }).selectOption({ label: "Canton Coin" });
    await send.getByRole("textbox", { name: "Amount" }).fill(amount);
    await send.getByRole("textbox", { name: "Receiver's Canton address" }).fill(receiver);
    return send;
  }

  it("sends Canton Coin: the person confirms a line, the page signs with the account's key, and says it waits for the receiver to accept, with the Canton update", async () => {
    const page = await open("/bridge");
    await signedIn(page);
    const send = await fill(page, "5", RECEIVER);
    await send.getByRole("button", { name: "Review" }).click();
    expect(await send.getByRole("status").textContent()).toBe("Send 5 Canton Coin to bridge::1220…abab on Canton");
    expect(seen.prepares.filter((p) => p.ExerciseCommand)).toHaveLength(0);   // nothing is signed before the person confirms
    expect(await inside(page)).toBe(true);
    await send.getByRole("button", { name: "Send" }).click();
    await send.getByText("Sent; waiting for the receiver to accept.").waitFor({ timeout: 30_000 });
    expect(await send.getByRole("link", { name: "Canton update" }).getAttribute("href")).toBe(`/canton/${SEND_UPDATE}`);
    // What the page asked the registry for, and signed: the person's receiver, amount and instrument, from the account's own holding.
    expect(seen.factories).toHaveLength(1);
    expect(seen.factories[0]).toMatchObject({ admin: CC_ADMIN, party, excludeDebugFields: true, choiceArguments: { expectedAdmin: CC_ADMIN, transfer: { sender: party, receiver: RECEIVER, amount: "5.0000000000", instrumentId: { admin: CC_ADMIN, id: "Amulet" }, inputHoldingCids: [CC_HOLDING] } } });
    expect(seen.executed).toBeGreaterThanOrEqual(1);
    expect(seen.verified).toBe(seen.executed);   // every command the page executed carried the account's own signature of the hash the page computed
    expect(seen.signRequests).toBe(1);   // the wallet signed in, and never again
    expect(seen.walletSends).toBe(0);   // no MetaMask pop-up for the send
    expect(await send.getByRole("textbox", { name: "Amount" }).inputValue()).toBe("");
    expect(await noSideways(page)).toBe(true);
    expect(await inside(page)).toBe(true);
    await page.close();
  }, 120_000);

  it("says it is done when the receiver took it at once", async () => {
    service.kind = "direct";
    const page = await open("/bridge");
    await signedIn(page);
    const send = await fill(page, "1.25", RECEIVER);
    await send.getByRole("button", { name: "Review" }).click();
    await send.getByRole("button", { name: "Send" }).click();
    await send.getByText("Sent. It is in their account.").waitFor({ timeout: 30_000 });
    expect(await send.getByText(/waiting/).count()).toBe(0);
    await page.close();
  }, 120_000);

  it("refuses a bad address, the account's own address and too much, in plain words, and signs nothing", async () => {
    const page = await open("/bridge");
    await signedIn(page);
    const send = await fill(page, "5", "bridge");
    expect(await send.getByRole("alert").textContent()).toMatch(/not a Canton address/);
    expect(await send.getByRole("button", { name: "Review" }).isDisabled()).toBe(true);
    await send.getByRole("textbox", { name: "Receiver's Canton address" }).fill(party);
    expect(await send.getByRole("alert").textContent()).toMatch(/your own address/);
    expect(await send.getByRole("button", { name: "Review" }).isDisabled()).toBe(true);
    await send.getByRole("textbox", { name: "Receiver's Canton address" }).fill(RECEIVER);
    await send.getByRole("textbox", { name: "Amount" }).fill("21");
    expect(await send.getByRole("alert").textContent()).toBe("You do not hold that much on Canton.");
    expect(await send.getByRole("button", { name: "Review" }).isDisabled()).toBe(true);
    expect(seen.factories).toHaveLength(0);
    expect(seen.prepares.filter((p) => p.ExerciseCommand)).toHaveLength(0);
    expect(await noSideways(page)).toBe(true);
    await page.close();
  }, 120_000);

  it("lists an offer made to the account, accepts it with the account's key and shows the balance after", async () => {
    service.offered = true;
    const page = await open("/bridge");
    await signedIn(page);
    const incoming = page.getByRole("group", { name: "Incoming" });
    const row = incoming.getByRole("listitem");
    await row.waitFor();
    expect(await row.textContent()).toBe("2.5 Canton Coin from friend::1220…cdcdAccept");
    expect(await inside(page)).toBe(true);
    const balance = page.getByRole("list", { name: "On Canton" }).getByRole("listitem").filter({ hasText: "Canton Coin" });
    expect(await balance.textContent()).toBe("Canton Coin20");
    await incoming.getByRole("button", { name: "Accept" }).click();
    await incoming.getByText("2.5 Canton Coin is in your account.").waitFor({ timeout: 30_000 });
    expect(seen.accepts).toBe(1);
    expect(seen.prepares.filter((p) => p.ExerciseCommand?.choice === "TransferInstruction_Accept")).toHaveLength(1);
    expect(seen.verified).toBe(seen.executed);
    expect(await incoming.getByRole("listitem").count()).toBe(0);
    await page.getByRole("list", { name: "On Canton" }).getByText("22.5").waitFor({ timeout: 30_000 });   // the balance is read again
    expect(seen.signRequests).toBe(1);
    expect(seen.walletSends).toBe(0);
    expect(await noSideways(page)).toBe(true);
    await page.close();
  }, 120_000);

  it("uses no technical names on the panel", async () => {
    service.offered = true;
    const page = await open("/bridge");
    await signedIn(page);
    await page.getByRole("group", { name: "Incoming" }).getByRole("listitem").waitFor();
    const text = (await page.getByRole("region", { name: "Your addresses" }).innerText()) + (await page.getByRole("region", { name: "Your addresses" }).locator("input").evaluateAll((e: any[]) => e.map((i) => i.placeholder).join(" ")));
    expect(text).not.toMatch(/party|instruction|preapproval|allocation|holding|registry/i);
    await page.close();
  }, 120_000);
});
