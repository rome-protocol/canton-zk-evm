// Test of what needs no browser: the live check signs only the Bridge's request. Run: node --experimental-transform-types --test src/signatures.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { asksForSignature, bridgeRequestMatcher, decide } from "./signatures.ts";

const bridge = bridgeRequestMatcher("Ostia bridge", "Open my Canton account on Ostia. This signature is your Canton key: sign it only on the Ostia bridge page you trust.");

test("the Bridge's request is approved, whichever of its two marks the wallet shows", () => {
  assert.equal(decide("Signature request Ostia bridge Open Statement Open my Canton account on Ostia. This signature is your Canton key", bridge), "approve");
  assert.equal(decide("Sign typed data open my canton account on ostia. this signature is", bridge), "approve");
});

test("any other signature request is refused", () => {
  assert.equal(decide("Signature request Some other site Permit spender amount", bridge), "refuse");
  assert.equal(decide("Sign message: log in to example.test", bridge), "refuse");
  assert.equal(decide("Personal sign hello", bridge), "refuse");
});

test("a connection, a chain or a switch is approved: it signs nothing", () => {
  for (const t of ["Connect with Wallet. Connect to this site", "Allow this site to add a network. Approve", "Switch network. Switch", ""]) {
    assert.equal(asksForSignature(t), false, t);
    assert.equal(decide(t, bridge), "approve", t);
  }
});
