/**
 * L5 of the nightly load test: what developers' tools ask of the explorer's Etherscan-compatible API, with three Counter contracts the chain script deployed (three different runtime codes: the optimizer runs 200, 201 and 202).
 * Run by `l5.sh verify` inside the pinned browser image, in <work folder>/project, once the probe has seen the API.
 *
 *   proxy module     (the explorer's door, asked with plain fetch: ethers' EtherscanProvider refuses any chain that is not in its built-in list) the block number, the code, a
 *                    transaction and its receipt and an eth_call, each against reth through ethers' JsonRpcProvider; account&action=balance against reth
 *   contract module  Foundry: forge verify-contract (standard JSON input) of the first contract and with --flatten (the single-file format) of the second, cast source and
 *                    cast interface; Hardhat: hardhat verify of the third; the verified contract's ABI (getabi)
 *
 * Each group runs when its module is in L5_MODULES (the door's x-modules, from `l5.sh probe`); a module missing from it fails its checks. Reads L5_MODULES, L5_EXPLORER, L5_RPC, L5_CHAIN_ID, L5_ADDRS (three addresses, comma separated), L5_ARGS (the constructor argument of each, comma separated), L5_RUNS (the optimizer runs of each), L5_TX (the first
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
/** The optimizer runs each contract was built with: three different runtime codes, so that verifying one is never a "similar match" for the others. */
const [RUNS_A, RUNS_B, RUNS_C] = (process.env.L5_RUNS ?? "").split(",");
const TX = process.env.L5_TX ?? "";
const OUT = process.env.L5_OUT ?? "l5.json";
const MODULES = (process.env.L5_MODULES ?? "").split(",").filter(Boolean);
if (!EXPLORER || !RPC || !(CHAIN_ID > 0) || ![A, B, C, ARG_A, ARG_B, ARG_C, RUNS_A, RUNS_B, RUNS_C, TX].every(Boolean)) {
  console.error("FAIL: L5_EXPLORER, L5_RPC, L5_CHAIN_ID, L5_ADDRS, L5_ARGS, L5_RUNS and L5_TX must be set");
  process.exit(1);
}
const API = `${EXPLORER}/api`;
const FIVE_MINUTES = 5 * 60 * 1000;

function sh(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: FIVE_MINUTES, env: { ...process.env, ...env } });
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
/** The group of checks of one module. L5 tests the proxy, account and contract modules: one that is missing from the door's x-modules is a failure, never a skip. */
async function inModule(module, list) {
  if (MODULES.includes(module)) {
    for (const [name, fn] of list) await check(name, fn);
    return;
  }
  for (const [name] of list) {
    const detail = `the ${module} module is not in /api/openapi.json's x-modules (${MODULES.join(", ") || "none"})`;
    checks.push({ name, ok: false, seconds: 0, detail });
    console.log(`L5 FAIL ${name}: ${detail}`);
  }
}
const must = (r, what) => {
  if (!r.ok) throw new Error(`${what} failed:\n${r.tail}`);
  return r;
};

// The first submission waits for the verifier to download its compiler (a minute or more): forge asks again every 5 seconds, for this many tries (its own is 5), as main's tests/demo_etherscan_contract.sh does.
const RETRIES = "60";
const forgeVerify = (address, arg, runs, extra) => {
  const encoded = must(sh("cast", ["abi-encode", "constructor(uint256)", arg]), "cast abi-encode").text.trim();
  return must(
    sh(
      "forge",
      [
        "verify-contract", address, "contracts/Counter.sol:Counter", "--chain", String(CHAIN_ID), "--verifier", "etherscan", "--verifier-url", API,
        "--etherscan-api-key", "rome", "--constructor-args", encoded, "--compiler-version", process.env.L5_SOLC_VERSION ?? "0.8.28", "--num-of-optimizations", runs,
        "--evm-version", "cancun", "--watch", "--retries", RETRIES, "--delay", "5", ...extra,
      ],
      { FOUNDRY_OPTIMIZER_RUNS: runs }, // the source's settings come from the config, not from the flag: the contract was built with these runs
    ),
    "forge verify-contract",
  );
};
/** The tool really submitted the contract: it did not stop at "already verified" (what a similar match of the same runtime code would give). */
const submitted = (r, what) => {
  if (/already (been )?verified/i.test(r.text)) throw new Error(`${what} stopped at "already verified": nothing was submitted:\n${r.tail}`);
  if (!/successfully verified|Pass - Verified/i.test(r.text)) throw new Error(`${what} did not say the contract is verified:\n${r.tail}`);
  return r.tail;
};

