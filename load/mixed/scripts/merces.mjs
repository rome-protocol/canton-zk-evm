// Merces (TACEO), client side only. Deploys TACEO's contracts as they are (two Groth16 verifiers and Merces, in the chain's own coin) with MPC public keys made for this
// test, then runs deposits and private transfers whose proofs are made here and verified by the verifier contract on the chain.
// There is no MPC cluster behind it: nothing settles, the queue only grows. Writes merces.json into the run folder.
//   node scripts/merces.mjs deploy
//   node scripts/merces.mjs demo [transfers, default 8]
//   node scripts/merces.mjs retrieve      the test's own MPC address takes the deposited coin back out (a helper in the demo contract) and sends it to the distributor
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { ethers } from "ethers";
import { cfg, state, save, log, provider, distributor, wallets, done, deploy, att, RUN } from "./lib.mjs";
import { mpcKeys, proveTransfer } from "./merces-lib.mjs";

const mode = process.argv[2] ?? "demo";
const names = ["merces-deployer", "merces-alice", "merces-bob", "merces-carol", "merces-dave"];
const W = wallets(names);
const dep = W["merces-deployer"];
const users = names.slice(1).map((n) => W[n]);
const E = ethers.parseEther;
const json = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const resultsPath = `${RUN}/merces.json`;
const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : { actions: [] };
const saveResults = () => writeFileSync(resultsPath, json(results) + "\n");

async function deployAll() {
  const pks = mpcKeys();
  const big = { gasLimit: 15_000_000 };
  // the contract calls three libraries: they are deployed first and linked in
  const libs = {};
  for (const [n, f] of [["BabyJubJub", "BabyJubJub.sol"], ["ActionQueueLib", "ActionQueue.sol"], ["Poseidon2T2_BN254", "Poseidon2.sol"]]) {
    libs[n] = await (await deploy(dep, `Merces library ${n}`, [f, n], [], big)).getAddress();
  }
  const cv = await deploy(dep, "Merces ClientVerifier", ["VerifierClient.sol", "Verifier"], [], big);
  const sv = await deploy(dep, "Merces ServerVerifier", ["VerifierServer.sol", "Verifier"], [], big);
  // token = address(0): the contract holds the chain's own coin. The "MPC address" is a test wallet; no node runs behind it.
  const m = await deploy(dep, "Merces", ["Merces.sol", "Merces"],
    [await cv.getAddress(), await sv.getAddress(), dep.address, ethers.ZeroAddress, pks[0], pks[1], pks[2], "ostia-devnet"], big, libs);
  state.merces = { address: await m.getAddress(), mpcAddress: dep.address, native: true, users: Object.fromEntries(names.slice(1).map((n) => [n, W[n].address])) };
  save();
  log("Merces", state.merces.address, "queue size:", String(await m.getQueueSize()));
  return m;
}
const merces = () => att(state.contracts.Merces.address, "Merces.sol", "Merces", dep);

async function record(label, rc, extra = {}) {
  results.actions.push({ label, tx: rc.hash, block: rc.blockNumber, gas: rc.gasUsed.toString(), ...extra });
  saveResults();
}

