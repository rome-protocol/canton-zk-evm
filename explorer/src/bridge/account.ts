// The person's Canton account, opened from the wallet, and what the account sheet does with it. The Bridge page loads this file when the person asks to sign in, so the signing code is
// not in the page's first script.
import type { Eip1193 } from "../wallet.ts";
import { AccountsClient, AccountsError, registryChoice } from "./canton/accounts.ts";
import { acceptTransfer, twinAcceptance, withdrawalAcceptance, type Built, type Chain } from "./canton/commands.ts";
import { confirmKey, openKey, type CantonKey } from "./canton/key.ts";
import { submit } from "./canton/sign.ts";
import type { Settings } from "./settings.ts";

export interface Account {
  key: CantonKey;
  party: string;
  client: AccountsClient;
  chain: Chain;
  /** Prepares, checks, signs and executes one command of the account. */
  submit(built: Built): Promise<string>;
}

/** The account's two standing acceptances, made once: of Ostia tokens (twins) and of withdrawals. The service refuses a second open one (409), which is how an account that has them says so. */
export async function optIn(a: Pick<Account, "party" | "chain" | "submit">): Promise<void> {
  for (const built of [twinAcceptance(a.party, a.chain), withdrawalAcceptance(a.party, a.chain)]) {
    try { await a.submit(built); } catch (e) { if (!(e instanceof AccountsError && e.kind === "conflict")) throw e; }
  }
}

/** One wallet signature makes the key; the account is opened (made, on the first visit, after a second signature that proves the wallet signs the same way twice) and opted in. */
export async function openAccount(wallet: Eip1193, address: string, s: Settings, progress: (note: string) => void = () => {}, client = new AccountsClient(s.accountsBase)): Promise<Account> {
  progress("Sign the message in your wallet.");
  const key = await openKey(wallet, address);
  progress("Opening your account.");
  const party = await client.open(key, s.participant, () => { progress("Sign once more to confirm. This only happens when an account is first made."); return confirmKey(wallet, address, key); });
  const account: Account = { key, party, client, chain: s.chain, submit: (built) => submit(client, key, party, built) };
  progress("Setting up your account.");
  await optIn(account);
  return account;
}

/** Test Canton Coin from the service's faucet: accepts the offer it makes. "off" when this deployment has no faucet. `admin` is Canton Coin's registry. */
export async function getTestCoin(a: Pick<Account, "key" | "party" | "client" | "submit">, admin: string): Promise<"done" | "off"> {
  let offer: Awaited<ReturnType<AccountsClient["faucet"]>>;
  try { offer = await a.client.faucet(a.key, a.party); } catch (e) { if (e instanceof AccountsError && e.kind === "not-found") return "off"; throw e; }
  if (offer.completed) return "done";
  if (!offer.transferInstructionCid) throw new Error("The faucet did not offer any Canton Coin.");
  const registry = registryChoice(await a.client.acceptContext(a.key, admin, offer.transferInstructionCid, a.party));
  await a.submit(acceptTransfer(a.party, offer.transferInstructionCid, registry));
  return "done";
}
