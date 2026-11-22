import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "../other/fakes.ts";
import { claimOwn, keptClaim } from "./claim.ts";
import { cc, claimBody, ME, SEPOLIA_BRIDGE, SEPOLIA_ID, taken, wrongClaim } from "./fakes.ts";

afterEach(() => vi.unstubAllGlobals());
const HASH = "0x" + "9a".repeat(32);
const sepolia = { chainId: SEPOLIA_ID, bridge: SEPOLIA_BRIDGE };

function world(claim: unknown = claimBody(), chain = SEPOLIA_ID) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(claim), { status: 200 })));
  const calls: { method: string; params: any[] }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let on = chain;
  const wallet = { request: async ({ method, params = [] }: { method: string; params?: any[] }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    calls.push({ method, params });
    if (method === "eth_chainId") return "0x" + on.toString(16);
    if (method === "wallet_switchEthereumChain") { on = Number(BigInt(params[0].chainId)); return null; }
    if (method === "eth_estimateGas") return "0x30d40";
    if (method === "eth_sendTransaction") return HASH;
    throw new Error(method);
  } };
  return { wallet, calls, store: memoryStore() };
}
const run = (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) => claimOwn({ wallet: w.wallet, account: ME, move: taken(), sepolia, ostiaNetwork: 75, store: w.store, now: () => 1000, ...over } as never);

describe("the person's own claim", () => {
  it("is asked of the wallet on Ethereum Sepolia after the page checks that it pays this wallet this amount, and its hash is kept", async () => {
    const w = world();
    expect(await run(w)).toBe(HASH);
    const sent = w.calls.find((c) => c.method === "eth_sendTransaction")!.params[0];
    expect(sent).toMatchObject({ from: ME, to: SEPOLIA_BRIDGE, value: "0x0", chainId: "0x" + SEPOLIA_ID.toString(16) });
    expect(keptClaim(w.store, taken().id, 2000)).toBe(HASH);
  });
  it("puts the wallet on Ethereum Sepolia first", async () => {
    const w = world(claimBody(), 770101);
    await run(w);
    expect(w.calls.map((c) => c.method).slice(0, 3)).toEqual(["eth_chainId", "wallet_switchEthereumChain", "eth_chainId"]);
  });
  it("signs nothing when the bridge hands over a claim that is not this move's: another amount, address, deposit, bridge or chain", async () => {
    for (const bad of [claimBody({ data: wrongClaim({ amount: cc(4.9) }) }), claimBody({ data: wrongClaim({ to: "0x" + "e4".repeat(20) }) }), claimBody({ data: wrongClaim({ count: 8 }) }), claimBody({ to: "0x" + "99".repeat(20) }), claimBody({ chainId: 1 }), claimBody({ destinationNetwork: 75 }), claimBody({ data: "0x1234" })]) {
      const w = world(bad);
      await expect(run(w)).rejects.toMatchObject({ name: "Stop", message: expect.stringContaining("not this move's") });
      expect(w.calls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
    }
  });
  it("signs nothing for a claim already paid out, a move not yet taken, or a claim that cannot be read", async () => {
    const paid = world(claimBody({ claimed: true, data: null }));
    await expect(run(paid)).rejects.toMatchObject({ message: "Already arrived." });
    await expect(run(world(), { move: { ...taken(), state: "requested", depositCount: null } })).rejects.toMatchObject({ message: "This move is not ready to claim." });
  });
  it("says in words when the bridge cannot be read, and signs nothing", async () => {
    const w = world();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status: 503 })));
    await expect(run(w)).rejects.toMatchObject({ name: "Stop", message: expect.stringContaining("cannot be read right now") });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status: 404 })));
    await expect(run(w)).rejects.toMatchObject({ message: "This is not ready to claim yet." });
    expect(w.calls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
  });
});

describe("the claim the browser asked for", () => {
  it("is counted as on its way for ten minutes, and is read back only if it is a hash", () => {
    const store = memoryStore();
    store.setItem("ostia-route-claim-a", JSON.stringify({ hash: HASH, at: 1000 }));
    expect(keptClaim(store, "a", 1000 + 9 * 60_000)).toBe(HASH);
    expect(keptClaim(store, "a", 1000 + 11 * 60_000)).toBeNull();
    store.setItem("ostia-route-claim-b", JSON.stringify({ hash: "nope", at: 1000 }));
    expect(keptClaim(store, "b", 1001)).toBeNull();
    store.setItem("ostia-route-claim-c", "{");
    expect(keptClaim(store, "c", 1001)).toBeNull();
    expect(keptClaim(null, "a", 1001)).toBeNull();
  });
});