if (mode === "deploy") {
  await deployAll();
} else if (mode === "demo") {
  const n = Number(process.argv[3] ?? 8);
  const m = merces();
  const pks = (await m.getMpcPublicKeys()).map((p) => ({ x: p.x, y: p.y }));
  const queue0 = await m.getQueueSize();
  // deposits: plain, the amount is public, the balance afterwards is only a commitment the MPC would hold
  const dep0 = [5n, 4n, 3n, 2n];
  for (const [i, u] of users.entries()) {
    const rc = await done(`deposit ${dep0[i]} tROME from ${names[i + 1]}`, att(await m.getAddress(), "Merces.sol", "Merces", u).deposit(E(String(dep0[i])), { value: E(String(dep0[i])) }));
    await record(`deposit ${dep0[i]} tROME (${names[i + 1]})`, rc, { amountWei: E(String(dep0[i])).toString() });
  }
  // transfers: proved here, in the sender's process, with TACEO's client code; the contract verifies the proof before it queues the action
  for (let i = 0; i < n; i++) {
    const from = users[i % users.length], to = users[(i + 1) % users.length];
    const amount = E("0.1") * BigInt(1 + (i % 5));
    const { args, proveMs } = await proveTransfer(amount, pks);
    const mf = att(await m.getAddress(), "Merces.sol", "Merces", from);
    const rc = await done(`private transfer ${i + 1}/${n}: ${names[users.indexOf(from) + 1]} to ${names[users.indexOf(to) + 1]} (proved in ${proveMs} ms)`, mf.transfer(to.address, ...args, { gasLimit: 2_000_000 }));
    await record(`private transfer ${i + 1}`, rc, { proveMs, commitment: args[0].toString() });
    if (i === 0) {
      // the same call with one bit of the proof changed must be refused by the verifier
      const bad = [...args[3]]; bad[0] = bad[0] ^ 1n;
      try { await mf.transfer.staticCall(to.address, args[0], args[1], args[2], bad); results.tamperedProof = "NOT refused"; }
      catch (e) { results.tamperedProof = `refused: ${e.shortMessage ?? e.message}`.slice(0, 200); }
      log("tampered proof:", results.tamperedProof);
    }
  }
  // a withdrawal request: the amount is public, the MPC would check the balance when it settles
  const rcw = await done("withdraw request 0.5 tROME from merces-alice", att(await m.getAddress(), "Merces.sol", "Merces", users[0]).withdraw(E("0.5")));
  await record("withdraw request 0.5 tROME", rcw);
  // what is on chain now
  const addr = await m.getAddress();
  const head = await provider.getBlockNumber();
  const count = async (ev) => (await m.queryFilter(m.filters[ev](), 0, head)).length;
  results.summary = {
    contract: addr, queueSizeBefore: queue0.toString(), queueSizeAfter: (await m.getQueueSize()).toString(), nextActionIndex: (await m.getNextActionIndex()).toString(),
    events: { Deposit: await count("Deposit"), Transfer: await count("Transfer"), Withdraw: await count("Withdraw"), ProcessedMPC: await count("ProcessedMPC") },
    heldTrome: ethers.formatEther(await provider.getBalance(addr)),
  };
  saveResults();
  log("summary", json(results.summary).replace(/\s+/g, " "));
} else if (mode === "probe") {
  // proves N transfers and asks the chain to verify each one with an eth_call (nothing is sent); a proof the verifier refuses is checked here with snarkjs too
  const n = Number(process.argv[3] ?? 30);
  const m = merces();
  const pks = (await m.getMpcPublicKeys()).map((p) => ({ x: p.x, y: p.y }));
  const mf = att(await m.getAddress(), "Merces.sol", "Merces", users[0]);
  const bad = [];
  for (let i = 0; i < n; i++) {
    const { args } = await proveTransfer(E("0.1"), pks);
    try { await mf.transfer.staticCall(users[1].address, ...args, { gasLimit: 2_000_000 }); }
    catch (e) { bad.push({ i, err: e.shortMessage ?? e.message, args }); }
  }
  log(`probe: ${bad.length} of ${n} proofs refused by the verifier`);
  writeFileSync(`${RUN}/merces-probe.json`, json({ n, refused: bad }) + "\n");
} else if (mode === "retrieve") {
  const m = merces();
  const bal = await provider.getBalance(await m.getAddress());
  const rc = await done(`retrieveFunds: ${ethers.formatEther(bal)} tROME back to the distributor`, m.retrieveFunds(distributor().address));
  await record("retrieveFunds", rc, { amountWei: bal.toString() });
} else { console.error("usage: merces.mjs deploy|demo [n]|retrieve"); process.exit(2); }
process.exit(0);
