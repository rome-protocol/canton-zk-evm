/**
 * L5 of the nightly load test: what developers' tools ask of the explorer's Etherscan-compatible API, with three Counter contracts the chain script deployed.
 * Run by `l5.sh verify` inside the pinned browser image, in <work folder>/project, once the probe has seen the API.
 *
 *   Foundry   forge verify-contract (standard JSON input) of the first contract and with --flatten (the single-file format) of the second; cast source and cast interface
 *   Hardhat   hardhat verify of the third
 *   ethers    an EtherscanProvider pointed at the explorer: the block number, balance, code, a transaction and its receipt, an eth_call, and the verified contract's ABI
 *
 * Reads L5_EXPLORER, L5_RPC, L5_CHAIN_ID, L5_ADDRS (three addresses, comma separated), L5_ARGS (the constructor argument of each, comma separated), L5_TX (the first
 * contract's creation transaction) and L5_OUT (the results file). Every check that fails is in the results, and the exit is 1 when any did.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { summarize } from "./summary.ts";

const EXPLORER = (process.env.L5_EXPLORER ?? "").replace(/\/$/, "");
const RPC = process.env.L5_RPC ?? "";
const CHAIN_ID = Number(process.env.L5_CHAIN_ID);
const [A, B, C] = (process.env.L5_ADDRS ?? "").split(",");
const [ARG_A, ARG_B, ARG_C] = (process.env.L5_ARGS ?? "").split(",");
const TX = process.env.L5_TX ?? "";
const OUT = process.env.L5_OUT ?? "l5.json";
if (!EXPLORER || !RPC || !(CHAIN_ID > 0) || ![A, B, C, ARG_A, ARG_B, ARG_C, TX].every(Boolean)) {
  console.error("FAIL: L5_EXPLORER, L5_RPC, L5_CHAIN_ID, L5_ADDRS, L5_ARGS and L5_TX must be set");
  process.exit(1);
}
const API = `${EXPLORER}/api`;
const FIVE_MINUTES = 5 * 60 * 1000;

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: FIVE_MINUTES, env: process.env });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { ok: r.status === 0, text, tail: text.trim().split("\n").slice(-12).join("\n") };
}

const checks = [];
async function check(name, fn) {
  const t0 = Date.now();
  let ok = false;
  let detail = "";
  try {
    detail = (await fn()) ?? "ok";
    ok = true;
  } catch (e) {
    detail = String(e?.message ?? e).split("\n").slice(-12).join("\n");
  }
  checks.push({ name, ok, seconds: (Date.now() - t0) / 1000, detail });
  console.log(`L5 ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${detail}`}`);
}
const must = (r, what) => {
  if (!r.ok) throw new Error(`${what} failed:\n${r.tail}`);
  return r;
};

const forgeVerify = (address, arg, extra) => {
  const encoded = must(sh("cast", ["abi-encode", "constructor(uint256)", arg]), "cast abi-encode").text.trim();
  return must(
    sh("forge", [
      "verify-contract", address, "contracts/Counter.sol:Counter", "--chain", String(CHAIN_ID), "--verifier", "etherscan", "--verifier-url", API,
      "--etherscan-api-key", "rome", "--constructor-args", encoded, "--compiler-version", process.env.L5_SOLC_VERSION ?? "0.8.28", "--num-of-optimizations", "200",
      "--evm-version", "cancun", "--watch", ...extra,
    ]),
    "forge verify-contract",
  );
};

await check("forge verify-contract, standard JSON input", () => forgeVerify(A, ARG_A, []).tail);
await check("forge verify-contract --flatten, the single-file format", () => forgeVerify(B, ARG_B, ["--flatten"]).tail);
await check("cast source", () => {
  const r = must(sh("cast", ["source", A, "--chain", String(CHAIN_ID), "--etherscan-api-key", "rome", "--explorer-api-url", API, "--explorer-url", EXPLORER]), "cast source");
  if (!/contract\s+Counter\b/.test(r.text)) throw new Error(`the source has no Counter:\n${r.tail}`);
});
await check("cast interface", () => {
  const r = must(sh("cast", ["interface", A, "--chain", String(CHAIN_ID), "--etherscan-api-key", "rome", "--explorer-api-url", API, "--explorer-url", EXPLORER]), "cast interface");
  for (const fn of ["bump()", "count()"]) if (!r.text.includes(fn)) throw new Error(`the interface has no ${fn}:\n${r.tail}`);
});
await check("hardhat verify", () => must(sh("npx", ["hardhat", "verify", "--network", "rome", C, ARG_C]), "hardhat verify").tail);

const { EtherscanProvider, Network, JsonRpcProvider, Interface } = createRequire(join(process.cwd(), "package.json"))("ethers");
class Door extends EtherscanProvider {
  getBaseUrl() {
    return API;
  }
}
const network = new Network("rome", CHAIN_ID);
const door = new Door(network, "rome");
const reth = new JsonRpcProvider(RPC, network, { staticNetwork: network });
const equal = (what, got, want) => {
  if (String(got) !== String(want)) throw new Error(`${what}: the explorer says ${got}, reth says ${want}`);
};
await check("ethers EtherscanProvider: block number, balance and code", async () => {
  const [d, r] = [await door.getBlockNumber(), await reth.getBlockNumber()];
  if (!(Math.abs(d - r) <= 10)) throw new Error(`block number: the explorer says ${d}, reth says ${r}`);
  equal("balance", await door.getBalance(A), await reth.getBalance(A));
  const code = await door.getCode(A);
  if (code === "0x") throw new Error("no code at the contract");
  equal("code", code, await reth.getCode(A));
});
await check("ethers EtherscanProvider: transaction, receipt and eth_call", async () => {
  const tx = await door.getTransaction(TX);
  if (!tx) throw new Error("no transaction");
  equal("transaction hash", tx.hash, TX);
  const receipt = await door.getTransactionReceipt(TX);
  equal("receipt status", receipt?.status, 1);
  const iface = new Interface(["function count() view returns (uint256)"]);
  const out = await door.call({ to: A, data: iface.encodeFunctionData("count") });
  equal("count()", iface.decodeFunctionResult("count", out)[0], ARG_A);
});
await check("ethers EtherscanProvider: the verified contract's ABI", async () => {
  const abi = JSON.parse(await door.fetch("contract", { action: "getabi", address: A }));
  if (!JSON.stringify(abi).includes("bump")) throw new Error("the ABI has no bump");
});

const summary = summarize(checks);
writeFileSync(OUT, JSON.stringify({ explorer: EXPLORER, chainId: CHAIN_ID, ...summary }, null, 2));
for (const f of summary.failures) console.error(`L5 FAIL: ${f.split("\n")[0]}`);
process.exit(summary.status === "passed" ? 0 : 1);