const { Network, JsonRpcProvider, Interface } = createRequire(join(process.cwd(), "package.json"))("ethers");
const network = new Network("rome", CHAIN_ID);
const reth = new JsonRpcProvider(RPC, network, { staticNetwork: network });
const equal = (what, got, want) => {
  if (String(got) !== String(want)) throw new Error(`${what}: the explorer says ${got}, reth says ${want}`);
};
/** One call of the explorer's Etherscan-compatible API, the way a client asks Etherscan: a GET with module, action and the action's parameters. */
async function door(module, action, params = {}) {
  const url = `${API}?${new URLSearchParams({ module, action, ...params, apikey: "rome" })}`;
  const res = await fetch(url, { headers: { "user-agent": "Rome Protocol rome@romeprotocol.com" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${module}&action=${action}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${module}&action=${action}: ${JSON.stringify(body.error)}`);
  if (module !== "proxy" && body.status !== "1") throw new Error(`${module}&action=${action}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.result;
}

await inModule("proxy", [
  ["proxy: block number and account balance", async () => {
    const [d, r] = [Number(BigInt(await door("proxy", "eth_blockNumber"))), await reth.getBlockNumber()];
    if (!(Math.abs(d - r) <= 10)) throw new Error(`block number: the explorer says ${d}, reth says ${r}`);
    equal("balance", await door("account", "balance", { address: A, tag: "latest" }), await reth.getBalance(A));
  }],
  ["proxy: code", async () => {
    const code = await door("proxy", "eth_getCode", { address: A, tag: "latest" });
    if (code === "0x") throw new Error("no code at the contract");
    equal("code", code, await reth.getCode(A));
  }],
  ["proxy: transaction, receipt and eth_call", async () => {
    const tx = await door("proxy", "eth_getTransactionByHash", { txhash: TX });
    if (!tx) throw new Error("no transaction");
    equal("transaction hash", tx.hash, TX);
    const receipt = await door("proxy", "eth_getTransactionReceipt", { txhash: TX });
    equal("receipt status", receipt?.status, "0x1");
    const iface = new Interface(["function count() view returns (uint256)"]);
    const out = await door("proxy", "eth_call", { to: A, data: iface.encodeFunctionData("count"), tag: "latest" });
    equal("count()", iface.decodeFunctionResult("count", out)[0], ARG_A);
  }],
]);

/** The door's getsourcecode for an address shows its OWN verification: this contract's name, the runs it was built with and its own constructor arguments (a similar match has none). */
async function ownMatch(address, arg, runs) {
  const encoded = must(sh("cast", ["abi-encode", "constructor(uint256)", arg]), "cast abi-encode").text.trim().replace(/^0x/, "");
  const [v] = await door("contract", "getsourcecode", { address });
  if (v?.ContractName !== "Counter" || v.Runs !== runs || v.OptimizationUsed !== "1" || String(v.ConstructorArguments).replace(/^0x/, "").toLowerCase() !== encoded.toLowerCase()) {
    throw new Error(`getsourcecode for ${address} is not its own verification (runs ${runs}, constructor argument ${arg}): ${JSON.stringify({ ...v, SourceCode: undefined, ABI: undefined })}`);
  }
  if (!String(v.SourceCode).includes("contract Counter")) throw new Error(`getsourcecode for ${address} has no source`);
}

await inModule("contract", [
  ["forge verify-contract, standard JSON input", async () => {
    const note = submitted(forgeVerify(A, ARG_A, RUNS_A, []), "forge verify-contract");
    await ownMatch(A, ARG_A, RUNS_A);
    return note;
  }],
  ["forge verify-contract --flatten, the single-file format", async () => {
    const note = submitted(forgeVerify(B, ARG_B, RUNS_B, ["--flatten"]), "forge verify-contract --flatten");
    await ownMatch(B, ARG_B, RUNS_B);
    return note;
  }],
  ["cast source", () => {
    const r = must(sh("cast", ["source", A, "--chain", String(CHAIN_ID), "--etherscan-api-key", "rome", "--explorer-api-url", API, "--explorer-url", EXPLORER]), "cast source");
    if (!/contract\s+Counter\b/.test(r.text)) throw new Error(`the source has no Counter:\n${r.tail}`);
  }],
  // cast interface has no --explorer-api-url: it finds the explorer by --chain in the [etherscan] table of foundry.toml, in this folder
  ["cast interface", () => {
    const r = must(sh("cast", ["interface", A, "--chain", String(CHAIN_ID), "--etherscan-api-key", "rome"]), "cast interface");
    for (const fn of ["bump()", "count()"]) if (!r.text.includes(fn)) throw new Error(`the interface has no ${fn}:\n${r.tail}`);
  }],
  ["hardhat verify", async () => {
    const note = submitted(must(sh("npx", ["hardhat", "verify", "--network", "rome", C, ARG_C], { L5_HARDHAT_RUNS: RUNS_C }), "hardhat verify"), "hardhat verify");
    await ownMatch(C, ARG_C, RUNS_C);
    return note;
  }],
  ["contract getabi", async () => {
    const abi = JSON.parse(await door("contract", "getabi", { address: A }));
    if (!JSON.stringify(abi).includes("bump")) throw new Error("the ABI has no bump");
  }],
]);

const summary = summarize(checks);
writeFileSync(OUT, JSON.stringify({ explorer: EXPLORER, chainId: CHAIN_ID, modules: MODULES, ...summary }, null, 2));
for (const f of summary.failures) console.error(`L5 FAIL: ${f.split("\n")[0]}`);
process.exit(summary.status === "failed" ? 1 : 0);
