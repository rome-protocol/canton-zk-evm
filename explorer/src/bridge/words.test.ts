import { describe, expect, it, vi } from "vitest";
import { AccountsError } from "./canton/accounts.ts";
import { UnexpectedTransaction } from "./canton/sign.ts";
import { UnexpectedOnboarding } from "./canton/topology.ts";
import { GENERIC, PageError, moveWords, plainText, plainWords, signInWords, walletWouldNotSign } from "./words.ts";

const TECHNICAL = /party|allocation|vault|contract id|choiceContext|already_accepted|too_many_open|waiting_for_signature|account_key_unknown|no_choice_context|\b[45]\d\d\b|Error:|\bat \S+:\d+|0x[0-9a-f]{4}|[{}]/i;
const conflict = (code: string) => new AccountsError("conflict", 409, "words the service wrote", undefined, code);

describe("plain words for what the person can see", () => {
  it("has a sentence for each conflict the service names, and none shows its code", () => {
    for (const code of ["already_accepted", "too_many_open", "waiting_for_signature", "account_key_unknown"]) {
      const words = plainWords(conflict(code));
      expect(words, code).not.toBe(GENERIC);
      expect(words, code).not.toMatch(TECHNICAL);
    }
    expect(plainWords(conflict("a_code_from_a_newer_service"))).toBe(GENERIC);
  });
  it("says which daily limit was reached, whether a network or everyone shares it, and when it is over", () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-11T12:00:00Z") });
    try {
      const limit = (code: string, seconds: number | undefined = 5 * 3600 + 120) => plainWords(new AccountsError("rate-limited", 429, "words of the service", seconds, code));
      expect(limit("accounts_network_full")).toBe("This network has opened today's share of new Canton accounts. Try again after 17:02 UTC, or from another network.");
      expect(limit("accounts_all_full")).toBe("Today's new Canton accounts are all taken. Try again after 17:02 UTC.");
      expect(limit("send_network_full")).toMatch(/^This network has used today's share of Bridge transactions\. Try again after 17:02 UTC, or from another network\.$/);
      expect(limit("send_account_full")).toContain("This account has used today's Bridge transactions");
      expect(limit("send_all_full")).toContain("Taking back a deposit and accepting a transfer still work");
      expect(limit("faucet_network_full")).toContain("or from another network");
      expect(plainWords(new AccountsError("rate-limited", 429, "x", undefined, "accounts_all_full"))).toBe("Today's new Canton accounts are all taken. Try again tomorrow.");
      for (const code of ["accounts_network_full", "accounts_all_full", "send_network_full", "send_account_full", "send_all_full", "faucet_account_full", "faucet_network_full", "faucet_all_full"]) {
        expect(limit(code), code).not.toMatch(TECHNICAL);
        expect(limit(code), code).not.toMatch(/Wait \d+ hours/);
      }
      expect(plainWords(new AccountsError("conflict", 409, "x", 60, "accounts_all_full"))).toBe(GENERIC);   // only a 429 carries these words
      expect(limit("a_code_from_a_newer_service")).toBe("A limit for today has been reached. Try again after 17:02 UTC.");
    } finally {
      vi.useRealTimers();
    }
  });
  it("has a sentence for each kind of answer of the service, with the wait when it names one", () => {
    for (const kind of ["bad-request", "unauthorized", "forbidden", "not-found", "refused", "unavailable", "network", "server", "rate-limited"] as const) {
      expect(plainWords(new AccountsError(kind, 500, "raw: 0xdeadbeef {\"a\":1}")), kind).not.toMatch(TECHNICAL);
    }
    expect(plainWords(new AccountsError("rate-limited", 429, "slow", 30))).toBe("Too many requests just now. Wait 30 seconds and try again.");
    expect(plainWords(new AccountsError("rate-limited", 429, "slow", 300))).toBe("Too many requests just now. Wait 5 minutes and try again.");
    vi.useFakeTimers({ now: Date.parse("2026-11-11T12:00:00Z") });
    try {
      expect(plainWords(new AccountsError("rate-limited", 429, "x", 3600))).toBe("Too many requests just now. Wait 60 minutes and try again.");
      expect(plainWords(new AccountsError("rate-limited", 429, "x", 72_000))).toBe("A limit for today has been reached. Try again after 08:00 UTC.");   // not "Wait 20 hours"
    } finally {
      vi.useRealTimers();
    }
    expect(plainWords(new AccountsError("refused", 422, "DAML_FAILURE: stack", undefined, "INVALID_ARGUMENT"))).not.toMatch(/DAML|INVALID/);
  });
  it("has a sentence for the page's own refusals and for what the checks refuse", () => {
    for (const code of ["no_choice_context", "acceptances_missing", "origin_mismatch", "account_closed", "wallet_not_deterministic", "wrong_signer", "no_canton_coin", "faucet_no_offer"] as const) expect(plainWords(new PageError(code, "raw")), code).not.toMatch(TECHNICAL);
    expect(plainWords(new PageError("origin_mismatch", "x"))).toMatch(/address/);
    expect(plainWords(new PageError("wallet_not_deterministic", "x"))).toBe("This wallet signs differently each time, so it cannot hold a Canton account here. Use another wallet.");
    expect(plainWords(new PageError("wrong_signer", "x"))).toBe("Your wallet signed with a different account. Pick the connected account in your wallet and try again.");
    expect(plainWords(new PageError("no_canton_coin", "x"))).toBe("This site does not offer Canton Coin yet.");
    expect(plainWords(new PageError("faucet_no_offer", "x"))).toBe("The faucet did not send Canton Coin. Try again later.");
    expect(plainWords(new UnexpectedTransaction("node 3 is missing"))).not.toMatch(/node|missing/);
    expect(plainWords(new UnexpectedOnboarding("the key is not yours"))).not.toMatch(/key/);
    expect(plainWords(new AccountsError("server", 200, "the registry's answer has no choiceContextData", undefined, "no_choice_context"))).not.toMatch(/choiceContext/);
  });
  it("says it when the person declines in the wallet, and gives one general sentence for anything else", () => {
    expect(plainWords(Object.assign(new Error("User rejected the request."), { code: 4001 }))).toBe("You declined it in your wallet.");
    for (const odd of [new Error("TypeError: x is undefined at foo.ts:12"), "text", null, undefined, 42, { message: "{\"json\":1}" }]) expect(plainWords(odd)).toBe(GENERIC);
  });
  it("tells the person to get test tROME first when the wallet will not let the page sign (codes 4100, 4900, 4901), on the sign-in path", () => {
    const said = "Your wallet did not let this page sign. Get test tROME first and make sure MetaMask is on the Ostia network, then sign in again.";
    expect(walletWouldNotSign("tROME", "Ostia")).toBe(said);
    expect(walletWouldNotSign("tFOO", "Bar")).toBe("Your wallet did not let this page sign. Get test tFOO first and make sure MetaMask is on the Bar network, then sign in again.");
    for (const code of [4100, 4900, 4901]) expect(signInWords(Object.assign(new Error("Unauthorized"), { code }), "tROME", "Ostia")).toBe(said);
    expect(signInWords(Object.assign(new Error("User rejected the request."), { code: 4001 }), "tROME", "Ostia")).toBe("You declined it in your wallet.");
    // A wallet known to hold the coin is not told to get it.
    const held = "Your wallet did not let this page sign. Make sure MetaMask is on the Ostia network, then sign in again.";
    expect(walletWouldNotSign("tROME", "Ostia", true)).toBe(held);
    for (const code of [4100, 4900, 4901]) {
      const e = Object.assign(new Error("Unauthorized"), { code });
      expect(signInWords(e, "tROME", "Ostia", 1n)).toBe(held);
      expect(signInWords(e, "tROME", "Ostia", 0n)).toBe(said);
      expect(signInWords(e, "tROME", "Ostia", null)).toBe(said);
    }
    expect(signInWords(Object.assign(new Error("denied"), { code: 4001 }), "tROME", "Ostia", 1n)).toBe("You declined it in your wallet.");
    expect(signInWords(new TypeError("boom"), "tROME", "Ostia")).toBe(GENERIC);
    expect(signInWords(null, "tROME", "Ostia")).toBe(GENERIC);
  });
  it("shows a plain sentence of a helper as it is, and anything that reads as a message of code as the general one", () => {
    expect(plainText("Your wallet is not on Ostia yet.")).toBe("Your wallet is not on Ostia yet.");
    expect(plainText("1 tROME is on its way to your wallet.")).toBe("1 tROME is on its way to your wallet.");
    for (const odd of ["execution reverted: 0x08c379a0", "Error: boom", "{\"code\":-32000}", "no punctuation here", "internal_error.", "x".repeat(200) + "."]) expect(plainText(odd), odd).toBe(GENERIC);
    expect(plainText(null)).toBeNull();
    expect(plainText("")).toBeNull();
  });
});

