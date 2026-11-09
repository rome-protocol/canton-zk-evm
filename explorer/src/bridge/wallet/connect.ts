// Connects a Canton wallet through Canton's dApp SDK: its picker lists the wallets this build offers, the person picks one and approves in it, and the connection comes back as a `WalletLink` (link.ts).
// Loop is added to the SDK as an adapter of its own (its library has a CIP-0103 provider, and registers nothing in the browser by itself). The Bridge page loads this file only when a person asks to
// connect, or when this browser connected a wallet before (`wasConnected`): the SDK is not in the page's first script.
import { DappSDK, type ProviderAdapter } from "@canton-network/dapp-sdk";
import { loop } from "@fivenorth/loop-sdk";
import { linkWallet, type Cip103, type WalletLink } from "./link.ts";
import { loopNetwork, type WalletId } from "./wallets.ts";

export interface ConnectOptions {
  /** The wallets this build offers (`VITE_CANTON_WALLETS`). */
  wallets: WalletId[];
  /** The Canton network the chain is on, as the chain names it ("DevNet"): Loop's library needs it. */
  networkName?: string | null;
  appName?: string;
}

type SdkOptions = NonNullable<Parameters<DappSDK["init"]>[0]>;
type Provider = ReturnType<ProviderAdapter["provider"]>;

let started = false;
/** Loop's own provider (the library's CIP-0103 one). It is started once: the library refuses a second start. */
function loopProvider(o: ConnectOptions): Provider {
  if (!started) { loop.init({ appName: o.appName ?? "Ostia Bridge", network: loopNetwork(o.networkName) }); started = true; }
  return loop.getCip103Provider();
}

/** Loop as an adapter of the SDK. Its provider has the SDK's own provider type, so no conversion is needed. */
export function loopAdapter(o: ConnectOptions): ProviderAdapter {
  return {
    providerId: "loop", name: "Loop", type: "remote",
    getInfo: () => ({ providerId: "loop", name: "Loop", type: "remote", description: "Connect your Loop wallet" }),
    detect: async () => true,
    provider: () => loopProvider(o),
    teardown: () => {},
    async restore() {
      try { const p = loopProvider(o); return (await p.request({ method: "isConnected" })).isConnected ? p : null; } catch { return null; }
    },
  };
}

/** What the SDK is given for this build's list: Loop's adapter for `loop`, the SDK's own gateways for `gateway`, and its suggested browser wallets for `extension`. */
export function sdkOptions(o: ConnectOptions): SdkOptions {
  return {
    defaultAdapters: o.wallets.includes("gateway") ? undefined : [],
    additionalAdapters: o.wallets.includes("loop") ? [loopAdapter(o)] : [],
    enableSuggestedWallets: o.wallets.includes("extension"),
  };
}

let sdk: DappSDK | null = null;
const theSdk = () => (sdk ??= new DappSDK());

/** The wallet's name as the screen shows it, from the provider's own id. */
export function nameOf(providerId: unknown): string {
  const id = typeof providerId === "string" ? providerId : "";
  return /loop/i.test(id) ? "Loop" : "Canton wallet";
}

async function linked(s: DappSDK): Promise<WalletLink> {
  const provider = s.getConnectedProvider();
  if (!provider) throw new Error("no connected provider");
  const status = (await provider.request({ method: "status" }).catch(() => null)) as { provider?: { id?: unknown } } | null;
  return linkWallet(provider as unknown as Cip103, { name: nameOf(status?.provider?.id), disconnect: () => s.disconnect() });
}

/** Opens the SDK's picker, and connects the wallet the person picks. Rejects when the person closes the picker or declines (the error carries the wallet's own code, which `plainWords` knows). */
export async function connectWallet(o: ConnectOptions): Promise<WalletLink> {
  const s = theSdk();
  await s.init(sdkOptions(o));
  const connection = await s.connect();
  if (!connection.isConnected) throw Object.assign(new Error("not connected"), { code: 4900 });
  return linked(s);
}

/** The wallet this browser had connected, if the SDK can restore its session without asking; null when it cannot. */
export async function restoreWallet(o: ConnectOptions): Promise<WalletLink | null> {
  const s = theSdk();
  await s.init(sdkOptions(o));
  if (!(await s.isConnected()).isConnected) return null;
  return linked(s);
}
