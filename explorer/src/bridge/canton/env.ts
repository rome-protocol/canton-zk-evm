// What the Bridge page is built with, read from the build's environment (`VITE_*`). Kept apart from the signing code so that the page can read its settings without loading it.

/** The participant that hosts every account (`VITE_CANTON_PARTICIPANT`: its id as the Ledger API says it, PAR::name::fingerprint): an account is onboarded only onto it. */
export function participantFromEnv(env: Record<string, string | undefined>): string {
  const participant = env.VITE_CANTON_PARTICIPANT;
  if (!participant) throw new Error("VITE_CANTON_PARTICIPANT is not set");
  return participant;
}

/** The name every account is given before its key's fingerprint (`VITE_PARTY_HINT`, `rome` by default). It must be the hint the account service runs with (`--party-hint`): the page refuses an account named otherwise. */
export function partyHintFromEnv(env: Record<string, string | undefined>): string {
  const hint = env.VITE_PARTY_HINT || "rome";
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(hint)) throw new Error("VITE_PARTY_HINT is not a name of letters, digits, - and _ (32 at most)");
  return hint;
}

/** The chain's parties and id, from the page's configuration (`VITE_CHAIN_*`): never written into the code. */
export interface Chain { operator: string; confirmer: string; gateway: string; builder: string; chainId: number }
export function chainFromEnv(env: Record<string, string | undefined>): Chain {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  return { operator: need("VITE_CHAIN_OPERATOR"), confirmer: need("VITE_CHAIN_CONFIRMER"), gateway: need("VITE_CHAIN_GATEWAY"), builder: need("VITE_CHAIN_BUILDER"), chainId: Number(need("VITE_CHAIN_ID")) };
}

/** The site's origin, from the page's configuration (`VITE_SITE_ORIGIN`: the scheme and the host of the site, as `location.origin` says it, with no path). */
export function originFromEnv(env: Record<string, string | undefined>): string {
  const origin = env.VITE_SITE_ORIGIN ?? "";
  let parsed: URL | null = null;
  try { parsed = new URL(origin); } catch { /* not a URL */ }
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== origin) throw new Error("VITE_SITE_ORIGIN is not set to an origin (the scheme and the host)");
  return origin;
}
