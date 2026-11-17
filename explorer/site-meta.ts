/**
 * The network's name and the site's origin in index.html: the title, the description, the og:* and twitter:* tags and the card image's address. They are written into the page when it is built
 * (the plugin in vite.config.ts), from VITE_NETWORK_NAME (default "DevNet") and VITE_SITE_ORIGIN (the scheme and the host, no path), the same settings the rest of the build reads.
 * With no setting the page is DevNet's. A build for another network must give its origin: DevNet's address is never put on another network's page.
 */
const DEFAULT_NETWORK = "DevNet";
const DEFAULT_ORIGIN = "https://ostia.devnet.romeprotocol.xyz";

export function siteMeta(env: Record<string, string | undefined>): { networkName: string; origin: string } {
  const networkName = env.VITE_NETWORK_NAME?.trim() || DEFAULT_NETWORK;
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,31}$/.test(networkName)) throw new Error("VITE_NETWORK_NAME is not a name (letters, digits, spaces and hyphens)");
  const given = env.VITE_SITE_ORIGIN?.trim() ?? "";
  if (given === "" && networkName !== DEFAULT_NETWORK) throw new Error(`VITE_SITE_ORIGIN is not set: a ${networkName} build needs its own site origin`);
  const origin = given || DEFAULT_ORIGIN;
  let parsed: URL | null = null;
  try { parsed = new URL(origin); } catch { /* not a URL */ }
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== origin) throw new Error("VITE_SITE_ORIGIN is not set to an origin (the scheme and the host)");
  return { networkName, origin };
}

/** index.html with its two placeholders, %NETWORK_NAME% and %SITE_ORIGIN%, filled in. */
export function withSiteMeta(html: string, env: Record<string, string | undefined>): string {
  const { networkName, origin } = siteMeta(env);
  return html.replaceAll("%NETWORK_NAME%", networkName).replaceAll("%SITE_ORIGIN%", origin);
}
