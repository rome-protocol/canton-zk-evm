import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { FAILED_ATTEMPT_REASON, attemptReason } from "./health.ts";
import { genesisContracts, genesisSupply } from "./indexer/genesis.ts";
import { IndexerStop } from "./indexer/errors.ts";

describe("the reason of a block attempt in public", () => {
  it("is a fixed sentence for a failed attempt, whatever the producer wrote", () => {
    expect(attemptReason("failed", "cannot open /home/ops/x and /Users/ops/y at 10.1.2.3:8545")).toBe(FAILED_ATTEMPT_REASON);
    expect(attemptReason("failed", null)).toBe(FAILED_ATTEMPT_REASON);
  });

  it("keeps Canton's reason for a refused or not taken block, with a path, a host or a URL taken out", () => {
    expect(attemptReason("refused", "rejected by Canton")).toBe("rejected by Canton");
    expect(attemptReason("not_taken", null)).toBeNull();
    expect(attemptReason("refused", "see /home/ops/log at https://ledger.internal:7575/v2")).not.toMatch(/\/home|ledger\.internal/);
  });
});

describe("the genesis stops carry no path and no reason of the file system", () => {
  const dir = mkdtempSync(join(tmpdir(), "genesis-reasons-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const stop = (fn: () => unknown): IndexerStop => {
    try { fn(); } catch (e) { return e as IndexerStop; }
    throw new Error("did not stop");
  };

  it("says a fixed sentence for a file that cannot be read, and logs the reason", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const missing = join(dir, "missing.json");
      for (const read of [() => genesisContracts(missing), () => genesisSupply(missing)]) {
        const e = stop(read);
        expect(e).toBeInstanceOf(IndexerStop);
        expect(e.message).toBe("the genesis file cannot be read");
      }
      expect(quiet.mock.calls.flat().join("\n")).toContain(missing);
    } finally { quiet.mockRestore(); }
  });

  it("says a fixed sentence for a file with no alloc, an odd account name and an odd balance", () => {
    const file = (body: object) => { const f = join(dir, `g${Math.random().toString(16).slice(2)}.json`); writeFileSync(f, JSON.stringify(body)); return f; };
    const none = file({ config: {} });
    expect(stop(() => genesisContracts(none)).message).toBe("the genesis file has no alloc");
    expect(stop(() => genesisSupply(none)).message).toBe("the genesis file has no alloc");
    expect(stop(() => genesisContracts(file({ alloc: { "not-an-address": { code: "0x60" } } }))).message).toBe("the genesis file has an account whose name is not an address");
    for (const e of [stop(() => genesisSupply(file({ alloc: { "0x01": { balance: "lots" } } }))), stop(() => genesisSupply(file({ alloc: { "0x01": { balance: true } } })))]) {
      expect(e.message).toBe("the genesis file has a balance that is not a number");
    }
    for (const m of [none]) expect(stop(() => genesisContracts(m)).message).not.toContain(dir);
  });
});
