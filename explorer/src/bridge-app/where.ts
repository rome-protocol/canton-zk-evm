// Where the Bridge lives. The Bridge is the explorer's page (`/bridge`) until the build is given VITE_BRIDGE_ORIGIN; with it, the Bridge is its own site, the same code under bridge.html.
// These three answers are the only place a page asks where it is, so no page tests `location` itself.
type Env = Record<string, string | undefined>;
const env = (): Env => import.meta.env as Env;

/** The Bridge site's origin (`VITE_BRIDGE_ORIGIN`), or null while the switch is off. The build checks it (site-meta.ts). */
export const bridgeOrigin = (e: Env = env()): string | null => e.VITE_BRIDGE_ORIGIN?.trim() || null;

/** Whether this page runs as the Bridge site: bridge.html marks its document. */
export const inApp = (): boolean => typeof document !== "undefined" && document.documentElement.dataset.app === "bridge";

/** The explorer's origin: the page's own in the explorer; in the app the site setting (`VITE_SITE_ORIGIN`), or the page's own when the build has none (a local run). */
export const explorerOrigin = (e: Env = env()): string => {
  const given = e.VITE_SITE_ORIGIN?.trim();
  return inApp() && given ? given : location.origin;
};

/** The address of an explorer page: its path in the explorer, the full address in the app. */
export const explorerHref = (path: string, e: Env = env()): string => (inApp() ? explorerOrigin(e) + path : path);

/** The address of the Bridge, with the query (`?tab=other-chains`): the app's address, or `/bridge` while the switch is off. */
export const bridgeHref = (search = "", e: Env = env()): string => {
  const origin = bridgeOrigin(e);
  return origin ? `${origin}/${search}` : `/bridge${search}`;
};
