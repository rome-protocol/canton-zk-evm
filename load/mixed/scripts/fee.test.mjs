// node --test scripts/fee.test.mjs : no chain needed.
import test from "node:test";
import assert from "node:assert/strict";
import { fees, TIP } from "./fee.mjs";

test("the tip never exceeds the max fee, and the max fee covers the gas price", () => {
  for (const g of [0n, 1n, 12n, 999_999_999n, TIP, 1_000_000_150n, 50n * TIP]) {
    const f = fees(g);
    assert.ok(f.maxPriorityFeePerGas <= f.maxFeePerGas, `tip above max fee at gas price ${g}`);
    assert.ok(f.maxFeePerGas >= g, `max fee below the gas price ${g}`);
    assert.ok(f.maxPriorityFeePerGas <= TIP);
  }
});

test("an idle chain (gas price 12 wei): the tip is the gas price", () => {
  assert.deepEqual(fees(12n), { maxPriorityFeePerGas: 12n, maxFeePerGas: 24n });
});

test("a busy chain keeps the 1 gwei tip", () => {
  assert.deepEqual(fees(1_000_000_150n), { maxPriorityFeePerGas: TIP, maxFeePerGas: 2_000_000_300n });
});
