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

const wait = (seconds: number) => (seconds < 90 ? `${Math.max(1, Math.round(seconds))} seconds` : seconds < 5400 ? `${Math.round(seconds / 60)} minutes` : `${Math.round(seconds / 3600)} hours`);

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
  const sentence = message.length <= 140 && /^[A-Z0-9][^{}\[\]<>_\\]*[.!?]$/.test(message) && !/0x[0-9a-f]{4}|\b[A-Z]{3,}_[A-Z]|\bat \S+:\d+|Error:|\b(?:EIP|ERC)-\d+/.test(message);
  return sentence ? message : GENERIC;
}

/** What the moves library says in its own sentences, where a sentence names a part of the bridge, in words for the person. The first match wins. */
const MOVE_SENTENCES: [RegExp, string][] = [
  [/reject|denied|declin/i, "You declined it in your wallet."],
  [/not a Canton party id/, "That Canton account is not valid."],
  [/Wrapping the chain's coin/, "Moving this coin is not set up here. Nothing was moved."],
  [/does not hold enough .* to release/, "The bridge cannot pay out this much right now. Try a smaller amount."],
  [/registry gave a lock id|deposit's id is not/, "The bridge sent back something that is not what was asked for, so nothing was sent. Try again."],
  [/Web Locks/, "This browser cannot run the bridge. Use a current browser."],
  [/another wallet account or Canton party/, "This move was started with another account. Switch back to it to continue, or give it up."],
  [/earlier move of this account is kept/, "An earlier move is not finished. Continue it, or give it up, before starting another."],
  [/could not be given an id/, GENERIC],
  [/has not accepted twins/, "Your Canton account has not accepted this token yet. Open your Canton account first."],
  [/twin registry/, "The bridge could not be reached right now. Try again in a moment."],
  [/approval did not give/, "The approval did not cover the amount. Continue to try again."],
  [/Your (?:lock|redeem|deposit|withdrawal) is saved\. Continue to sign it on Canton/, "Your move is saved. Continue to sign it on Canton."],
  [/Your (?:lock|redeem|deposit|withdrawal) is saved\. Continue to allocate/, "Your move is saved. Continue to sign it on Canton."],
  [/Your (?:lock|redeem|deposit|withdrawal) is saved\./, "Your move is saved. Continue to ask your wallet."],
  [/tokens are allocated on Canton/, "Continue to sign the second step on Canton."],
  [/Canton has your redeem/, "Canton has it. Continue to release it on Ostia."],
  [/Canton has your deposit/, "Canton has it. Continue to claim it on Ostia."],
  [/made no leg of this move/, "That transaction was not this move, so it has not happened on Ostia yet. Continue to send it again."],
  [/final on Ostia, but the explorer does not show the leg/, "The move is final on Ostia. The explorer has not shown it yet. Continue to look again. Nothing is sent."],
  [/already on Ostia, and the explorer/, "This move is already on Ostia. The explorer has not shown it yet. Reload this page to keep waiting."],
];
const NAMES_A_PART = /\b(?:party|allocat\w*|vault|gateway|registry|nonce|leg|hash|contract|calldata|0x[0-9a-f]{4})\b|\b(?:EIP|ERC)-\d+|[_{}\[\]<>\\]/i;

/** A sentence of the moves library (a pause, a refusal, or the reason a move stopped), in plain words: a known one in its own words, another only when it names no part of the bridge, else the general one. */
export function moveWords(text: string | null | undefined): string {
  if (!text) return GENERIC;
  for (const [pattern, words] of MOVE_SENTENCES) if (pattern.test(text)) return words;
  return text.length <= 260 && /^[A-Z0-9][^]*[.!?]$/.test(text) && !NAMES_A_PART.test(text) ? text : GENERIC;
}

/** The page's own refusals (a code from `CODES`): thrown by the page, never by the service. */
export class PageError extends Error {
  readonly code: string;
  constructor(code: keyof typeof CODES, message: string) { super(message); this.name = "PageError"; this.code = code; }
}
