// Connects a Canton wallet through Canton's dApp SDK. The page lists the wallets this build offers (the sheet's own buttons), the person picks one and approves in it, and the connection comes back as a
// `WalletLink` (link.ts). The SDK's discovery client holds the adapters: Loop's (its library has a CIP-0103 provider, and registers nothing in the browser by itself), a Wallet Gateway's, and the
// browser wallets that announce themselves; it also restores a session after a reload. The Bridge page loads this file only when a person asks to connect, or when this browser connected a wallet before
// (`wasConnected`): the SDK is not in the page's first script. Loop's library is not imported by this file: it is loaded by its own `import()`, which exists in a build only when the build's switch lists `loop`
// (see `loadLoop`), because the library carries no licence.
import * as sdk from "@canton-network/dapp-sdk";
import { linkWallet, type Cip103, type WalletLink } from "./link.ts";
import { loopNetwork, type WalletConfig } from "./wallets.ts";

export interface ConnectOptions extends WalletConfig {
  /** The Canton network the chain is on, as the chain names it ("DevNet"): Loop's library needs it. */
  networkName?: string | null;
  appName?: string;
}
/** A wallet the sheet offers: the SDK's id for it, and its name. */
export interface Choice { id: string; name: string }

// The SDK's own types are not used here: its package names its modules without file extensions, which this repository's module resolution (NodeNext) cannot follow, so they would be `any`. These are the
// parts of them this file uses, as the published type definitions of @canton-network/dapp-sdk 1.9.0 and @fivenorth/loop-sdk 0.16.0 give them (checked against those, with bundler resolution, in the pull request).
/** The SDK's `ProviderAdapter`. */
export interface WalletAdapter {
  readonly providerId: string;
  readonly name: string;
  readonly type: string;
  getInfo(): { providerId: string; name: string; type: string; description?: string };
  detect(): Promise<boolean>;
  provider(): Cip103;
  teardown(): void;
  restore?(): Promise<Cip103 | null>;
}
/** The part of the SDK's `DiscoveryClient` the page uses. */
interface Discovery {
  registerAdapter(adapter: WalletAdapter): void;
  listAdapters(): WalletAdapter[];
  connect(providerId: string): Promise<void>;
  disconnect(): Promise<void>;
  getActiveSession(): { providerId: string; provider: Cip103 } | null;
}
const { DiscoveryClient: Client, ExtensionAdapter: Extension, RemoteAdapter: Remote } = sdk as unknown as {
  DiscoveryClient: { create(config: { adapters: WalletAdapter[] }): Promise<Discovery> };
  ExtensionAdapter: new (config: { providerId: string; name: string; icon?: string; description: string; target: string }) => WalletAdapter;
  RemoteAdapter: new (config: { name: string; rpcUrl: string }) => WalletAdapter;
};

/** The parts of Loop's library this file uses. */
export interface LoopLibrary { init(config: { appName: string; network?: "devnet" | "testnet" | "mainnet" }): void; getCip103Provider(): unknown }
/** Loop's library (`__WALLET_LOOP__`, src/vite-env.d.ts: true only in a build whose switch lists `loop`; false everywhere else, where the `import()` below goes with its branch). Its package has no licence, so its code is in a build only when the build lists `loop`: the `import()` sits in a branch of a build-time constant. */
async function loadLoop(): Promise<LoopLibrary> {
  if (__WALLET_LOOP__) return (await import("@fivenorth/loop-sdk")).loop as unknown as LoopLibrary;
  throw new Error("This build does not include Loop.");
}

let startedFor: string | null = null;
/**
 * Loop's own provider (the library's CIP-0103 one). It is started once, for the chain's network: the library refuses a second start, and starts on mainnet when it is given no network, so it is never
 * started without one, and never again for another.
 */
function loopProvider(lib: LoopLibrary, o: ConnectOptions): Cip103 {
  const network = loopNetwork(o.networkName);
  if (network === undefined) throw new Error("The network is not known, so Loop is not started.");
  if (startedFor === null) { lib.init({ appName: o.appName ?? "Ostia Bridge", network }); startedFor = network; }
  else if (startedFor !== network) throw new Error("Loop was started for another network.");
  return lib.getCip103Provider() as Cip103;
}

/** Loop as an adapter of the SDK. Its provider has the SDK's own provider type (checked against the published type definitions), so no conversion is needed. */
export function loopAdapter(lib: LoopLibrary, o: ConnectOptions): WalletAdapter {
  return {
    providerId: "loop", name: "Loop", type: "remote",
    getInfo: () => ({ providerId: "loop", name: "Loop", type: "remote", description: "Connect your Loop wallet" }),
    detect: async () => true,
    provider: () => loopProvider(lib, o),
    teardown: () => {},
    async restore() {
      try { const p = loopProvider(lib, o); return ((await p.request({ method: "isConnected" })) as { isConnected?: unknown }).isConnected ? p : null; } catch { return null; }
    },
  };
}

