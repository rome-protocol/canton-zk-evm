import { describe, expect, it } from "vitest";
import { AccountsError } from "./canton/accounts.ts";
import { UnexpectedTransaction } from "./canton/sign.ts";
import { UnexpectedOnboarding } from "./canton/topology.ts";
import { GENERIC, PageError, plainText, plainWords } from "./words.ts";

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
  it("has a sentence for each kind of answer of the service, with the wait when it names one", () => {
    for (const kind of ["bad-request", "unauthorized", "forbidden", "not-found", "refused", "unavailable", "network", "server", "rate-limited"] as const) {
      expect(plainWords(new AccountsError(kind, 500, "raw: 0xdeadbeef {\"a\":1}")), kind).not.toMatch(TECHNICAL);
    }
    expect(plainWords(new AccountsError("rate-limited", 429, "slow", 30))).toBe("Too many requests just now. Wait 30 seconds and try again.");
    expect(plainWords(new AccountsError("rate-limited", 429, "slow", 300))).toBe("Too many requests just now. Wait 5 minutes and try again.");
    expect(plainWords(new AccountsError("refused", 422, "DAML_FAILURE: stack", undefined, "INVALID_ARGUMENT"))).not.toMatch(/DAML|INVALID/);
  });
  it("has a sentence for the page's own refusals and for what the checks refuse", () => {
    for (const code of ["no_choice_context", "acceptances_missing", "origin_mismatch", "account_closed"] as const) expect(plainWords(new PageError(code, "raw")), code).not.toMatch(TECHNICAL);
    expect(plainWords(new PageError("origin_mismatch", "x"))).toMatch(/address/);
    expect(plainWords(new UnexpectedTransaction("node 3 is missing"))).not.toMatch(/node|missing/);
    expect(plainWords(new UnexpectedOnboarding("the key is not yours"))).not.toMatch(/key/);
    expect(plainWords(new AccountsError("server", 200, "the registry's answer has no choiceContextData", undefined, "no_choice_context"))).not.toMatch(/choiceContext/);
  });
  it("says it when the person declines in the wallet, and gives one general sentence for anything else", () => {
    expect(plainWords(Object.assign(new Error("User rejected the request."), { code: 4001 }))).toBe("You declined it in your wallet.");
    for (const odd of [new Error("TypeError: x is undefined at foo.ts:12"), "text", null, undefined, 42, { message: "{\"json\":1}" }]) expect(plainWords(odd)).toBe(GENERIC);
  });
  it("shows a plain sentence of a helper as it is, and anything that reads as a message of code as the general one", () => {
    expect(plainText("Your wallet is not on Ostia yet.")).toBe("Your wallet is not on Ostia yet.");
    expect(plainText("1 tROME is on its way to your wallet.")).toBe("1 tROME is on its way to your wallet.");
    for (const odd of ["execution reverted: 0x08c379a0", "Error: boom", "{\"code\":-32000}", "no punctuation here", "internal_error.", "x".repeat(200) + "."]) expect(plainText(odd), odd).toBe(GENERIC);
    expect(plainText(null)).toBeNull();
    expect(plainText("")).toBeNull();
  });
});