describe("the page's sentences about wallets and moves", () => {
  it("sends a sentence that names an EIP or an ERC to the general one", () => {
    expect(moveWords("The current chain of the wallet (id: 1) does not match the target chain for the transaction.")).toBe("Your wallet is not on Ostia. Switch it to Ostia, then continue.");
    expect(plainText("No wallet was found in this browser. Open this page in a browser with an EIP-1193 wallet.")).toBe(GENERIC);
    expect(plainText("This token follows ERC-20.")).toBe(GENERIC);
    expect(plainText("No wallet was found in this browser. Install MetaMask, then open this page again.")).toBe("No wallet was found in this browser. Install MetaMask, then open this page again.");
  });
  it("puts every sentence the moves library says in words with no part of the bridge named", () => {
    const said = [
      "The bridge does not move this token.", "This wrapped token does not have 10 decimals, so the bridge will not move it.", "The receiver is not a Canton party id (a name, then ::1220 and 64 hex digits).",
      "Wrapping the chain's coin is not set up for this deployment, so nothing was wrapped.", "You do not hold enough TKA.", "The vault does not hold enough TKA to release this amount.",
      "The registry gave a lock id that is not the one this lock makes. Nothing was sent.", "A transaction from this account is still waiting. This move continues once it is final. If it does not go through, speed it up or cancel it in your wallet.",
      "This browser cannot run the bridge: it has no Web Locks, which keep a second tab or window from working on the same move. Use a current browser.",
      "This move was started with another wallet account or Canton party. Switch back to it to continue it, or give it up.", "An earlier move of this account is kept. Continue it, or give it up, before starting another.",
      "Another move is not finished yet.", "The move could not be given an id.", "Your lock is saved. Continue to ask your wallet.", "The approval failed on Ostia. Nothing else was sent. Continue to try again.",
      "The approval did not give the gateway the amount (a replaced approval, or a lower one). Check the allowance in your wallet. Continue to try again.",
      "Your redeem is saved. Continue to sign it on Canton.", "Canton has your redeem. Continue to ask your wallet for the release.", "Your deposit is saved. Continue to allocate the tokens on Canton.",
      "The tokens are allocated on Canton. Continue to send the deposit request.", "Canton has your deposit. Continue to ask your wallet for the claim.", "Your withdrawal is saved. Continue to ask your wallet.",
      "The transaction failed on Ostia; nothing moved. Continue to try again.", "That transaction made no leg of this move, so the move has not happened on Ostia. Continue to send it again.",
      "This move is being worked on in another tab or window. Wait until it stops there, then continue here.", "This move is already on Ostia, and the explorer has not shown its transaction yet. Reload this page to keep waiting.",
      "The move is final on Ostia, but the explorer does not show the leg yet. Continue to look again; nothing is sent.", "Canton has not shown this step yet. Continue to look again; nothing is signed twice.",
      "The transaction was replaced or dropped, and the explorer has not shown another one for this move. Continue to look again; nothing is sent until the wallet is asked.", "Waiting for the block took too long. Reload this page to keep waiting.",
      "You do not hold enough of this token on Canton.", "This deposit's id is not the one its label makes. Nothing was signed.", "The twin registry cannot be reached right now.",
      "The receiver has not accepted twins yet. Its Canton party must accept twins once before a lock can be made for it.", "User rejected the request.", "Type an amount such as 12 or 12.5.",
    ];
    for (const text of said) expect(moveWords(text), text).not.toMatch(/\b(party|allocat\w*|vault|gateway|registry|Web Locks|nonce|leg|hash|contract|twins?|redeem|lock)\b|ERC|EIP|0x/i);
    expect(moveWords("User rejected the request.")).toBe("You declined it in your wallet.");
    expect(moveWords("You do not hold enough TKA.")).toBe("You do not hold enough TKA.");
    expect(moveWords("Canton has your redeem. Continue to ask your wallet for the release.")).toBe("Canton has it. Continue to release it on Ostia.");
  });
  it("says a balance too low for the fees in plain words", () => {
    const viem = "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.";
    expect(moveWords(viem)).toBe("You do not have enough for the fees. Get some from the faucet, then try again.");
    expect(moveWords("insufficient funds for gas")).toBe("You do not have enough for the fees. Get some from the faucet, then try again.");
  });
  it("gives the general sentence for anything else", () => {
    for (const odd of ["execution reverted: 0x08c379a0", "Error: boom", "{\"code\":-32000}", "no punctuation here", null, undefined, "", "The leg 0xabcd is missing."]) expect(moveWords(odd), String(odd)).toBe(GENERIC);
  });
});
