// The Canton side of a move for a connected wallet. It is the move library's own Canton adapter (adapter.ts), with the wallet in the two places the account service and the page's key were: the reads
// come from the wallet's ledger and the public registry route (ledger.ts), and each command goes to the wallet, which shows it to its person, signs it and sends it (link.ts). So every rule of that adapter holds
// here too: each call looks at the ledger first and does nothing again for a ref, a label or a deposit id that is already there, and nothing is signed twice after a reload. The page's own check of a
// prepared transaction (canton/sign.ts) does not run on this path: the wallet prepares the transaction itself, and it is the wallet that shows it.
import { cantonAdapter } from "../adapter.ts";
import { AccountsError } from "../canton/accounts.ts";
import { twinAcceptance, withdrawalAcceptance, type Built, type Chain } from "../canton/commands.ts";
import type { CantonKey } from "../canton/key.ts";
import type { CantonAdapter } from "../moves/moves.ts";
import { PageError } from "../words.ts";
import type { WalletLink } from "./link.ts";
import { PublicRegistry, WalletClient, WalletLedger } from "./ledger.ts";

/** What stands where an account's key stands: a wallet's account has none that the page holds, and nothing signs with this (the library's signer refuses any key it did not make). */
export const NO_KEY: CantonKey = { publicKey: new Uint8Array(0) };

/** How often a wait looks: each look is a call through the wallet. */
export const WALLET_POLL_MS = 4000;
const sleepFor = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** A connected wallet's account, in the shape the move library's session takes. */
export interface WalletAccount {
  key: CantonKey;
  party: string;
  client: WalletClient;
  chain: Chain;
  submit(built: Built): Promise<string>;
}

export function walletAccount(link: Pick<WalletLink, "party" | "ledgerApi" | "submit">, chain: Chain, registryBase = "", fetcher?: typeof fetch): WalletAccount {
  return { key: NO_KEY, party: link.party, client: new WalletClient(new WalletLedger(link, chain), new PublicRegistry(registryBase, fetcher)), chain, submit: (built) => link.submit(built) };
}

/** The Canton adapter of a connected wallet's account. */
export function walletAdapter(a: Pick<WalletAccount, "party" | "client" | "chain" | "submit">, sleep: (ms: number) => Promise<void> = sleepFor, pollMs = WALLET_POLL_MS): CantonAdapter {
  return cantonAdapter({ client: a.client, key: NO_KEY, party: a.party, chain: a.chain, submit: a.submit, sleep, pollMs });
}

/** Whether the account has made its two standing acceptances (of Ostia tokens, and of withdrawals): read from the ledger. */
export async function optedIn(a: Pick<WalletAccount, "client" | "party">): Promise<boolean> {
  const o = await a.client.openRequests(NO_KEY, a.party);
  return Boolean(o.twinAcceptance) && Boolean(o.withdrawalAcceptance);
}

/**
 * The account's two standing acceptances, made once, each approved in the wallet. The ledger is read first and only a missing one is asked for; a repeat after a reload asks for what is left. The account
 * is set up only when a second read shows both (the wallet may report a command before the ledger shows it).
 */
export async function optIn(a: Pick<WalletAccount, "party" | "client" | "chain" | "submit">, sleep: (ms: number) => Promise<void> = sleepFor, looks = 8): Promise<void> {
  const have = await a.client.openRequests(NO_KEY, a.party);
  for (const [has, built] of [[have.twinAcceptance, twinAcceptance(a.party, a.chain)], [have.withdrawalAcceptance, withdrawalAcceptance(a.party, a.chain)]] as const) {
    if (has) continue;
    await a.submit(built);
  }
  for (let i = 0; i < looks; i++) {
    try { if (await optedIn(a)) return; } catch (e) { if (!(e instanceof AccountsError && ["rate-limited", "unavailable", "network"].includes(e.kind))) throw e; }
    if (i < looks - 1) await sleep(1500);
  }
  throw new PageError("acceptances_missing", "The account's two acceptances are not both there.");
}
