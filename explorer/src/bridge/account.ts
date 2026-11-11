// The person's Canton account, opened from the wallet, and what the account sheet does with it. The Bridge page loads this file when the person asks to sign in, so the signing code is
// not in the page's first script.
import type { Eip1193 } from "../wallet.ts";
import { AccountsClient, AccountsError, acceptChoice } from "./canton/accounts.ts";
import { acceptTransfer, twinAcceptance, withdrawalAcceptance, type Built, type Chain } from "./canton/commands.ts";
import { confirmKey, keyFromStored, openKey, storableKey, type CantonKey } from "./canton/key.ts";
import { browserKeyStore, type KeyStore } from "./canton/keystore.ts";
import { partyOf } from "./canton/topology.ts";
import { submit } from "./canton/sign.ts";
import type { Settings } from "./settings.ts";
import { PageError } from "./words.ts";
import { otherAccountOf } from "./activity.ts";
import { moveStore, type StoreLike } from "./moves/state.ts";
import { short } from "../format.ts";

export interface Account {
  key: CantonKey;
  party: string;
  client: AccountsClient;
  chain: Chain;
  /** Prepares, checks, signs and executes one command of the account. One command at a time: a command that is already on its way is not sent again (the same call gets the same answer). */
  submit(built: Built): Promise<string>;
  /** A faucet offer that was made and not yet accepted: an accept that failed is tried again with it, without asking the faucet again. */
  offer?: string;
  /** True when this browser keeps the account's key (a non-extractable WebCrypto key in IndexedDB), so a reload opens the account without a signature. */
  kept?: boolean;
  /** Set when the wallet's account changed: this account then does nothing more. */
  closed?: boolean;
  /** Lets this account go (the wallet's account changed): nothing more is signed or sent for it. */
  close(): void;
}

const sleepFor = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const closedError = () => new PageError("account_closed", "The wallet's account changed, so this account does nothing more.");

/** One command at a time. The same command, while it is on its way (running or waiting its turn), gets the one answer and is not sent twice; a different command waits for the one before it. */
export function oneAtATime(run: (built: Built) => Promise<string>): (built: Built) => Promise<string> {
  const pending = new Map<string, Promise<string>>();
  let tail: Promise<unknown> = Promise.resolve();
  return (built) => {
    const same = JSON.stringify(built.command);
    const on = pending.get(same);
    if (on) return on;
    const mine = tail.then(() => run(built)).finally(() => pending.delete(same));
    pending.set(same, mine);
    tail = mine.catch(() => {});
    return mine;
  };
}

/** The account's two standing acceptances, made once: of Ostia tokens (twins) and of withdrawals. The account is read first, and only a missing one is made. A service that says the account has one
 * (`already_accepted`) is taken at its word. The account is set up only when a second read shows both. */
export async function optIn(a: Pick<Account, "key" | "party" | "chain" | "client" | "submit">, sleep: (ms: number) => Promise<void> = sleepFor, looks = 8, current: () => boolean = () => true): Promise<void> {
  const read = async () => { if (!current()) throw closedError(); const o = await a.client.openRequests(a.key, a.party); return { twin: Boolean(o.twinAcceptance), withdrawal: Boolean(o.withdrawalAcceptance) }; };
  const have = await read();
  for (const [has, built] of [[have.twin, twinAcceptance(a.party, a.chain)], [have.withdrawal, withdrawalAcceptance(a.party, a.chain)]] as const) {
    if (has) continue;
    try { await a.submit(built); } catch (e) { if (!(e instanceof AccountsError && e.code === "already_accepted")) throw e; }
  }
  for (let i = 0; i < looks; i++) {
    const now = await read();
    if (now.twin && now.withdrawal) return;
    if (i < looks - 1) await sleep(1500);
  }
  throw new PageError("acceptances_missing", "The account's two acceptances are not both there.");
}

/** The account of a key that is open and checked: the page's signing and one-at-a-time rules around it. */
function makeAccount(key: CantonKey, party: string, client: AccountsClient, s: Settings, current: () => boolean): Account {
  // The check is made when a command starts, not when it is handed in: a command that waited its turn is not signed after the account was let go.
  const send = oneAtATime((built) => (account.closed || !current() ? Promise.reject(closedError()) : submit(client, key, party, built)));
  const account: Account = {
    key, party, client, chain: s.chain, closed: false,
    submit: async (built) => { if (account.closed || !current()) throw closedError(); return send(built); },
    close: () => { account.closed = true; },
  };
  return account;
}

/** Keeps the key in this browser, when it can (the key is a non-extractable WebCrypto key and the browser has IndexedDB). Never throws: the account works for this visit either way. */
async function keep(account: Account, wallet: string, store: KeyStore): Promise<void> {
  const privateKey = storableKey(account.key);
  if (!privateKey) return;
  account.kept = await store.save({ wallet: wallet.toLowerCase(), party: account.party, publicKey: account.key.publicKey, privateKey });
}

