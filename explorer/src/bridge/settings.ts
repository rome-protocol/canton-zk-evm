// What the Bridge page is built with, read from the build's environment (explorer/README.md, "The Bridge page's settings"). One place, so the page reads it once.
import { chainFromEnv, originFromEnv, participantFromEnv, partyHintFromEnv, type Chain } from "./canton/env.ts";

export interface Settings {
  chain: Chain;
  /** The participant that hosts the accounts (`VITE_CANTON_PARTICIPANT`); "" in a build without the Bridge account, which has no account to host. */
  participant: string;
  /** The name an account is given before its key's fingerprint (`VITE_PARTY_HINT`, `rome` by default). */
  partyHint: string;
  /** The base of the account service's requests for `AccountsClient`: always "", this site (its endpoints are under /accounts/v1). */
  accountsBase: string;
  /** The site's origin, shown beside the sign-in so a person can check where they are. */
  origin: string;
}

/** `VITE_ACCOUNTS_URL` names the service's /accounts path on this site ("/accounts", the default): the page asks the site it was loaded from, so no cross-origin request is made. An address with another
 * origin is refused. The result is the base of the client's requests: "" (the client's own paths start with /accounts/v1). */
export function accountsBase(url = "/accounts"): string {
  if (url.replace(/\/+$/, "") !== "/accounts") throw new Error("VITE_ACCOUNTS_URL must be /accounts, a path on this site");
  return "";
}

/**
 * Throws when a setting the page needs is missing: the page then says the bridge is not set up here. The participant, the party hint and the service's path are the Bridge account's (`account`, this build's
 * VITE_BRIDGE_ACCOUNT): a build without it needs and reads none of them.
 */
export function settingsFromEnv(env: Record<string, string | undefined>, account: boolean = __BRIDGE_ACCOUNT__): Settings {
  const chain = chainFromEnv(env), origin = originFromEnv(env);
  if (!account) return { chain, participant: "", partyHint: "", accountsBase: "", origin };
  return { chain, participant: participantFromEnv(env), partyHint: partyHintFromEnv(env), accountsBase: accountsBase(env.VITE_ACCOUNTS_URL || undefined), origin };
}
/** The settings of this build, or null when the bridge is not set up in it. */
export function buildSettings(): Settings | null {
  try { return settingsFromEnv(import.meta.env); } catch (e) { console.warn(e instanceof Error ? e.message : e); return null; }
}
