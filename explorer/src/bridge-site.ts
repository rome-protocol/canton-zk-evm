// Where the Bridge site is: its own address (VITE_BRIDGE_ORIGIN, checked by site-meta.ts), or none in a local run.
type Env = Record<string, string | undefined>;
const env = (): Env => import.meta.env as Env;

/** The Bridge site's origin, or null while the build has none. */
export const bridgeOrigin = (e: Env = env()): string | null => e.VITE_BRIDGE_ORIGIN?.trim() || null;

/** The address of the Bridge site with the query (`?tab=other-chains`); `/bridge` while the build has no origin. */
export const bridgeHref = (search = "", e: Env = env()): string => {
  const origin = bridgeOrigin(e);
  return origin ? `${origin}/${search}` : `/bridge${search}`;
};
