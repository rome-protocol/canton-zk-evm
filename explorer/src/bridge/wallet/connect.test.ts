// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { twinAcceptance } from "../canton/commands.ts";
import { CHAIN, fakeWallet, WALLET_PARTY } from "./fake-wallet.ts";

/**
 * The real SDK (@canton-network/dapp-sdk), connecting to a fake browser-extension wallet that speaks the standard over the window's messages, as an extension does: it answers the SDK's handshake, announces
 * itself, answers requests, and sends `txChanged` as a notification. Nothing of the SDK is replaced: this holds that the page's code and the SDK's fit together as they are installed.
 */
let wallet: ReturnType<typeof fakeWallet>;
let stop: () => void;
function installExtension() {
  wallet = fakeWallet();
  const post = (message: unknown) => window.postMessage(message, "*");
  const onMessage = async (e: MessageEvent) => {
    const d = e.data;
    if (d?.type === "SPLICE_WALLET_EXT_READY" && d.target === "fake") return post({ type: "SPLICE_WALLET_EXT_ACK", target: "fake" });
    if (d?.type !== "SPLICE_WALLET_REQUEST" || d.target !== "fake" || d.request?.id == null) return;
    try {
      const result = await wallet.provider.request({ method: d.request.method, params: d.request.params });
      post({ type: "SPLICE_WALLET_RESPONSE", response: { jsonrpc: "2.0", id: d.request.id, result } });
    } catch (err) { post({ type: "SPLICE_WALLET_RESPONSE", response: { jsonrpc: "2.0", id: d.request.id, error: { code: (err as { code: number }).code, message: (err as Error).message } } }); }
  };
  const onRequest = () => window.dispatchEvent(new CustomEvent("canton:announceProvider", { detail: { id: "fake", name: "Fake Wallet", target: "fake" } }));
  const notify = (payload: unknown) => post({ type: "SPLICE_WALLET_REQUEST", target: "fake", request: { jsonrpc: "2.0", method: "txChanged", params: payload } });
  window.addEventListener("message", onMessage);
  window.addEventListener("canton:requestProvider", onRequest);
  wallet.provider.on("txChanged", notify);
  stop = () => { window.removeEventListener("message", onMessage); window.removeEventListener("canton:requestProvider", onRequest); };
}
// The SDK registers its web components when it is imported, which it may do once: a reload is the module forgetting its client.
const load = async () => { const m = await import("./connect.ts"); m.startOver(); return m; };
const loopLibrary = async () => (await import("@fivenorth/loop-sdk")).loop;
const OPTIONS = { wallets: ["extension" as const], gatewayUrl: null, networkName: "DevNet" };

beforeEach(() => { localStorage.clear(); installExtension(); });
afterEach(() => stop());

describe("connecting a wallet through the SDK", () => {
  it("lists the browser wallets that announce themselves, when the build offers them, and Loop when it offers Loop", async () => {
    const m = await load();
    expect(await m.choices(OPTIONS)).toEqual([{ id: "browser:ext:fake", name: "Fake Wallet" }]);
    const both = await load();
    expect((await both.choices({ ...OPTIONS, wallets: ["loop", "extension"] })).map((c) => c.name)).toEqual(["Loop", "Fake Wallet"]);
    const none = await load();
    expect(await none.choices({ ...OPTIONS, wallets: ["loop"] })).toEqual([{ id: "loop", name: "Loop" }]);
  });
  it("offers a Wallet Gateway only at the address it is given", async () => {
    const m = await load();
    expect((await m.choices({ wallets: ["gateway"], gatewayUrl: "https://gateway.example/api/v0/dapp" })).map((c) => c.name)).toEqual(["Wallet Gateway"]);
  });
  it("connects the wallet that was picked: the account, its name, a command through its prepare-and-execute, and the ledger read as its party", async () => {
    const m = await load();
    const link = await m.connectWallet(OPTIONS, "browser:ext:fake");
    expect(link.party).toBe(WALLET_PARTY);
    expect(link.name).toBe("Fake Wallet");
    expect(await link.submit(twinAcceptance(WALLET_PARTY, CHAIN))).toBe("update-1");
    expect(wallet.commands()).toHaveLength(1);
    const answer = (await link.ledgerApi({ requestMethod: "post", resource: "/v2/state/active-contracts-page", body: { eventFormat: { filtersByParty: { [WALLET_PARTY]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: "#ostia-twin:Twin.Twin:TwinAcceptance" } } } }] } } } } })) as { activeContracts: unknown[] };
    expect(answer.activeContracts).toHaveLength(1);
  });
  it("restores the connection after a reload, without asking the wallet's person again, and not after a disconnect", async () => {
    const first = await load();
    const link = await first.connectWallet(OPTIONS, "browser:ext:fake");
    const reloaded = await load();
    const again = await reloaded.restoreWallet(OPTIONS);
    expect(again?.party).toBe(link.party);
    await again!.disconnect();
    expect(wallet.requests.some((r) => r.method === "disconnect")).toBe(true);
    const later = await load();
    expect(await later.restoreWallet(OPTIONS)).toBeNull();
  });
  it("rejects with the wallet's own code when the person declines, which the page turns into words", async () => {
    const m = await load();
    wallet.provider.request = ((orig) => async (args: { method: string; params?: unknown }) => { if (args.method === "connect") throw Object.assign(new Error("declined"), { code: 4001 }); return orig(args); })(wallet.provider.request);
    await expect(m.connectWallet(OPTIONS, "browser:ext:fake")).rejects.toMatchObject({ code: 4001 });
  });
  it("registers Loop's own provider as an adapter that has the provider's calls", async () => {
    const m = await load();
    const adapter = m.loopAdapter(await loopLibrary(), OPTIONS);
    expect(adapter.getInfo()).toMatchObject({ providerId: "loop", name: "Loop" });
    const provider = adapter.provider();
    for (const call of ["request", "on", "removeListener"] as const) expect(typeof provider[call]).toBe("function");
    expect(adapter.provider()).toBe(provider);   // the library's provider is made once
  });
});

