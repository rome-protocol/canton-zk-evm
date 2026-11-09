/**
 * The Content-Security-Policy of the explorer's HTML responses. The pages' scripts are the build's own files, so a script may come from this site only
 * ('self'): there is no inline script in the build, and the policy allows none. The Verify check instantiates a WebAssembly module, which needs 'wasm-unsafe-eval'
 * (it allows WebAssembly and not eval of text). When the faucet's human check is set up (CAPTCHA_SCRIPT_URL), the origin of that script is added, and nothing else.
 * Plugins are refused, and a page cannot change the base address its links are read against.
 * Only scripts are limited here: the page's fonts, styles, images and its requests (the API, the account service, the wallet) are not.
 */
export function contentSecurityPolicy(captchaScriptUrl: string | null = null): string {
  const sources = ["'self'", "'wasm-unsafe-eval'"];
  if (captchaScriptUrl) {
    try {
      const origin = new URL(captchaScriptUrl).origin;
      if (origin !== "null") sources.push(origin);
    } catch { /* a setting that is not an address names no host: the check's script is then refused, as the config check would have said */ }
  }
  return `script-src ${sources.join(" ")}; object-src 'none'; base-uri 'self'`;
}
