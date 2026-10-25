// node --test scripts/classify.test.mjs : no chain needed.
import test from "node:test";
import assert from "node:assert/strict";
import { classify, emptyTally, tallyLine, passes, decodeRevert, reasonFromError, reasonFinder } from "./classify.mjs";

// Error(string) return data as a contract sends it
const errorString = (s) => { const h = Buffer.from(s).toString("hex"); return "0x08c379a0" + "20".padStart(64, "0") + s.length.toString(16).padStart(64, "0") + h.padEnd(Math.ceil(h.length / 64) * 64, "0"); };

test("every receipt is one of the four classes", () => {
  assert.equal(classify({ success: true }), "success");
  assert.equal(classify({ success: true, expectRevert: false }), "success");
  assert.equal(classify({ success: false, expectRevert: true }), "expectedRevert");
  assert.equal(classify({ success: false }), "unexpectedRevert");
  assert.equal(classify({ success: false, expectRevert: false }), "unexpectedRevert");
  assert.equal(classify({ success: true, expectRevert: true }), "unexpectedSuccess");
});

test("the per-minute line shows expected and unexpected reverts apart, and the pass rule counts only the unexpected ones", () => {
  const t = emptyTally();
  t.success = 900; t.expectedRevert = 40;
  assert.match(tallyLine(t), /reverted on purpose 40/);
  assert.match(tallyLine(t), /UNEXPECTED reverts 0/);
  assert.equal(passes(t), true, "reverts sent on purpose do not fail a soak");
  t.unexpectedRevert = 1;
  assert.match(tallyLine(t), /UNEXPECTED reverts 1/);
  assert.equal(passes(t), false);
  t.unexpectedRevert = 0; t.unexpectedSuccess = 2;
  assert.match(tallyLine(t), /went through 2/);
  assert.equal(passes(t), false);
  t.unexpectedSuccess = 0;
  assert.equal(passes(t, 0), true);
  assert.equal(passes(t, 3), false, "a transaction the chain accepted and never made final fails a soak");
});

test("decodeRevert reads Error(string), Panic, custom errors and empty data", () => {
  assert.equal(decodeRevert(errorString("ERC20: transfer amount exceeds balance")), "ERC20: transfer amount exceeds balance");
  assert.match(decodeRevert("0x4e487b71" + "11".padStart(64, "0")), /panic 0x11: arithmetic/);
  assert.equal(decodeRevert("0xdeadbeef" + "00".repeat(32)), "custom error 0xdeadbeef");
  assert.equal(decodeRevert("0x"), "no reason given");
  assert.equal(decodeRevert(undefined), "no reason given");
  assert.equal(decodeRevert("0x08c379a0abcd"), "undecodable revert data");
});

test("reasonFromError prefers the return data, else the node's message without its prefix", () => {
  assert.equal(reasonFromError({ message: "x", data: errorString("OstiaItems: bad id or amount") }), "OstiaItems: bad id or amount");
  assert.equal(reasonFromError(new Error("execution reverted: ERC721: invalid token ID")), "ERC721: invalid token ID");
  assert.equal(reasonFromError(new Error("execution reverted")), "no reason given");
});

test("reasonFinder replays at most `cap` times per kind, then reuses the last reason", async () => {
  let calls = 0;
  const find = reasonFinder(async () => { calls++; return "ERC20: transfer amount exceeds balance"; }, 2);
  assert.equal(await find({ kind: "transfer" }), "ERC20: transfer amount exceeds balance");
  assert.equal(await find({ kind: "transfer" }), "ERC20: transfer amount exceeds balance");
  assert.match(await find({ kind: "transfer" }), /same kind as an earlier replay/);
  assert.equal(calls, 2);
  assert.equal(await find({ kind: "swap", sub: "x" }), "ERC20: transfer amount exceeds balance", "another kind has its own budget");
  assert.equal(calls, 3);
  const failing = reasonFinder(async () => { throw new Error("boom"); }, 1);
  assert.match(await failing({ kind: "k" }), /replay failed: boom/);
});
