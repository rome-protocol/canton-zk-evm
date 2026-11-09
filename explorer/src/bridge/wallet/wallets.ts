// Which Canton wallets the Bridge offers, from the build's environment (`VITE_CANTON_WALLETS`, a comma list of wallet ids). Unset or empty: none, and the page is the Bridge without a connect button.
// This file imports nothing from the wallet libraries, so the page can read the switch without loading them.

/** The wallets a build may offer. `loop`: Loop. `gateway`: a Wallet Gateway, at the address `VITE_CANTON_GATEWAY_URL` gives. `extension`: the wallets that announce themselves in the browser (browser extensions). */
export const WALLET_IDS = ["loop", "gateway", "extension"] as const;
export type WalletId = (typeof WALLET_IDS)[number];

/** What the screen calls each of them. */
export const WALLET_NAMES: Record<WalletId, string> = { loop: "Loop", gateway: "Wallet Gateway", extension: "Browser wallet" };

/** What the build offers: the wallets the switch lists, and the Wallet Gateway's address (`VITE_CANTON_GATEWAY_URL`, its RPC URL as `http:` or `https:`), which `gateway` needs. */
export interface WalletConfig { wallets: WalletId[]; gatewayUrl: string | null }
/** The wallets the switch lists, in the order it lists them, each once. A name that is not a wallet of this build is left out (and said on the console), so a typo never turns the page on by accident; so is `gateway` without an address. */
export function walletsFromEnv(env: Record<string, string | undefined>): WalletConfig {
  let gatewayUrl: string | null = null;
  const url = (env.VITE_CANTON_GATEWAY_URL ?? "").trim();
  if (url !== "") {
    try { const u = new URL(url); if (u.protocol === "http:" || u.protocol === "https:") gatewayUrl = u.href; } catch { /* not an address */ }
    if (gatewayUrl === null) console.warn("VITE_CANTON_GATEWAY_URL is not an http or https address");
  }
  const wallets: WalletId[] = [];
  for (const raw of (env.VITE_CANTON_WALLETS ?? "").split(",")) {
    const id = raw.trim().toLowerCase();
    if (id === "") continue;
    if (!(WALLET_IDS as readonly string[]).includes(id)) { console.warn(`VITE_CANTON_WALLETS names ${id}, which is not a wallet of this build`); continue; }
    if (id === "gateway" && gatewayUrl === null) { console.warn("VITE_CANTON_WALLETS names gateway, which needs VITE_CANTON_GATEWAY_URL"); continue; }
    if (!wallets.includes(id as WalletId)) wallets.push(id as WalletId);
  }
  return { wallets, gatewayUrl };
}

/** The network name Loop's library wants, from the chain's own ("DevNet", "TestNet", "MainNet"); undefined when the chain's name is none of them (the library then uses its own default). */
export function loopNetwork(networkName: string | null | undefined): "devnet" | "testnet" | "mainnet" | undefined {
  const n = (networkName ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return n === "devnet" || n === "testnet" || n === "mainnet" ? n : undefined;
}

/** What this browser remembers of a connected wallet: that there was one, so the page asks the SDK to restore it (and loads the SDK only then). Never throws: without storage the person connects again. */
const MARK = "ostia-bridge-canton-wallet";
export function rememberWallet(): void { try { localStorage.setItem(MARK, "1"); } catch { /* no storage */ } }
export function forgetWallet(): void { try { localStorage.removeItem(MARK); } catch { /* no storage */ } }
export function wasConnected(): boolean { try { return localStorage.getItem(MARK) === "1"; } catch { return false; } }

/** "in Loop", "in your Canton wallet": how a sentence names the wallet where a person approves (a wallet with a name of its own is called by it). */
export const inWallet = (name: string): string => (name === "Canton wallet" ? "your Canton wallet" : name);
