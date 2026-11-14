/**
 * The Content-Security-Policy of the explorer's HTML responses. The pages' scripts are the build's own files, so a script may come from this site only
 * ('self'): there is no inline script in the build, and the policy allows none. The Verify check instantiates a WebAssembly module, which needs 'wasm-unsafe-eval'
 * (it allows WebAssembly and not eval of text). When the faucet's human check is set up (CAPTCHA_SCRIPT_URL), the origin of that script is added, and nothing else.
 * Plugins are refused, and a page cannot change the base address its links are read against. No other site may frame a page (a page that holds a Bridge key
 * must not be framed and clicked through), and a form on a page may submit to this site only. The faucet's GitHub sign-in is a link, not a form.
 * Only scripts are limited otherwise: the page's fonts, styles, images and its requests (the API, the account service, the wallet) are not.
 */
export function contentSecurityPolicy(captchaScriptUrl: string | null = null): string {
  const sources = ["'self'", "'wasm-unsafe-eval'"];
  if (captchaScriptUrl) {
    try {
      const origin = new URL(captchaScriptUrl).origin;
      if (origin !== "null") sources.push(origin);
    } catch { /* a setting that is not an address names no host: the check's script is then refused, as the config check would have said */ }
  }
  return `script-src ${sources.join(" ")}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`;
}

/**
 * The headers on every answer, beside the policy on the HTML pages. `X-Frame-Options` says the same as `frame-ancestors` to a browser that does not read it.
 * `Referrer-Policy` is the browsers' own default, written down, so that a page's address goes to another site as its origin only. HSTS makes a browser
 * use https for this host for a year (a browser ignores it over plain http, as on a local run); no `includeSubDomains` and no `preload`, which would reach
 * hosts this server does not speak for. A route may set its own `referrer-policy` (the builder's sign-in returns send no-referrer), and that one wins.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000",
};
