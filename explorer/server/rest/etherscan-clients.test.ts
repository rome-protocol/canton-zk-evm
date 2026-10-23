import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import { createHttpServer } from "../http.ts";
import { createPublicRpc } from "../public-rpc.ts";
import { startFakeReth, type FakeReth } from "../../test/fake-reth.ts";
import { ethersChecks, ostiaProvider } from "../../test/etherscan-clients.ts";
import { etherscan } from "./etherscan.ts";

/**
 * The tools that people point at an Etherscan API, against the door of a server built here: the real HTTP server, the real public RPC (final only) and the real
 * Etherscan door over a fake reth. The same checks run against the rehearsal chain's explorer in tests/demo_rehearsal.sh.
 */
const CHAIN = 770101, FINAL = 5, HEAD = 6;
const hx = (n: number) => "0x" + n.toString(16);
const hashOf = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
const WHO = "0x" + "5e".repeat(20), FROM = "0x" + "c1".repeat(20);
const COIN = 10n ** 18n;
const TX = "0x" + "f1".repeat(32), PROVING = "0x" + "f2".repeat(32);
const tx = (h: string, n: number) => ({
  hash: h, type: "0x2", blockNumber: hx(n), blockHash: hashOf(n), transactionIndex: "0x0", from: FROM, to: WHO, gas: "0x5208", gasPrice: "0x3b9aca00", maxFeePerGas: "0x3b9aca00",
  maxPriorityFeePerGas: "0x1", input: "0x", nonce: "0x0", value: "0x" + COIN.toString(16), chainId: hx(CHAIN), v: "0x1", yParity: "0x1", r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32), accessList: [],
});
const block = (n: number, full: boolean) => ({
  number: hx(n), hash: hashOf(n), parentHash: hashOf(n - 1), timestamp: hx(1_700_000_000 + n), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x5208",
  miner: "0x" + "00".repeat(19) + "fe", extraData: "0x", baseFeePerGas: "0x3b9aca00", mixHash: "0x" + "00".repeat(32), sha3Uncles: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), transactionsRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256), size: "0x200", uncles: [],
  transactions: n === 4 ? [full ? tx(TX, 4) : TX] : [],
});
const receipt = { transactionHash: TX, transactionIndex: "0x0", blockNumber: hx(4), blockHash: hashOf(4), from: FROM, to: WHO, contractAddress: null, cumulativeGasUsed: "0x5208", gasUsed: "0x5208",
  effectiveGasPrice: "0x3b9aca00", logs: [], logsBloom: "0x" + "00".repeat(256), status: "0x1", type: "0x2" };

let reth: FakeReth, server: ReturnType<typeof createHttpServer>, url = "";
const tracked: unknown[][] = [];

beforeAll(async () => {
  const handlers: Record<string, unknown> = {
    eth_getBlockByNumber: (p: unknown[]) => (p[0] === "finalized" ? block(FINAL, false) : p[0] === "latest" ? block(HEAD, false) : Number(p[0]) <= HEAD ? block(Number(p[0]), p[1] === true) : null),
    eth_getTransactionByHash: (p: unknown[]) => (p[0] === TX ? tx(TX, 4) : p[0] === PROVING ? tx(PROVING, HEAD) : null),
    eth_getTransactionReceipt: (p: unknown[]) => (p[0] === TX ? receipt : null),
    eth_getTransactionCount: "0x0", eth_getCode: "0x", eth_getStorageAt: "0x" + "0".repeat(64), eth_call: "0x", eth_estimateGas: "0x5208", eth_gasPrice: "0x3b9aca00",
    eth_getBalance: hx(Number(COIN)), eth_chainId: hx(CHAIN),
    eth_sendRawTransaction: (p: unknown[]) => keccak256(p[0] as Hex),
  };
  reth = await startFakeReth(handlers);
  const rpc = createPublicRpc({ rethUrl: reth.url, timeoutMs: 2000, chainId: CHAIN, ratePerMinute: 100000, finalizedTtlMs: 0, tracker: { admit: () => null, track: (...a) => { tracked.push(a); } } });
  const door = etherscan({ rest: { heads: async () => ({ head: FINAL, cursor: FINAL }) } as never, reth: { balanceAt: async () => COIN } as never, chainId: CHAIN, rpc });
  const api = async (method: string, target: string, body?: string, ip?: string) => {
    const u = new URL(target, "http://x");
    return u.pathname === "/api" || u.pathname === "/v2/api" ? door(u.searchParams, method === "POST" ? body : undefined, ip) : { status: 404, body: { error: "no" } };
  };
  server = createHttpServer(api, "/nonexistent", { handler: rpc, ipHeader: null });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await reth?.close();
  await new Promise((ok) => (server ? server.close(ok) : ok(null)));
});

