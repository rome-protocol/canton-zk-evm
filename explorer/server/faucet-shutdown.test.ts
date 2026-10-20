import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { createFaucet, type FaucetOptions } from "./faucet.ts";
import { createReth } from "./reth.ts";
import { onShutdown } from "./shutdown.ts";
import { createTracker } from "./tracker.ts";
import { startFakeReth, type FakeReth } from "../test/fake-reth.ts";

/** The faucet and the tracker as main.ts composes them, with the real shutdown, to check what a stop leaves on disk. */
const KEY = generatePrivateKey();
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
let dir: string, fake: FakeReth | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "faucet-shutdown-"));
  for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await fake?.close(); fake = undefined; rmSync(dir, { recursive: true, force: true }); });

describe("a stop with the faucet in the middle of a send", () => {
  it("leaves the transfer in both files, so a restart still follows it to final", async () => {
    const pool: string[] = [];
    let base = 5, release!: () => void, reached!: () => void;
    const open = new Promise<void>((ok) => (release = ok)), arrived = new Promise<void>((ok) => (reached = ok));
    fake = await startFakeReth({
      eth_getTransactionCount: () => "0x" + (base + pool.length).toString(16),
      eth_gasPrice: "0x3b9aca07", eth_maxPriorityFeePerGas: "0x3b9aca00", eth_getBalance: "0xffffffffffffffffffffff",
      eth_sendRawTransaction: (p: unknown[]) => { pool.push(p[0] as string); return keccak256(p[0] as Hex); },
    });
    const reth = createReth(fake.url, 5000);
    let n = 0;
    const gatedReth: FaucetOptions["reth"] = { ...reth, sendRaw: async (raw: string) => { if (n++ === 1) { reached(); await open; } return reth.sendRaw(raw); } };
    const trackerFile = join(dir, "tracker.json"), faucetFile = join(dir, "faucet.json");
    const index = { byNumber: () => undefined };
    const make = (r: FaucetOptions["reth"]) => {
      const tracker = createTracker({ reth: { ...reth, block: reth.block, transaction: reth.transaction, rpc: reth.rpc, sendRaw: reth.sendRaw }, index, file: trackerFile });
      const faucet = createFaucet({ key: KEY, chainId: 770101, amountWei: 10n ** 18n, perAddressSeconds: 86400, perIpSeconds: 600, maxPerHour: 1000, batch: 3, queueMax: 100, tickMs: 10, stateFile: faucetFile, captcha: null, reth: r, tracker });
      return { tracker, faucet };
    };

    const first = make(gatedReth);
    const tickets: string[] = [];
    for (let i = 1; i <= 3; i++) tickets.push(((await first.faucet.request(addr(i), { ip: `9.9.${i}.1` })).body as { ticket: string }).ticket);
    first.faucet.start();
    await arrived; // send number two is held, number one is in reth and with the tracker
    let exited = false;
    const leave = onShutdown({
      stop: [() => first.faucet.stop(), () => first.tracker.stop()], server: { close() {} }, tracker: first.tracker, also: [first.faucet],
      process: { on: () => process }, exit: () => { exited = true; },
    });
    const leaving = leave("SIGTERM");
    release();
    await leaving;
    expect(exited).toBe(true);
    const sentBefore = pool.length;
    expect(sentBefore).toBeGreaterThanOrEqual(2);

    // The process is gone. Both files are read again.
    const second = make(reth);
    for (const id of tickets.slice(0, sentBefore)) {
      const t = second.faucet.ticket(id)!;
      expect(t.status).toBe("sent");
      expect(t.hash).not.toBeNull();
      expect(second.tracker.state(t.hash!)).toMatchObject({ state: "pending" }); // the tracker has it and its bytes
    }
    expect(second.tracker.size()).toBe(sentBefore);
  });
});