/** The browser wallets that announce themselves (an extension answers the `canton:requestProvider` event with `canton:announceProvider`, as the SDK's own discovery asks it to). */
export async function announcedWallets(timeoutMs = 300): Promise<{ id: string; name: string; icon?: string; target?: string }[]> {
  if (typeof window === "undefined") return [];
  const found = new Map<string, { id: string; name: string; icon?: string; target?: string }>();
  const heard = (event: Event) => {
    const d = (event as CustomEvent).detail as { id?: unknown; name?: unknown; icon?: unknown; target?: unknown } | undefined;
    if (typeof d?.id !== "string" || typeof d.name !== "string" || found.has(d.id)) return;
    found.set(d.id, { id: d.id, name: d.name, icon: typeof d.icon === "string" ? d.icon : undefined, target: typeof d.target === "string" ? d.target : undefined });
  };
  window.addEventListener("canton:announceProvider", heard);
  try {
    window.dispatchEvent(new CustomEvent("canton:requestProvider", { detail: {} }));
    await new Promise((done) => setTimeout(done, timeoutMs));
  } finally { window.removeEventListener("canton:announceProvider", heard); }
  return [...found.values()];
}

/** The adapters of this build's list: Loop's for `loop`, the Wallet Gateway for `gateway`, and each browser wallet that announces itself and answers the SDK's handshake for `extension`. */
async function adaptersOf(o: ConnectOptions): Promise<WalletAdapter[]> {
  const out: WalletAdapter[] = [];
  // Loop only when the chain's network is known: the library starts on mainnet when it is given none.
  if (o.wallets.includes("loop") && loopNetwork(o.networkName) !== undefined) out.push(loopAdapter(await loadLoop(), o));
  if (o.wallets.includes("gateway") && o.gatewayUrl) out.push(new Remote({ name: "Wallet Gateway", rpcUrl: o.gatewayUrl }));
  if (o.wallets.includes("extension")) {
    for (const w of await announcedWallets()) {
      const adapter = new Extension({ providerId: `browser:ext:${w.id}`, name: w.name, icon: w.icon, description: "Connect via a browser extension wallet", target: w.target ?? w.id });
      if (await adapter.detect()) out.push(adapter);
    }
  }
  return out;
}

let discovery: { key: string; client: Promise<Discovery> } | null = null;
/** What decides the adapters: the wallets, the gateway and Loop's network. A client made for other choices (before the network was known, when Loop was left out) is not kept. */
const keyOf = (o: ConnectOptions): string => JSON.stringify([o.wallets, o.gatewayUrl, loopNetwork(o.networkName) ?? null]);
/** The SDK's discovery client with this build's adapters, made once for these choices (it restores a session the browser kept). */
const client = (o: ConnectOptions): Promise<Discovery> => {
  const key = keyOf(o);
  if (discovery?.key !== key) {
    const made = { key, client: adaptersOf(o).then((adapters) => Client.create({ adapters })) };
    made.client.catch(() => { if (discovery === made) discovery = null; });
    discovery = made;
  }
  return discovery.client;
};

/** Forgets the discovery client, so the next call makes one again, as a reload does (the tests use this; the SDK keeps the session in the browser). */
export function startOver(): void { discovery = null; }

/** The wallet's name as the screen shows it. */
export function nameOf(adapter: Pick<WalletAdapter, "providerId" | "name">): string {
  return /loop/i.test(adapter.providerId) ? "Loop" : adapter.name || "Canton wallet";
}

/** The wallets the sheet offers: the adapters of this build that the browser can reach. */
export async function choices(o: ConnectOptions): Promise<Choice[]> {
  return (await client(o)).listAdapters().map((a) => ({ id: a.providerId, name: nameOf(a) }));
}

async function linked(d: Discovery): Promise<WalletLink> {
  const session = d.getActiveSession();
  if (!session) throw Object.assign(new Error("not connected"), { code: 4900 });
  const adapter = d.listAdapters().find((a) => a.providerId === session.providerId);
  // The SDK holds one session for every link. A link ends it only while it is still this link's own: a link made late (a stale approval, the second of a double restore) must not end a newer one.
  return linkWallet(session.provider, { name: adapter ? nameOf(adapter) : "Canton wallet", disconnect: async () => { if (d.getActiveSession()?.provider === session.provider) await d.disconnect(); } });
}

/** Connects the wallet the person picked, who approves in it. Rejects when the person declines (the error carries the wallet's own code, which `plainWords` knows). */
export async function connectWallet(o: ConnectOptions, id: string): Promise<WalletLink> {
  const d = await client(o);
  await d.connect(id);
  return linked(d);
}

/** The wallet this browser had connected, if the SDK can restore its session without asking; null when it cannot. */
export async function restoreWallet(o: ConnectOptions): Promise<WalletLink | null> {
  const d = await client(o);
  return d.getActiveSession() ? linked(d) : null;
}
