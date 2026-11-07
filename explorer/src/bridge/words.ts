// What the Bridge page tells a person when something goes wrong, in plain words. Every error that can reach the screen goes through `plainWords`: a known case has its own sentence,
// and anything else gets one general sentence. A code, a technical name or a stack trace is never shown. This file imports nothing that signs, so the page can load it at once.

export const GENERIC = "Something went wrong. Nothing was lost. Try again in a moment.";

/** A conflict the account service names by a stable code. */
const CONFLICTS: Record<string, string> = {
  already_accepted: "Your account already has this set up.",
  too_many_open: "Your account already has as many of these open as it may. Wait for them to finish, then try again.",
  waiting_for_signature: "A step for your account from a moment ago is still open. Try again in 10 minutes.",
  account_key_unknown: "The bridge no longer knows this account's key. Sign in again to set it up again.",
};
/** The other errors the page's own code raises, by the code it gives them. */
const CODES: Record<string, string> = {
  no_choice_context: "Canton did not send everything this step needs, so nothing was signed. Try again in a moment.",
  acceptances_missing: "Your account is not set up yet. Try signing in again in a moment.",
  origin_mismatch: "This page is not at the address this bridge is set up for, so signing is turned off here. Open the bridge from its own address.",
  account_closed: "Your wallet account changed. Sign in again with the account you want to use.",
  wallet_not_deterministic: "This wallet signs differently each time, so it cannot hold a Canton account here. Use another wallet.",
  wrong_signer: "Your wallet signed with a different account. Pick the connected account in your wallet and try again.",
  no_canton_coin: "This site does not offer Canton Coin yet.",
  faucet_no_offer: "The faucet did not send Canton Coin. Try again later.",
};
/** An answer of the account service, by its kind. */
const KINDS: Record<string, string> = {
  "bad-request": "The bridge could not read this request. Try again.",
  unauthorized: "The bridge did not accept your signature. Sign in again.",
  forbidden: "The bridge does not allow this here.",
  "not-found": "The bridge does not have this. Try again.",
  refused: "Canton did not accept this step. Nothing was changed.",
  unavailable: "The bridge is busy or restarting. Try again in a moment.",
  network: "The bridge could not be reached. Check your connection and try again.",
  server: GENERIC,
  conflict: GENERIC,
};
/** Errors that carry their own words, written in plain English by the page (a move that stopped for the person). */
const OWN_WORDS = new Set(["Refused", "Waited"]);

const wait = (seconds: number) => (seconds < 90 ? `${Math.max(1, Math.round(seconds))} seconds` : `${Math.round(seconds / 60)} minutes`);

/** One error, in plain words. */
export function plainWords(e: unknown): string {
  const x = e as { name?: unknown; code?: unknown; kind?: unknown; message?: unknown; retryAfter?: unknown } | null | undefined;
  if (typeof x !== "object" || x === null) return GENERIC;
  if (x.code === 4001) return "You declined it in your wallet.";
  if (x.code === 4100 || x.code === 4900 || x.code === 4901) return "Your wallet is not connected. Connect it and try again.";
  if (x.code === -32002) return "Your wallet already has a request waiting. Open it and answer it first.";
  switch (x.name) {
    case "AccountsError": {
      if (typeof x.code === "string" && CONFLICTS[x.code] && x.kind === "conflict") return CONFLICTS[x.code]!;
      if (typeof x.code === "string" && CODES[x.code]) return CODES[x.code]!;
      if (x.kind === "rate-limited") return typeof x.retryAfter === "number" ? `Too many requests just now. Wait ${wait(x.retryAfter)} and try again.` : "Too many requests just now. Wait a minute and try again.";
      return KINDS[String(x.kind)] ?? GENERIC;
    }
    case "UnexpectedTransaction": return "The bridge sent back a step that is not what was asked for, so nothing was signed. Try again.";
    case "UnexpectedOnboarding": return "The bridge sent back an account set-up that is not yours, so nothing was signed.";
    case "PageError": return typeof x.code === "string" && CODES[x.code] ? CODES[x.code]! : GENERIC;
  }
  if (typeof x.name === "string" && OWN_WORDS.has(x.name) && typeof x.message === "string") return x.message;
  return GENERIC;
}

/** A message a wallet or a helper wrote as text (not an error): shown only when it reads as a plain sentence, else the general one. */
export function plainText(message: string | null | undefined): string | null {
  if (!message) return null;
  const sentence = message.length <= 140 && /^[A-Z0-9][^{}\[\]<>_\\]*[.!?]$/.test(message) && !/0x[0-9a-f]{4}|\b[A-Z]{3,}_[A-Z]|\bat \S+:\d+|Error:/.test(message);
  return sentence ? message : GENERIC;
}

/** The page's own refusals (a code from `CODES`): thrown by the page, never by the service. */
export class PageError extends Error {
  readonly code: string;
  constructor(code: keyof typeof CODES, message: string) { super(message); this.name = "PageError"; this.code = code; }
}
