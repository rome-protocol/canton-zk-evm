// Connects a Canton wallet through Canton's dApp SDK. The page lists the wallets this build offers (the sheet's own buttons), the person picks one and approves in it, and the connection comes back as a
// `WalletLink` (link.ts). The SDK's discovery client holds the adapters: Loop's (its library has a CIP-0103 provider, and registers nothing in the browser by itself), a Wallet Gateway's, and the
// browser wallets that announce themselves; it also restores a session after a reload. The Bridge page loads this file only when a person asks to connect, or when this browser connected a wallet before
// (`wasConnected`): the SDK is not in the page's first script.
import { DiscoveryClient, ExtensionAdapter, RemoteAdapter } from "@canton-network/dapp-sdk";
import { loop } from "@fivenorth/loop-sdk";
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
const Client = DiscoveryClient as unknown as { create(config: { adapters: WalletAdapter[] }): Promise<Discovery> };
const Extension = ExtensionAdapter as unknown as new (config: { providerId: string; name: string; icon?: string; description: string; target: string }) => WalletAdapter;
const Remote = RemoteAdapter as unknown as new (config: { name: string; rpcUrl: string }) => WalletAdapter;

let started = false;
/** Loop's own provider (the library's CIP-0103 one). It is started once: the library refuses a second start. */
function loopProvider(o: ConnectOptions): Cip103 {
  if (!started) { loop.init({ appName: o.appName ?? "Ostia Bridge", network: loopNetwork(o.networkName) }); started = true; }
  return loop.getCip103Provider() as Cip103;
}

/** Loop as an adapter of the SDK. Its provider has the SDK's own provider type (checked against the published type definitions), so no conversion is needed. */
export function loopAdapter(o: ConnectOptions): WalletAdapter {
  return {
    providerId: "loop", name: "Loop", type: "remote",
    getInfo: () => ({ providerId: "loop", name: "Loop", type: "remote", description: "Connect your Loop wallet" }),
    detect: async () => true,
    provider: () => loopProvider(o),
    teardown: () => {},
    async restore() {
      try { const p = loopProvider(o); return ((await p.request({ method: "isConnected" })) as { isConnected?: unknown }).isConnected ? p : null; } catch { return null; }
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
  if (o.wallets.includes("loop")) out.push(loopAdapter(o));
  if (o.wallets.includes("gateway") && o.gatewayUrl) out.push(new Remote({ name: "Wallet Gateway", rpcUrl: o.gatewayUrl }));
  if (o.wallets.includes("extension")) {
    for (const w of await announcedWallets()) {
      const adapter = new Extension({ providerId: `browser:ext:${w.id}`, name: w.name, icon: w.icon, description: "Connect via a browser extension wallet", target: w.target ?? w.id });
      if (await adapter.detect()) out.push(adapter);
    }
  }
  return out;
}

let discovery: Promise<Discovery> | null = null;
/** The SDK's discovery client with this build's adapters, made once (it restores a session the browser kept). */
const client = (o: ConnectOptions): Promise<Discovery> => (discovery ??= adaptersOf(o).then((adapters) => Client.create({ adapters })).catch((e) => { discovery = null; throw e; }));

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
  return linkWallet(session.provider, { name: adapter ? nameOf(adapter) : "Canton wallet", disconnect: () => d.disconnect() });
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