describe("ethers' EtherscanProvider against the door", () => {
  // The checks read `url` when each runs, so they are given a getter-backed target.
  const target = { get url() { return url; }, chainId: CHAIN, address: WHO, balance: COIN, txHash: TX };
  ethersChecks(target);

  it("ethers: sends a signed transaction through the door, and the tracker follows it", async () => {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(generatePrivateKey());
    const raw = await account.signTransaction({ type: "eip1559", chainId: CHAIN, nonce: 0, to: WHO, value: 1n, gas: 21000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n } as never);
    const sent = await ostiaProvider({ url, chainId: CHAIN }).broadcastTransaction(raw);
    expect(sent.hash).toBe(keccak256(raw));
    expect(tracked.map((t) => t[1])).toContain(keccak256(raw));
  });

  it("ethers: sends a contract creation over 8 KB (a POST body), and the tracker follows it; a proxy body over 256 KB is a JSON-RPC error", async () => {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(generatePrivateKey());
    const data = ("0x" + "60".repeat(5000)) as Hex;
    const raw = await account.signTransaction({ type: "eip1559", chainId: CHAIN, nonce: 0, data, gas: 3_000_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n } as never);
    expect(raw.length).toBeGreaterThan(8192);
    const sent = await ostiaProvider({ url, chainId: CHAIN }).broadcastTransaction(raw);
    expect(sent.hash).toBe(keccak256(raw));
    expect(tracked.map((t) => t[1])).toContain(keccak256(raw));
    // Over the public RPC's limit, the answer is a JSON-RPC error with a true size text, which ethers can read.
    await new Promise((ok) => setTimeout(ok, 1100)); // the door's rate: 10 a second for each client
    const huge = await fetch(`${url}/api`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `module=proxy&action=eth_sendRawTransaction&hex=0x${"ab".repeat(140 * 1024)}` });
    expect(await huge.json()).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "The request is too big: a proxy request is at most 256 KB." } });
  });
});

// cast has no call of the Etherscan proxy: its Etherscan reads are the contract module's (cast source, interface and creation-code, which come with the contract module).
// What it checks here is that the hex the proxy gives is what cast reads from the same chain, and that cast takes it as a number. tests/demo_etherscan_cast.sh is the script.
const hasCast = spawnSync("cast", ["--version"]).status === 0;
describe.skipIf(!hasCast)("cast against the same chain", () => {
  it("reads what the proxy gives, from the same final block", async () => {
    const script = resolve(import.meta.dirname, "../../../tests/demo_etherscan_cast.sh");
    expect(existsSync(script)).toBe(true);
    // Not spawnSync: this process answers the script's requests.
    const run = await new Promise<{ code: number | null; out: string }>((done) => {
      execFile("bash", [script], { env: { ...process.env, CAST: "cast", EXPLORER: url, CHAIN_ID: String(CHAIN), ETHERSCAN_ADDRESS: WHO, ETHERSCAN_BALANCE: COIN.toString(), ETHERSCAN_TX: TX }, timeout: 60_000 }, (e, stdout, stderr) =>
        done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: stdout + stderr }));
    });
    expect(run.out).toContain("cast and the proxy agree");
    expect(run.code).toBe(0);
  }, 90_000);
});