describe("Loop and the chain's network", () => {
  it("is not offered, and not started, while the network is not known (the library would start on mainnet)", async () => {
    const lib = await loopLibrary();
    const init = vi.spyOn(lib, "init");
    const m = await load();
    expect(await m.choices({ ...OPTIONS, wallets: ["loop"], networkName: null })).toEqual([]);
    expect(await m.choices({ ...OPTIONS, wallets: ["loop"], networkName: undefined })).toEqual([]);
    expect(await m.choices({ ...OPTIONS, wallets: ["loop"], networkName: "Localnet" })).toEqual([]);   // a name that is none of the three
    expect(() => m.loopAdapter(lib, { ...OPTIONS, wallets: ["loop"], networkName: null }).provider()).toThrow();
    expect(init).not.toHaveBeenCalled();
    init.mockRestore();
  });
  it("is offered once the network is known, without starting over: a client made before that does not keep the choice", async () => {
    const m = await load();   // one client for the first call
    expect(await m.choices({ ...OPTIONS, wallets: ["loop", "extension"], networkName: null })).toEqual([{ id: "browser:ext:fake", name: "Fake Wallet" }]);
    expect((await m.choices({ ...OPTIONS, wallets: ["loop", "extension"], networkName: "DevNet" })).map((c) => c.name)).toEqual(["Loop", "Fake Wallet"]);
  });
  it("is started with the chain's network, and is never started again for another", async () => {
    const lib = await loopLibrary();
    const init = vi.spyOn(lib, "init");
    const m = await load();
    const first = m.loopAdapter(lib, { ...OPTIONS, wallets: ["loop"], networkName: "DevNet" });
    first.provider();
    first.provider();
    expect(init.mock.calls.length).toBeLessThanOrEqual(1);   // once for the page's life (an earlier test may have started it)
    if (init.mock.calls.length === 1) expect(init).toHaveBeenCalledWith(expect.objectContaining({ network: "devnet" }));
    expect(() => m.loopAdapter(lib, { ...OPTIONS, wallets: ["loop"], networkName: "TestNet" }).provider()).toThrow("another network");
    init.mockRestore();
  });
});

describe("a link made late does not end a newer connection", () => {
  it("leaves the SDK's session alone when it is no longer this link's own, and ends it when it still is", async () => {
    const m = await load();
    const older = await m.connectWallet(OPTIONS, "browser:ext:fake");
    const newer = await m.connectWallet(OPTIONS, "browser:ext:fake");   // the SDK's session is now the newer link's: an extension's provider is made for each connection
    const asked = () => wallet.requests.filter((r) => r.method === "disconnect").length;
    await older.disconnect();   // the late end of the older one
    expect(asked()).toBe(0);
    expect(newer.closed).toBe(false);
    await newer.disconnect();   // the newer one's own end reaches the wallet
    expect(asked()).toBe(1);
    const later = await load();
    expect(await later.restoreWallet(OPTIONS)).toBeNull();
  });
});
