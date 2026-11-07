// What the Bridge page is built with, read from the build's environment (explorer/README.md, "The Bridge page's settings"). One place, so the page reads it once.
import { chainFromEnv, originFromEnv, participantFromEnv, type Chain } from "./canton/env.ts";

export interface Settings {
  chain: Chain;
  participant: string;
  /** The account service's origin for `AccountsClient` ("" for this site): its endpoints are always under /accounts/v1. */
  accountsBase: string;
  /** The site's origin, shown beside the sign-in so a person can check where they are. */
  origin: string;
}

/** `VITE_ACCOUNTS_URL` is the address of the service's /accounts path: "/accounts" (the default) is this site's own, and a full address names another origin. The trailing /accounts is the client's own. */
export const accountsBase = (url = "/accounts"): string => url.replace(/\/+$/, "").replace(/\/accounts$/, "");

/** Throws when a setting the page needs is missing: the page then says the bridge is not set up here. */
export function settingsFromEnv(env: Record<string, string | undefined>): Settings {
  return { chain: chainFromEnv(env), participant: participantFromEnv(env), accountsBase: accountsBase(env.VITE_ACCOUNTS_URL || undefined), origin: originFromEnv(env) };
}
/** The settings of this build, or null when the bridge is not set up in it. */
export function buildSettings(): Settings | null {
  try { return settingsFromEnv(import.meta.env); } catch (e) { console.warn(e instanceof Error ? e.message : e); return null; }
}
