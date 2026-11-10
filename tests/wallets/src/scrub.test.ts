// Test of what needs no browser: the seed's words and the password never reach a log line or a committed reason. Run: node --experimental-transform-types --test src/scrub.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubber } from "./scrub.ts";

const secret = { mnemonic: "abandon ability able about above absent absorb abstract absurd abuse access accident", unlock: "Aa1!0123456789abcdef01234567" };

test("every word of the phrase and the password are removed from a screen's text, whole words only", () => {
  const scrub = scrubber(secret);
  const shown = scrub("Your secret phrase: 1 abandon 2 ability 3 able ... accident. Password Aa1!0123456789abcdef01234567 (0123456789abcdef01234567). Abstractly fine");
  for (const w of secret.mnemonic.split(" ")) assert.doesNotMatch(shown, new RegExp(`\\b${w}\\b`, "i"), w);
  assert.ok(!shown.includes("0123456789abcdef"));
  assert.match(shown, /Abstractly fine/);   // a longer word that only starts with one is left alone
  assert.equal(scrub("nothing secret here"), "nothing secret here");
});