/** One wallet signature makes the key; the account is opened (made, on the first visit, after a second signature that proves the wallet signs the same way twice) and opted in. It is Ready only
 * when both acceptances are read back. `current` says whether the wallet's account is still the one being opened: when it is not, nothing more is asked or signed. Once Ready, the key is kept in
 * this browser (keystore.ts) where the browser can, so that a reload opens the account again without a signature (`reopenAccount`). */
export async function openAccount(wallet: Eip1193, address: string, s: Settings, progress: (note: string) => void = () => {}, client = new AccountsClient(s.accountsBase), current: () => boolean = () => true, store: KeyStore = browserKeyStore(), moves: StoreLike | null = moveStore()): Promise<Account> {
  const still = () => { if (!current()) throw closedError(); };
  progress("Sign the message in your wallet.");
  const key = await openKey(wallet, address);
  still();
  progress("Opening your account.");
  const party = await client.open(key, s.participant, s.partyHint, async () => {
    still();
    // No account of this key exists yet. If this browser's records show an account made with this wallet address before, the wallet now signs another way: stop before a second, empty account is made.
    const next = await partyOf(key.publicKey, s.partyHint);
    if (otherAccountOf(moves, address, next)) throw new PageError("second_account", "This wallet signs differently from before.");
    progress(`This wallet has no Canton account on Ostia yet (${short(next, 16, 6)}). If you opened one with this wallet before, reject the next pop-up: your wallet now signs differently, and continuing makes a second, empty account. Otherwise sign once more to confirm.`);
    await confirmKey(wallet, address, key);
  });
  still();
  const account = makeAccount(key, party, client, s, current);
  progress("Setting up your account.");
  await optIn(account, sleepFor, 8, () => !account.closed && current());
  still();
  await keep(account, address, store);
  return account;
}

/**
 * Opens the account again from the key this browser kept for this wallet address, with no signature of the wallet. It is null (and the person signs in as before) when nothing is kept for this
 * address, the kept key is not an Ed25519 private key that is not extractable and the pair of its public half, the account address is not this build's name and the fingerprint of that public half, or the service does
 * not know the account. A kept key that is not the account's is removed. The store is asked for exactly this wallet address, so another address's key is never looked at. Then the same
 * checks as a sign-in: both acceptances are read back before the account is Ready.
 */
export async function reopenAccount(address: string, s: Settings, progress: (note: string) => void = () => {}, client = new AccountsClient(s.accountsBase), current: () => boolean = () => true, store: KeyStore = browserKeyStore()): Promise<Account | null> {
  const still = () => { if (!current()) throw closedError(); };
  const record = await store.load(address);
  still();
  if (!record || record.wallet !== address.toLowerCase()) return null;
  const key = await keyFromStored(record.privateKey, record.publicKey);
  if (!key || (await partyOf(key.publicKey, s.partyHint)) !== record.party) { await store.remove(address).catch(() => {}); return null; }
  progress("Opening your account.");
  const party = await client.find(key.publicKey, s.partyHint);
  still();
  if (party !== record.party) return null;
  const account = makeAccount(key, party, client, s, current);
  progress("Setting up your account.");
  await optIn(account, sleepFor, 8, () => !account.closed && current());
  still();
  account.kept = true;
  return account;
}

/** "Remove my Canton key from this browser": removes what this browser keeps for the wallet address, and lets the open account go. Rejects, leaving the account open, if the browser cannot remove it. */
export async function closeAccount(account: Pick<Account, "close">, address: string, store: KeyStore = browserKeyStore()): Promise<void> {
  await store.remove(address);
  account.close();
}

/** Test Canton Coin from the service's faucet: accepts the offer it makes. "off" when this deployment has no faucet. `admin` is Canton Coin's registry. An offer whose accept failed is kept (on
 * the account), and the next call accepts that offer again instead of asking the faucet for another. */
export async function getTestCoin(a: Pick<Account, "key" | "party" | "client" | "submit" | "offer" | "closed">, admin: string): Promise<"done" | "off"> {
  const open = () => { if (a.closed) throw closedError(); };
  open();
  if (!a.offer) {
    let offered: Awaited<ReturnType<AccountsClient["faucet"]>>;
    try { offered = await a.client.faucet(a.key, a.party); } catch (e) { if (e instanceof AccountsError && e.kind === "not-found") return "off"; throw e; }
    if (offered.completed) return "done";
    if (!offered.transferInstructionCid) throw new PageError("faucet_no_offer", "The faucet did not offer any Canton Coin.");
    a.offer = offered.transferInstructionCid;
  }
  const offer = a.offer;
  try {
    open();
    const registry = acceptChoice(await a.client.acceptContext(a.key, admin, offer, a.party));
    open();
    await a.submit(acceptTransfer(a.party, offer, registry));
  } catch (e) {
    // An offer the registry or the ledger no longer knows (gone, taken, or past its time) is let go, so the next call asks for a new one. The service relays a registry 404 as a 502 that
    // carries the registry's status. Any other failure keeps the offer.
    if (e instanceof AccountsError && (e.kind === "not-found" || e.kind === "refused" || (e.kind === "unavailable" && e.registryStatus === 404))) a.offer = undefined;
    throw e;
  }
  a.offer = undefined;
  return "done";
}
