import { createPublicKey, verify } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { fromBase64 } from "../src/bridge/canton/key.ts";
import { contentSecurityPolicy } from "../server/csp.ts";
import { partyOf } from "../src/bridge/canton/topology.ts";
import { lockIdOf } from "../src/bridge/moves/state.ts";
import { allocationFactory, CC_ADMIN, CC_HOLDING, freshChain, GATEWAY, preparedAllocation, preparedDeposit, preparedRedeem, rpcResult, sendTransaction, TKA, twinsOverview, txAnswer, UPDATE_ID, VAULT, WCC, WTROME, type Extra } from "./bridge-fakes.ts";

/**
 * Moves through the Bridge page's card, in a real browser at 360 px: the built pages (BRIDGE_E2E_DIST, as for bridge-account.test.ts), the same wallet that signs with a fixed key, and a fake
 * account service, now with a chain behind it (a gateway, a vault and one ERC-20 with a Canton twin, and when a test asks for them wCC and the wrapped coin: e2e/bridge-fakes.ts). All four moves run: Ostia to
 * Canton (approve, pay in; for the chain's own coin a wrap first), Canton back to Ostia (the page signs the redeem with the account's key, then releases it in the wallet), Canton Coin to Ostia (the page signs
 * the allocation and the deposit request, then the claim is made in the wallet) and wCC back to Canton (one withdrawal). Runs only when BRIDGE_E2E_DIST is set (the `bridge-page` job of
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
const ERC20_FIELD = "tok" + "en";   // the redeem request names its ERC-20 with the token standard word
const GATEWAY_PARTY = "gateway::1220" + "03".repeat(32);   // the build's settings (the job sets VITE_CHAIN_GATEWAY to this)
const SETTINGS = { operator: "operator::1220" + "01".repeat(32), confirmer: "confirmer::1220" + "02".repeat(32), gateway: GATEWAY_PARTY, builder: "builder::1220" + "04".repeat(32) };

const body = (req: IncomingMessage) => new Promise<string>((done) => { let t = ""; req.on("data", (c) => (t += c)); req.on("end", () => done(t)); });

describe.skipIf(!dist)("the Bridge page's moves, in a browser", () => {
  const wallet = privateKeyToAccount(`0x${"11".repeat(32)}`);
  let chain = freshChain();
  const seen = { redeemRef: "", depositId: "", executed: 0, verified: 0, signedOk: false, signRequests: 0, rejectSends: 0, factoryAsked: 0 };
  const ALLOCATION = "00" + "dd".repeat(40);   // the contract id the participant gives the allocation
  const service = {
    has: { twin: false, withdrawal: false }, redeemOpen: false, extra: {} as Extra,
    prepared: null as null | { hash: string; kind: "redeem" | "allocation" | "deposit" }, label: "", allocated: false, depositOpen: false,
  };
  let server: Server, browser: any, party = "", publicKey: Uint8Array = new Uint8Array();
  beforeEach(() => {
    chain = freshChain();
    Object.assign(seen, { redeemRef: "", depositId: "", executed: 0, verified: 0, signedOk: false, signRequests: 0, rejectSends: 0, factoryAsked: 0 });
    Object.assign(service, { has: { twin: false, withdrawal: false }, redeemOpen: false, extra: {}, prepared: null, label: "", allocated: false, depositOpen: false });
  });

  /** What the browser refused under the Content-Security-Policy: no test may have any. */
  const refused: string[] = [];
  beforeEach(() => { refused.length = 0; });
  afterEach(() => { expect(refused).toEqual([]); });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const path = new URL(req.url!, ORIGIN).pathname;
      const json = (status: number, answer: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); };
      if (path === "/api/status") return json(200, STATUS);
      if (path === "/api/faucet") return json(200, { on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 1 });
      if (path === "/api/twins") return json(200, twinsOverview(`${ORIGIN}/twin-registry`, service.extra));
      if (path.startsWith("/api/tx/")) { const t = txAnswer(chain, decodeURIComponent(path.slice(8))); return t ? json(200, t) : json(404, { error: "Not found." }); }
      if (path === "/rpc") {
        const call = JSON.parse(await body(req));
        try { return json(200, { jsonrpc: "2.0", id: call.id, result: rpcResult(chain, wallet.address, call.method, call.params ?? []) }); }
        catch (e) { return json(200, { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: (e as Error).message } }); }
      }
      if (path === "/twin-registry/twin/v1/lock-parts") {
        const { receiver, ref } = JSON.parse(await body(req));
        chain.lastLock = { receiver, ref, lockId: lockIdOf(receiver, ref) };
        return json(200, { lockId: chain.lastLock.lockId.slice(2), receiver, ref, acceptance: "00" + "ac".repeat(33), vaults: [VAULT] });   // the real registry answers the id without 0x, and the receiver, the ref and its acceptance contract
      }
      if (path === "/accounts/v1/topology") {
        publicKey = fromBase64(JSON.parse(await body(req)).publicKey);
        party = await partyOf(publicKey, "rome");
        return json(200, { party, exists: true });
      }
      if (/^\/accounts\/v1\/registry\/[^/]+\/allocation-factory$/.test(path)) {
        seen.factoryAsked++;
        return json(200, allocationFactory());
      }
      if (path === "/accounts/v1/prepare") {
        const text = await body(req);
        const first = JSON.parse(text).commands[0];
        if (first.ExerciseCommand) {   // the allocation of Canton Coin for a deposit: the account locks it for the gateway
          const prepared = await preparedAllocation(party, first.ExerciseCommand, "splice-amulet");
          service.label = first.ExerciseCommand.choiceArgument.allocation.settlement.settlementRef.id;
          service.prepared = { hash: prepared.preparedTransactionHash, kind: "allocation" };
          return json(200, prepared);
        }
        const command = first.CreateCommand;
        const entity = command.templateId.split(":").pop();
        if (entity === "RedeemRequest") {
          seen.redeemRef = command.createArguments.ref;
          const prepared = await preparedRedeem(party, command.createArguments);
          service.prepared = { hash: prepared.preparedTransactionHash, kind: "redeem" };
          return json(200, prepared);
        }
        if (entity === "DepositRequest") {
          seen.depositId = command.createArguments.depositId;
          const prepared = await preparedDeposit(party, command.createArguments);
          service.prepared = { hash: prepared.preparedTransactionHash, kind: "deposit" };
          return json(200, prepared);
        }
        if (entity === "TwinAcceptance") service.has.twin = true;
        if (entity === "WithdrawalAcceptance") service.has.withdrawal = true;
        return json(409, { error: "already_accepted", message: "the account already has this acceptance open" });
      }
      if (path === "/accounts/v1/execute") {
        const { partySignatures } = JSON.parse(await body(req));
        const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, publicKey]), format: "der", type: "spki" });
        const ok = verify(null, Buffer.from(service.prepared!.hash, "base64"), key, Buffer.from(partySignatures[0].signature, "base64"));   // the account's own key signed the hash the page computed
        seen.executed++;
        if (ok) seen.verified++;
        seen.signedOk = seen.verified === seen.executed;   // every command the page executed carried the account's own signature of the hash
        const kind = service.prepared!.kind;
        if (ok && kind === "redeem") service.redeemOpen = true;
        if (ok && kind === "allocation") service.allocated = true;
        if (ok && kind === "deposit") service.depositOpen = true;
        return json(200, { updateId: "1220" + "ef".repeat(32) });
      }
      if (path === `/accounts/v1/open/${party}`) {
        const held = (on: boolean) => (on ? { contractId: "00aa", arguments: {} } : null);
        return json(200, { party, depositRequests: service.depositOpen ? [{ contractId: "00bc", arguments: { depositId: seen.depositId } }] : [], redeemRequests: service.redeemOpen ? [{ contractId: "00bb", arguments: { holder: party, [ERC20_FIELD]: TKA.slice(2), amount: "5.0000000000", recipient: wallet.address.slice(2).toLowerCase(), ref: seen.redeemRef } }] : [], twinAcceptance: held(service.has.twin), withdrawalAcceptance: held(service.has.withdrawal) });
      }
      if (path === `/accounts/v1/holdings/${party}`) {
        return json(200, { holdings: [
          { contractId: "00" + "ee".repeat(40), instrumentId: { admin: GATEWAY_PARTY, id: `erc20:${TKA.slice(2)}` }, amount: "20.0000000000", locked: false },
          { contractId: CC_HOLDING, instrumentId: { admin: CC_ADMIN, id: "Amulet" }, amount: "20.0000000000", locked: false },
        ] });
      }
      if (path === `/accounts/v1/allocations/${party}`) {
        const none = !service.allocated;
        return json(200, { allocations: none ? [] : [{ contractId: ALLOCATION, holdingCids: [CC_HOLDING], allocation: { settlement: { settlementRef: { id: service.label }, settleBefore: new Date(Date.now() + 2 * 3600_000).toISOString() }, transferLegId: "leg-" + service.label, transferLeg: { sender: party, receiver: GATEWAY_PARTY, amount: "5.0000000000", instrumentId: { admin: CC_ADMIN, id: "Amulet" } } } }] });
      }
      if (path.startsWith("/api/") || path.startsWith("/accounts/")) return json(404, { error: "Not found." });
      let file = join(resolve(dist!), path);
      if (!existsSync(file) || !statSync(file).isFile()) file = join(resolve(dist!), "index.html");
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...(extname(file) === ".html" ? { "content-security-policy": contentSecurityPolicy() } : {}) });   // the pages run under the policy the explorer's server sends
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
    let connected = false;
    await page.exposeFunction("__wallet", async (method: string, params: any[]) => {
      // Like MetaMask: no account is shared with a page until it has asked eth_requestAccounts (unless the site was connected before).
      if (method === "eth_requestAccounts") { connected = true; return [wallet.address]; }
      if (method === "eth_accounts") return connected ? [wallet.address] : [];
      if (method === "eth_chainId") return "0x" + (770101).toString(16);
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "eth_signTypedData_v4") {
        seen.signRequests++;
        const { domain, types, primaryType, message } = JSON.parse(params[1]);
        delete types.EIP712Domain;
        return wallet.signTypedData({ domain, types, primaryType, message });
      }
      if (method === "eth_sendTransaction" && seen.rejectSends > 0) { seen.rejectSends--; throw new Error("User rejected the request."); }
      if (method === "eth_sendTransaction") return sendTransaction(chain, { ...params[0], from: wallet.address });
      return rpcResult(chain, wallet.address, method, params ?? []);
    });
    // A wallet that turns a request down answers with the EIP-1193 error code 4001 (exposeFunction carries only the message across): the page tells that from a send whose outcome the wallet does not give.
    page.on("console", (m: any) => { if (/content security policy/i.test(m.text())) refused.push(m.text()); });
    await page.addInitScript(() => {
      (window as any).ethereum = {
        request: ({ method, params }: any) => (window as any).__wallet(method, params ?? []).catch((e: Error) => { throw Object.assign(new Error(e.message), /rejected/i.test(e.message) ? { code: 4001 } : {}); }),
        on() {}, removeListener() {},
      };
    });
    await page.goto(ORIGIN + path, { waitUntil: "load" });
    return page;
  }
  /** Connects, opens the Canton account from the wallet, and waits until the card asks for an amount. */
  async function signedIn(page: any) {
    await page.getByRole("textbox", { name: "Amount to move" }).waitFor();   // the card is drawn with its tokens, so the page does not move under the click
    await page.getByRole("button", { name: "Connect MetaMask" }).click();
    await page.getByRole("button", { name: "Open my Canton account" }).click();
    await page.getByRole("button", { name: "Sign in with MetaMask" }).click();
    await page.getByRole("button", { name: "Enter an amount" }).waitFor({ timeout: 30_000 });
  }
  /** Opens the token picker of a field and takes a token of it (named as the picker names it, "Canton Coin on Canton"). */
  async function pick(page: any, field: "From" | "To", name: RegExp) {
    await page.getByRole("button", { name: new RegExp(`^${field} token`) }).click();
    await page.getByRole("dialog").getByRole("button", { name }).click();
  }
  const noSideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  it("moves a token from Ostia to Canton: approve, then pay in, two pop-ups, then final", async () => {
    const page = await open("/bridge");
    await signedIn(page);
    expect(await page.getByText("About 2 min · 2 MetaMask pop-ups").count()).toBe(1);
    await page.getByRole("textbox", { name: "Amount to move" }).fill("1.5");
    await page.getByRole("button", { name: "Move to Canton" }).click();
    await page.getByText(/Done\. It is final in/).waitFor({ timeout: 60_000 });
    expect(await page.getByRole("region", { name: "Move tokens" }).getByRole("link", { name: "block 36512" }).getAttribute("href")).toBe("/block/36512");   // the card says where it is final; the bar under it names the block too
    expect([...chain.sent.values()].map((t) => t.to.toLowerCase())).toEqual([TKA, expect.any(String)]);   // the approval, then the payment to the gateway
    expect(chain.allowance).toBe(15n * 10n ** 17n);
    expect(chain.lastLock!.receiver).toBe(party);   // the lock is for the person's own Canton account
    expect([...chain.sent.values()][1]!.leg).toMatchObject({ kind: "payment", legId: chain.lastLock!.lockId });
    expect(await noSideways(page)).toBe(true);
    await page.close();
  }, 120_000);

  it("takes a comma as the decimal point: 1,5 is 1.5, and the move goes through", async () => {
    const page = await open("/bridge");
    await signedIn(page);
    const field = page.getByRole("textbox", { name: "Amount to move" });
    expect(await field.getAttribute("inputmode")).toBe("decimal");
    await field.fill("1,5");
    expect(await field.inputValue()).toBe("1.5");
    await page.getByRole("button", { name: "Move to Canton" }).click();
    await page.getByText(/Done\. It is final in/).waitFor({ timeout: 60_000 });
    expect(chain.allowance).toBe(15n * 10n ** 17n);
    await field.fill("1,000,5");
    expect(await page.getByRole("button", { name: "Enter an amount" }).isDisabled()).toBe(true);
    await page.close();
  }, 120_000);

  it("lists a redeem that Canton has open and this browser has no record of (started on another device), and carries it on: one release, nothing signed again", async () => {
    service.redeemOpen = true;
    seen.redeemRef = "other-device-1";
    const page = await open("/bridge");
    await signedIn(page);
    await page.getByRole("tab", { name: "Activity" }).click();
    const row = page.getByRole("region", { name: "Activity" }).getByRole("listitem").filter({ hasText: "5 TKA to Ostia" });
    await row.waitFor();
    expect(await row.getByText("Started in another browser. Canton has it. Release it on Ostia.").count()).toBe(1);
    expect(await noSideways(page)).toBe(true);
    await row.getByRole("button", { name: "Release on Ostia" }).click();
    await row.getByRole("link", { name: "Ostia block 36512" }).waitFor({ timeout: 90_000 });
    expect(await row.getByRole("listitem", { name: "Final: done" }).count()).toBe(1);
    const sent = [...chain.sent.values()];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(VAULT);
    expect(seen.executed).toBe(0);   // the request was already on Canton: nothing was signed here
    await page.close();
  }, 150_000);

  it("moves the token back from Canton to Ostia: the page signs the redeem with the account's key, then one release in the wallet", async () => {
    const page = await open("/bridge");
    await signedIn(page);
    await page.getByRole("button", { name: "Swap direction" }).click();
    await page.getByRole("textbox", { name: "Amount to move" }).fill("5");
    expect(await page.getByText("About 1 min · 1 MetaMask pop-up").count()).toBe(1);
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

  it("moves Canton Coin to Ostia: the page signs the allocation and the deposit request, one claim in the wallet, then final", async () => {
    service.extra = { wrapped: true };
    const page = await open("/bridge");
    await signedIn(page);
    await pick(page, "From", /^Canton Coin on Canton$/);
    await page.getByRole("textbox", { name: "Amount to move" }).fill("5");
    expect(await page.getByText("About 1 min · 1 MetaMask pop-up").count()).toBe(1);
    await page.getByRole("button", { name: "Move to Ostia" }).click();
    await page.getByText(/Done\. It is final in/).waitFor({ timeout: 90_000 });
    expect(seen.factoryAsked).toBe(1);   // the registry's allocation factory was asked once, through the account service
    expect(seen.executed).toBe(2);   // the allocation, then the deposit request
    expect(seen.signedOk).toBe(true);   // both signed by the account's own key, over the hash the page computed
    expect(seen.signRequests).toBe(1);   // the wallet signed once (the key); the page made the two Canton signatures with no pop-up
    const sent = [...chain.sent.values()];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(GATEWAY.toLowerCase());   // the claim
    expect(sent[0]!.leg).toMatchObject({ kind: "deposit", erc20: WCC });
    expect(sent[0]!.leg!.legId.replace(/^0x/, "").toLowerCase()).toBe(seen.depositId.replace(/^0x/, "").toLowerCase());
    expect(await noSideways(page)).toBe(true);
    await page.close();
  }, 150_000);

  it("moves wCC back to Canton: one withdrawal in the wallet, then final", async () => {
    service.extra = { wrapped: true, custody: String(100n * 10n ** 10n) };   // the gateway holds more than the withdrawal
    const page = await open("/bridge");
    await signedIn(page);
    await pick(page, "From", /^wCC on Ostia$/);
    await page.getByRole("textbox", { name: "Amount to move" }).fill("5");
    expect(await page.getByText("About 1 min · 1 MetaMask pop-up").count()).toBe(1);
    await page.getByRole("button", { name: "Move to Canton" }).click();
    await page.getByText(/Done\. It is final in/).waitFor({ timeout: 60_000 });
    const sent = [...chain.sent.values()];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(GATEWAY.toLowerCase());
    expect(sent[0]!.leg).toMatchObject({ kind: "withdrawal", erc20: WCC, amount: String(5n * 10n ** 10n) });
    expect(seen.executed).toBe(0);   // nothing is signed on Canton: the gateway pays out to the account's acceptance
    expect(await noSideways(page)).toBe(true);
    await page.close();
  }, 120_000);

  it("moves the chain's own coin to Canton: wrap, approve, pay, three pop-ups, then final", async () => {
    service.extra = { wrapper: true };
    const page = await open("/bridge");
    await signedIn(page);
    await pick(page, "From", /^tROME on Ostia$/);
    await page.getByRole("textbox", { name: "Amount to move" }).fill("20.5");   // more than the wrapped coin held (20): the rest is wrapped first
    expect(await page.getByText("About 2 min · 3 MetaMask pop-ups").count()).toBe(1);
    await page.getByRole("button", { name: "Move to Canton" }).click();
    await page.getByText(/Done\. It is final in/).waitFor({ timeout: 60_000 });
    const sent = [...chain.sent.values()];
    expect(sent.map((t) => t.to.toLowerCase())).toEqual([WTROME, WTROME, GATEWAY.toLowerCase()]);   // the wrap, the approval, the payment
    expect(sent[0]!.value).toBe(5n * 10n ** 17n);   // only what was missing is wrapped
    expect(chain.allowance).toBe(205n * 10n ** 17n);
    expect(sent[2]!.leg).toMatchObject({ kind: "payment", legId: chain.lastLock!.lockId });
    expect(chain.lastLock!.receiver).toBe(party);
    expect(await noSideways(page)).toBe(true);
    await page.close();
  }, 120_000);

  it("shows the move on its way under the card: Sent, Proven, then Final once the block is final, and lists it in Activity with its links", async () => {
    chain.hold = true;   // the explorer shows the block proven and not yet final on Canton
    const page = await open("/bridge");
    await signedIn(page);
    await page.getByRole("textbox", { name: "Amount to move" }).fill("1.5");
    await page.getByRole("button", { name: "Move to Canton" }).click();
    const bar = page.getByRole("region", { name: "Move on its way" });
    await bar.getByRole("listitem", { name: "Proven: done" }).waitFor({ timeout: 60_000 });
    expect(await bar.getByRole("listitem", { name: "Sent: done" }).count()).toBe(1);
    expect(await bar.getByRole("listitem", { name: "Final: waiting" }).count()).toBe(1);
    expect(await bar.getByRole("link", { name: "block 36512" }).getAttribute("href")).toBe("/block/36512");
    expect(await noSideways(page)).toBe(true);
    chain.hold = false;   // the block is final on Canton
    await page.getByText(/Done\. It is final in/).waitFor({ timeout: 60_000 });
    expect(await bar.count()).toBe(0);   // the bar is only for a move on its way; the card says it is final
    await page.getByRole("tab", { name: "Activity" }).click();
    const row = page.getByRole("region", { name: "Activity" }).getByRole("listitem").filter({ hasText: "1.5 TKA to Canton" });
    await row.waitFor();
    expect(await row.getByRole("listitem", { name: "Final: done" }).count()).toBe(1);
    expect(await row.getByRole("link", { name: "Ostia block 36512" }).getAttribute("href")).toBe("/block/36512");
    expect(await row.getByRole("link", { name: "Canton update" }).getAttribute("href")).toBe("/canton/" + UPDATE_ID);
    const dateUnderTitle = await page.locator(".act-row").evaluateAll((rows: HTMLElement[]) => rows.every((r) => {
      const title = r.querySelector("b")!.getBoundingClientRect(), date = r.querySelector(".act-top > span")?.getBoundingClientRect();
      return !date || date.top >= title.bottom - 1;
    }));
    expect(dateUnderTitle).toBe(true);   // at 360 px the date sits under the title, never beside it
    expect(await noSideways(page)).toBe(true);
    await page.close();
  }, 150_000);

  // Twice: in a browser that keeps the account's key it reopens by itself; in one that keeps nothing (the kept key is cleared before the reload: a private window, cleared site data) the row asks to open the account, and the person signs in again.
  for (const forget of [false, true]) it(`keeps a move that stopped, lists it in Activity after a reload, and continues it from its row${forget ? ", in a browser that keeps no key" : ""}`, async () => {
    const page = await open("/bridge");
    await signedIn(page);
    await page.getByRole("button", { name: "Swap direction" }).click();
    await page.getByRole("textbox", { name: "Amount to move" }).fill("5");
    seen.rejectSends = 1;   // the wallet turns the release down: the redeem is on Canton, the release is not sent
    await page.getByRole("button", { name: "Move to Ostia" }).click();
    await page.getByRole("button", { name: "Release on Ostia" }).waitFor({ timeout: 90_000 });   // the card names the step it carries on with
    expect(chain.sent.size).toBe(0);
    expect(seen.executed).toBe(1);

    if (forget) {
      await page.evaluate(async () => {
        const db: IDBDatabase = await new Promise((done, fail) => { const r = indexedDB.open("ostia-bridge-canton", 1); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
        await new Promise<void>((done, fail) => { const t = db.transaction("accounts", "readwrite"); t.objectStore("accounts").clear(); t.oncomplete = () => done(); t.onerror = () => fail(t.error); });
        db.close();
      });
    }
    await page.reload({ waitUntil: "load" });
    await page.getByRole("textbox", { name: "Amount to move" }).waitFor();
    await page.getByRole("button", { name: "Connect MetaMask" }).waitFor({ state: "detached" });   // the wallet stays connected across the reload
    await page.getByRole("tab", { name: "Activity" }).click();
    const activity = page.getByRole("region", { name: "Activity" });
    const row = activity.getByRole("listitem").filter({ hasText: "5 TKA to Ostia" });
    await row.waitFor();
    expect(await row.getByRole("listitem", { name: "Sent: waiting" }).count()).toBe(1);
    expect(await noSideways(page)).toBe(true);
    if (forget) {
      await row.getByRole("button", { name: "Open my Canton account to continue" }).click();
      await page.getByRole("button", { name: "Sign in with MetaMask" }).click();
    }   // else the browser kept the account's key: the account opens again by itself when the page loads, with no second signature, and the row carries on.
    await row.getByRole("button", { name: "Release on Ostia" }).click();
    await row.getByRole("link", { name: "Ostia block 36512" }).waitFor({ timeout: 90_000 });
    expect(await row.getByRole("listitem", { name: "Final: done" }).count()).toBe(1);
    const sent = [...chain.sent.values()];
    expect(sent).toHaveLength(1);   // the release was sent once, after the person continued
    expect(sent[0]!.to.toLowerCase()).toBe(VAULT);
    expect(seen.executed).toBe(1);   // the redeem was not signed again
    expect(seen.signRequests).toBe(forget ? 2 : 1);   // the wallet signs again only where the browser kept nothing
    await page.close();
  }, 180_000);

  it("takes .5 as 0.5 and 5. as 5, shows the normalised amount when the field is left, and moves 0.5", async () => {
    const page = await open("/bridge");
    await signedIn(page);
    const field = page.getByRole("textbox", { name: "Amount to move" });
    await field.fill(".5");
    await page.getByRole("button", { name: "Move to Canton" }).waitFor();   // read as 0.5 while it is typed
    await field.blur();
    expect(await field.inputValue()).toBe("0.5");
    await field.fill("5.");
    await field.blur();
    expect(await field.inputValue()).toBe("5");
    await field.fill(".5");
    await page.getByRole("button", { name: "Move to Canton" }).click();
    await page.getByText(/Done\. It is final in/).waitFor({ timeout: 60_000 });
    expect(chain.allowance).toBe(5n * 10n ** 17n);   // 0.5 of an 18-decimal token
    expect(chain.lastLock!.receiver).toBe(party);
    await page.close();
  }, 120_000);

  it("shows the account panel at 360 px: both addresses with their copy buttons and the Canton balances, nothing cut, no sideways scroll", async () => {
    const page = await open("/bridge");
    await page.getByRole("textbox", { name: "Amount to move" }).waitFor();
    await page.getByRole("button", { name: "Connect MetaMask" }).click();
    const panel = page.getByRole("region", { name: "Your addresses" });
    await panel.waitFor();
    expect(await panel.getByText("Your wallet on Ostia").count()).toBe(1);
    expect(await panel.getByText("Not opened yet").count()).toBe(1);   // the short version while the account is not open
    expect(await panel.getByRole("button", { name: "Copy your wallet address on Ostia" }).count()).toBe(1);
    expect(await panel.getByRole("button", { name: "Copy your account address on Canton" }).count()).toBe(0);
    await page.getByRole("button", { name: "Open my Canton account" }).click();
    await page.getByRole("button", { name: "Sign in with MetaMask" }).click();
    await page.getByRole("button", { name: "Enter an amount" }).waitFor({ timeout: 30_000 });
    await panel.getByText("Your account on Canton").waitFor();
    await panel.getByText("Anyone on Canton can send tokens to it; only your MetaMask can move them.", { exact: false }).waitFor();
    expect(await panel.getByRole("button", { name: "Copy your wallet address on Ostia" }).count()).toBe(1);
    expect(await panel.getByRole("button", { name: "Copy your account address on Canton" }).count()).toBe(1);
    await panel.getByText("20", { exact: true }).first().waitFor();   // the account holds 20 of the token (the fake service's holdings)
    expect(await panel.evaluate((el: HTMLElement) => /party|allocation|vault|external|holding|instrument/i.test(el.textContent ?? ""))).toBe(false);
    // Nothing is cut: every box inside the panel sits within the page, and none has text running past its own box.
    const fits = await panel.evaluate((el: HTMLElement) => {
      const width = document.documentElement.clientWidth;
      return [el, ...el.querySelectorAll<HTMLElement>("*")].every((n) => { const r = n.getBoundingClientRect(); return r.left >= -0.5 && r.right <= width + 0.5 && n.scrollWidth <= n.clientWidth + 1; });
    });
    expect(fits).toBe(true);
    expect(await noSideways(page)).toBe(true);
    // The copy buttons are in view and do not overlap the address they belong to.
    const apart = await panel.evaluate((el: HTMLElement) => [...el.querySelectorAll(".addr")].every((a) => { const m = a.querySelector(".mono")!.getBoundingClientRect(), b = a.querySelector("button")!.getBoundingClientRect(); return b.top >= m.bottom - 1 || b.left >= m.right - 1; }));
    expect(apart).toBe(true);
    await page.close();
  }, 90_000);

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
  /** What the folded steps list looks like once it is open: for each step, the lines its label and its note take (the rows its boxes sit on; the separator dot is a box of its own, on the label's line), and where each sits. */
  const stepsLayout = (page: any) => page.evaluate(() => {
    const list = document.querySelector(".move-steps")!;
    return [...list.querySelectorAll("li")].map((li) => {
      const [label, note] = [...li.querySelectorAll(":scope > span")] as HTMLElement[];
      const box = (e: HTMLElement) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, lines: new Set([...e.getClientRects()].map((r) => Math.round(r.top))).size, line: parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize) * 1.5 }; };
      const l = li.getBoundingClientRect();
      return { label: label!.textContent, note: note!.textContent, labelBox: box(label!), noteBox: box(note!), li: { top: l.top, bottom: l.bottom, left: l.left, right: l.right } };
    });
  });

  it("lays the folded steps list out one step to a line at 360 px and at 1280 px: each label and its MetaMask pop-up text on one line, nothing overlapping", async () => {
    service.extra = { wrapper: true, wrapped: true };
    const page = await open("/bridge");
    await page.getByRole("textbox", { name: "Amount to move" }).waitFor();
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      // All five kinds of move, at both widths. Each label and its pop-up text stay on one line; at phone width a page-signed step (not a pop-up) may wrap, as text normally does.
      const lists = [/^tROME on Ostia$/, /^TKA on Ostia$/, /^TKA on Canton$/, /^Canton Coin on Canton$/, /^wCC on Ostia$/];
      for (const [from, name] of lists.map((n) => ["From", n] as const)) {
        await pick(page, from, name);
        const details = page.locator("details.move-steps");
        if (!(await details.evaluate((d: HTMLDetailsElement) => d.open))) await details.locator("summary").click();
        const steps = await stepsLayout(page);
        expect(steps.length).toBeGreaterThanOrEqual(2);
        let popups = 0;
        steps.forEach((st: any, i: number) => {
          const at = `${width}px, ${st.label}`;
          for (const [what, b] of [["label", st.labelBox], ["note", st.noteBox]] as const) {
            if (!/MetaMask pop-up/.test(st.note) && (what === "note" || width < 1280)) continue;   // a step that is not a pop-up: its note may wrap, and at phone width its label too
            expect(b.lines, `${at}: ${what} is on ${b.lines} lines`).toBe(1);
            expect(b.height, `${at}: ${what} is ${b.height} px high`).toBeLessThanOrEqual(b.line * 1.5);
          }
          if (/MetaMask pop-up/.test(st.note)) popups++;
          const flows = !/MetaMask pop-up/.test(st.note) && (st.noteBox.lines > 1 || st.labelBox.lines > 1);   // a long note that is not a pop-up runs on from the label's line to the next: its box spans both
          const sameRow = Math.min(st.labelBox.bottom, st.noteBox.bottom) - Math.max(st.labelBox.top, st.noteBox.top) > 2;
          if (flows) { /* wraps by design */ } else if (sameRow) expect(st.labelBox.right, `${at}: label and note overlap`).toBeLessThanOrEqual(st.noteBox.left + 1);   // on the same line: side by side
          else expect(st.labelBox.bottom, `${at}: label and note overlap`).toBeLessThanOrEqual(st.noteBox.top + 1);   // wrapped: one under the other
          if (i > 0) expect(steps[i - 1].li.bottom, `${at}: steps overlap`).toBeLessThanOrEqual(st.li.top + 1);
          expect(st.li.right, `${at}: the step runs off the card`).toBeLessThanOrEqual(width);
        });
        expect(popups).toBeGreaterThanOrEqual(/^\^(tROME|TKA) on Ostia/.test(name.source) ? 2 : 1);   // a move to Canton has two or three pop-ups; the Canton-side moves have one
        expect(await noSideways(page)).toBe(true);
      }
    }
    await page.close();
  }, 60_000);
});
