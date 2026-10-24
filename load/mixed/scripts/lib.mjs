// Shared by the deploy, the verify step and the load driver: config, the run folder, the state file, wallets and transactions.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { ethers } from "ethers";

export const cfg = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
export const RUN = process.env.RUN_DIR || "./runs/local";
export const RPC = process.env.RPC || cfg.rpc;
export const provider = new ethers.JsonRpcProvider(RPC, cfg.chainId, { staticNetwork: true, batchMaxCount: 1 });

mkdirSync(`${RUN}/keys`, { recursive: true, mode: 0o700 });
const statePath = `${RUN}/addresses.json`;
export const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { chainId: cfg.chainId, rpc: RPC, contracts: {}, steps: {}, wallets: {} };
// Two scripts may run at once (the oracle step waits for RedStone's gateways while the private-transfer step runs): a save keeps what the other one wrote meanwhile.
export const save = () => {
  if (existsSync(statePath)) {
    const disk = JSON.parse(readFileSync(statePath, "utf8"));
    for (const k of Object.keys(disk)) {
      if (disk[k] && typeof disk[k] === "object" && !Array.isArray(disk[k]) && state[k] && typeof state[k] === "object") state[k] = { ...disk[k], ...state[k] };
      else if (!(k in state)) state[k] = disk[k];
    }
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export { log };

/** The funded key that deploys. It is read from keys/distributor.key and never printed. */
export function distributor() {
  const k = readFileSync(`${RUN}/keys/distributor.key`, "utf8").trim();
  return new ethers.Wallet(k.startsWith("0x") ? k : "0x" + k, provider);
}

/** Test wallets: made once, kept in keys/wallets.json (0600), the same on every later run. Names only; the keys are never printed. */
export function wallets(names) {
  const p = `${RUN}/keys/wallets.json`;
  const all = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  let changed = false;
  for (const n of names) if (!all[n]) { all[n] = ethers.Wallet.createRandom().privateKey; changed = true; }
  if (changed) { writeFileSync(p, JSON.stringify(all, null, 2), { mode: 0o600 }); chmodSync(p, 0o600); }
  return Object.fromEntries(names.map((n) => [n, new ethers.Wallet(all[n], provider)]));
}

// Our own and the npm contracts are built into out/; TACEO's Merces contracts (fetched by `run.sh merces-fetch`) into their own folder.
export const MERCES_ROOT = "third_party/merces1-x402/contracts";
export const artifact = (file, name) => {
  const p = `out/${file}/${name}.json`;
  return JSON.parse(readFileSync(existsSync(p) ? p : `${MERCES_ROOT}/out/${file}/${name}.json`, "utf8"));
};

/** Waits for a sent transaction to be in a final block (the public RPC answers only for final blocks) and throws if it failed. */
export async function done(label, sent) {
  const tx = await sent;
  const rc = await tx.wait(1, 900_000);
  if (!rc || rc.status !== 1) throw new Error(`${label} failed (${tx.hash})`);
  log(`${label}  ${rc.hash}  block ${rc.blockNumber}  gas ${rc.gasUsed}`);
  return rc;
}

/** Runs a step once: its first transaction hash is kept in the state file and the step is skipped on the next run. */
export async function step(name, fn) {
  if (state.steps[name]) return;
  const rc = await fn();
  state.steps[name] = { tx: rc?.hash ?? null, block: rc?.blockNumber ?? null };
  save();
}

/** Deploys a contract unless the state file has it and the chain has code at its address. */
export async function deploy(signer, name, [file, cname], args = [], overrides = {}) {
  const a = artifact(file, cname);
  const f = new ethers.ContractFactory(a.abi, a.bytecode.object, signer);
  const s = state.contracts[name];
  if (s && (await provider.getCode(s.address)).length > 2) return new ethers.Contract(s.address, a.abi, signer);
  const c = await f.deploy(...args, overrides);
  const rc = await done(`deploy ${name}`, Promise.resolve(c.deploymentTransaction()));
  state.contracts[name] = { address: await c.getAddress(), tx: rc.hash, block: rc.blockNumber, gas: rc.gasUsed.toString(), contract: `${file}:${cname}`, ctorArgs: f.interface.encodeDeploy(args).slice(2) };
  if (!existsSync(`out/${file}`)) state.contracts[name].root = MERCES_ROOT; // built from the fetched Merces repository, not from this kit
  save();
  return c;
}

/** Records a contract that another contract created (a pair, a proxy): no constructor arguments are kept, the verifier compares the code. */
export function record(name, address, contract, tx, ctorArgs = "") {
  if (!state.contracts[name]) { state.contracts[name] = { address, tx: tx ?? null, contract, ctorArgs }; save(); }
}

export const att = (address, file, cname, signer) => new ethers.Contract(address, artifact(file, cname).abi, signer);
