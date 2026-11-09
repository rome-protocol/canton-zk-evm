// Which Canton wallets the Bridge offers, from the build's environment (`VITE_CANTON_WALLETS`, a comma list of wallet ids). Unset or empty: none, and the page is the Bridge without a connect button.
// This file imports nothing from the wallet libraries, so the page can read the switch without loading them.

/** The wallets a build may offer. `loop`: Loop. `gateway`: a Wallet Gateway, from the SDK's own list of gateways. `extension`: wallets of the browser's own (the SDK's suggested wallets). */
export const WALLET_IDS = ["loop", "gateway", "extension"] as const;
export type WalletId = (typeof WALLET_IDS)[number];

/** What the screen calls each of them. */
export const WALLET_NAMES: Record<WalletId, string> = { loop: "Loop", gateway: "Wallet Gateway", extension: "Browser wallet" };

/** The wallets the switch lists, in the order it lists them, each once. A name that is not a wallet of this build is left out (and said on the console), so a typo never turns the page on by accident. */
export function walletsFromEnv(env: Record<string, string | undefined>): WalletId[] {
  const out: WalletId[] = [];
  for (const raw of (env.VITE_CANTON_WALLETS ?? "").split(",")) {
    const id = raw.trim().toLowerCase();
    if (id === "") continue;
    if (!(WALLET_IDS as readonly string[]).includes(id)) { console.warn(`VITE_CANTON_WALLETS names ${id}, which is not a wallet of this build`); continue; }
    if (!out.includes(id as WalletId)) out.push(id as WalletId);
  }
  return out;
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

/** "in Loop", "in your Canton wallet": how a sentence names the wallet where a person approves. */
export const inWallet = (name: string): string => (name === "Loop" ? "Loop" : `your ${name.toLowerCase()}`);
