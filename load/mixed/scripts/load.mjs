// The mixed load driver.
//   node scripts/load.mjs seed                 makes the test wallets (keys/wallets.json, 0600) and gives them their starting tROME, tUSD and tETH through the Seeder contract
//   node scripts/load.mjs calibrate            one action of every kind, sent and read back one at a time: the gas each uses and whether the deliberate reverts revert
//   node scripts/load.mjs run [name]           the timed run: the mix in config.json, phase by phase; every transaction is followed until it is in a final block
//   node scripts/load.mjs check-reverts        sends nothing: eth_call of each deliberate-revert case, each must revert (the swap case for its own reason, with a control that goes through)
//   node scripts/load.mjs report <name>        the numbers of a finished run (report.json and report.md in its folder)
// Everything goes to the public RPC like any user would send it, under the RPC's own limit (see load-rpc.mjs). Transactions are signed here; nonces are counted here.
import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { ethers } from "ethers";
import { cfg, state, save, log, provider, distributor, wallets, done, step, deploy, att, artifact, RUN } from "./lib.mjs";
import { fees } from "./fee.mjs";
import { classify, emptyTally, tallyLine, passes, reasonFromError, reasonFinder } from "./classify.mjs";
import { rpc, rpcBatch, left, used, stats as rpcStats, setBudget, sleep, UA } from "./load-rpc.mjs";

const mode = process.argv[2];
const M = cfg.mix;
// LOAD_PHASES="2:1,3:1" replaces the phases of config.json with rate:minutes pairs (for a short trial); "best" is allowed as a rate
if (process.env.LOAD_PHASES) M.phases = process.env.LOAD_PHASES.split(",").map((x, i) => { const [r, m] = x.split(":"); return { name: r === "best" ? "best" : `${r} tx/s`, rate: r === "best" ? "best" : Number(r), minutes: Number(m) }; });
const E = ethers.parseEther;
const U = (s) => ethers.parseUnits(String(s), 6);
const need = (n) => { const c = state.contracts[n]; if (!c) throw new Error(`${n} is not deployed: run deploy first`); return c.address; };
const I = (f, n) => new ethers.Interface(artifact(f, n).abi);
const names = Array.from({ length: M.wallets }, (_, i) => `load${String(i + 1).padStart(3, "0")}`);
const HOLDERS = ["holder1", "holder2", "holder3", "holder4"];

// ---------------------------------------------------------------- seed
if (mode === "seed") {
  const d = distributor();
  const W = wallets(names);
  const tUSD = att(need("tUSD"), "TestToken.sol", "TestToken", d), tETH = att(need("tETH"), "TestToken.sol", "TestToken", d);
  const seeder = await deploy(d, "Seeder", ["Seeder.sol", "Seeder"]);
  const s = M.seed, n = names.length;
  const needUsd = U(s.tUsdEach) * BigInt(n), needEth = E(s.tEthEach) * BigInt(n);
  if ((await tUSD.balanceOf(d.address)) < needUsd) await step("mint-load-tUSD", () => done("mint tUSD for the load wallets", tUSD.mint(d.address, needUsd)));
  if ((await tETH.balanceOf(d.address)) < needEth) await step("mint-load-tETH", () => done("mint tETH for the load wallets", tETH.mint(d.address, needEth)));
  await step("seeder-approve-tUSD", () => done("approve the seeder for tUSD", tUSD.approve(seeder.target, ethers.MaxUint256)));
  await step("seeder-approve-tETH", () => done("approve the seeder for tETH", tETH.approve(seeder.target, ethers.MaxUint256)));
  const coin = E(s.tromeEach);
  const txs = [];
  for (let i = 0; i < n; i += s.perTx) {
    const part = names.slice(i, i + s.perTx).map((x) => W[x].address);
    await step(`seed-${i}`, async () => {
      const rc = await done(`seed ${part.length} wallets (${names[i]}..${names[i + part.length - 1]})`, seeder.seed(part, coin, tUSD.target, U(s.tUsdEach), tETH.target, E(s.tEthEach), { value: coin * BigInt(part.length), gasLimit: 12_000_000 }));
      return rc;
    });
    txs.push({ first: names[i], count: part.length, tx: state.steps[`seed-${i}`].tx, block: state.steps[`seed-${i}`].block });
  }
  state.load = { wallets: n, seeded: txs, each: s };
  save();
  writeFileSync(`${RUN}/seed.json`, JSON.stringify(state.load, null, 2) + "\n");
  log(`seeded ${n} wallets in ${txs.length} transactions`);
  process.exit(0);
}

// ---------------------------------------------------------------- shared by calibrate and run
const W = wallets([...names, ...HOLDERS, "unverified"]);
const pool = names.map((n) => W[n]);
const holders = HOLDERS.map((n) => W[n]);
const A = {
  tUSD: need("tUSD"), tETH: need("tETH"), wt: need("WtROME"), pass: need("OstiaPass"), items: need("OstiaItems"),
  router: need("UniswapV2Router02"), pairUW: need("UniswapV2Pair tUSD/WtROME"), pairET: need("UniswapV2Pair tETH/tUSD"),
  trex: state.trex.token, vault: state.redstone?.vault ?? state.contracts.PriceVault?.address, merces: state.contracts.Merces.address,
};
const F = {
  tok: I("TestToken.sol", "TestToken"), wt: I("WtROME.sol", "WtROME"), pass: I("OstiaPass.sol", "OstiaPass"), items: I("OstiaItems.sol", "OstiaItems"),
  router: I("UniswapV2Router02.sol", "UniswapV2Router02"), trex: I("Token.sol", "Token"), vault: I("PriceVault.sol", "PriceVault"), merces: I("Merces.sol", "Merces"),
  cver: I("VerifierClient.sol", "Verifier"),
};
const G = M.gasLimit;
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const other = (w, list = pool) => { let o; do o = pick(list); while (o.address === w.address); return o; };
const deadline = () => Math.floor(Date.now() / 1000) + 3600;
const ZERO = 0n;

// wallets' bookkeeping, kept here (no reads from the chain): nonces, approvals, what a wallet holds of what it made
const nonces = new Map(), approved = new Set(), wrapped = new Map(), lp = new Map(), nfts = new Map(), items = new Map(), deposited = new Set(), busy = new Set();
const wrp = (w) => wrapped.get(w.address) ?? ZERO;
const addWrp = (w, v) => wrapped.set(w.address, wrp(w) + v);
const itemsOf = (w) => [...items.entries()].filter(([k, v]) => k.startsWith(w.address) && v > 0n).map(([k, v]) => [Number(k.split(":")[1]), v]);
/** Bookkeeping is booked when an action is planned, so two actions of one wallet do not use the same funds; `undo` takes it back when the send is refused or the transaction fails. */
const undoWith = (s, f) => { const prev = s.undo; s.undo = () => { prev?.(); f(); }; };
const book = (s, w, v) => { addWrp(w, v); undoWith(s, () => addWrp(w, -v)); };
const bookLp = (s, w, pair, d) => { const k = `${w.address}:${pair}`; lp.set(k, (lp.get(k) ?? 0) + d); undoWith(s, () => lp.set(k, (lp.get(k) ?? 0) - d)); };
const addItem = (w, id, v) => items.set(`${w.address}:${id}`, (items.get(`${w.address}:${id}`) ?? ZERO) + v);

/** Approval of `spender` for `token`, once per wallet (the first time an action needs it). */
function approval(w, token, spender, out) {
  const k = `${w.address}:${token}:${spender}`;
  if (approved.has(k)) return;
  approved.add(k);
  out.push({ kind: "erc20Approve", sub: "lazy", to: token, data: F.tok.encodeFunctionData("approve", [spender, ethers.MaxUint256]), gas: G.erc20Approve, undo: () => approved.delete(k) });
}

let payload = null; // { hex, at } the newest signed RedStone prices
const fresh = () => payload && Date.now() - payload.at < 120_000;
const proofs = []; // ready Merces proofs
const specials = {}; // kind -> next due time (ms)

/** The transactions of one action by wallet w: lazy approvals first, then the action. Returns null when the wallet is not able to do it (the caller picks another). */
function plan(kind, w) {
  const out = [];
  const tx = (o) => out.push({ kind, ...o });
  switch (kind) {
    case "erc20Transfer": {
      const t = pick(["tUSD", "tUSD", "tETH"]);
      const amt = t === "tUSD" ? U(1 + rnd(10)) : E("0.001") * BigInt(1 + rnd(9));
      tx({ to: A[t], data: F.tok.encodeFunctionData("transfer", [other(w).address, amt]), gas: G.erc20Transfer }); break;
    }
    case "erc20Approve": // a plain approval of a friend, a finite amount
      tx({ to: A[pick(["tUSD", "tETH"])], data: F.tok.encodeFunctionData("approve", [other(w).address, U(100 * (1 + rnd(9)))]), gas: G.erc20Approve }); break;
    case "wrap":
      if (wrp(w) > E("8")) return null;
      tx({ to: A.wt, data: F.wt.encodeFunctionData("deposit"), value: E("0.5"), gas: G.wrap }); book(out.at(-1), w, E("0.5")); break;
    case "unwrap":
      if (wrp(w) < E("0.2")) return null;
      tx({ to: A.wt, data: F.wt.encodeFunctionData("withdraw", [E("0.2")]), gas: G.unwrap }); book(out.at(-1), w, -E("0.2")); break;
    case "swapUsdToTrome":
      approval(w, A.tUSD, A.router, out);
      tx({ to: A.router, data: F.router.encodeFunctionData("swapExactTokensForTokens", [U(20), 0, [A.tUSD, A.wt], w.address, deadline()]), gas: G.swap }); book(out.at(-1), w, E("1")); break;
    case "swapTromeToUsd":
      if (wrp(w) < E("0.3")) return null;
      approval(w, A.wt, A.router, out);
      tx({ to: A.router, data: F.router.encodeFunctionData("swapExactTokensForTokens", [E("0.2"), 0, [A.wt, A.tUSD], w.address, deadline()]), gas: G.swap }); book(out.at(-1), w, -E("0.2")); break;
    case "swapEthToUsd":
      approval(w, A.tETH, A.router, out);
      tx({ to: A.router, data: F.router.encodeFunctionData("swapExactTokensForTokens", [E("0.01"), 0, [A.tETH, A.tUSD], w.address, deadline()]), gas: G.swap }); break;
    case "swapUsdToEth":
      approval(w, A.tUSD, A.router, out);
      tx({ to: A.router, data: F.router.encodeFunctionData("swapExactTokensForTokens", [U(30), 0, [A.tUSD, A.tETH], w.address, deadline()]), gas: G.swap }); break;
    case "addLiquidity": {
      if (Math.random() < 0.5 && wrp(w) >= E("0.6")) {
        approval(w, A.tUSD, A.router, out); approval(w, A.wt, A.router, out);
        tx({ to: A.router, data: F.router.encodeFunctionData("addLiquidity", [A.tUSD, A.wt, U(5), E("0.5"), 0, 0, w.address, deadline()]), gas: G.addLiquidity });
        book(out.at(-1), w, -E("0.5")); bookLp(out.at(-1), w, A.pairUW, 1);
      } else {
        approval(w, A.tETH, A.router, out); approval(w, A.tUSD, A.router, out);
        tx({ to: A.router, data: F.router.encodeFunctionData("addLiquidity", [A.tETH, A.tUSD, E("0.01"), U(35), 0, 0, w.address, deadline()]), gas: G.addLiquidity });
        bookLp(out.at(-1), w, A.pairET, 1);
      }
      break;
    }
    case "removeLiquidity": {
      const p = [A.pairUW, A.pairET].find((x) => (lp.get(`${w.address}:${x}`) ?? 0) > 0);
      if (!p) return null;
      approval(w, p, A.router, out);
      const [a, b] = p === A.pairUW ? [A.tUSD, A.wt] : [A.tETH, A.tUSD];
      tx({ to: A.router, data: F.router.encodeFunctionData("removeLiquidity", [a, b, 1_000_000_000n, 0, 0, w.address, deadline()]), gas: G.removeLiquidity });
      bookLp(out.at(-1), w, p, -1);
      if (p === A.pairUW) book(out.at(-1), w, E("0.01"));
      break;
    }
    case "erc721Mint":
      tx({ to: A.pass, data: F.pass.encodeFunctionData("mint"), gas: G.erc721Mint, after: (it) => { if (it.tokenId != null) nfts.set(w.address, [...(nfts.get(w.address) ?? []), it.tokenId]); } }); break;
    case "erc721Transfer": {
      const mine = nfts.get(w.address) ?? [];
      if (!mine.length) return null;
      const id = mine.shift(); const to = other(w);
      tx({ to: A.pass, data: F.pass.encodeFunctionData("safeTransferFrom(address,address,uint256)", [w.address, to.address, id]), gas: G.erc721Transfer,
        after: (it) => { if (it.success) nfts.set(to.address, [...(nfts.get(to.address) ?? []), id]); } }); break;
    }
    case "erc1155Mint": {
      const id = 1 + rnd(5), amt = 1 + rnd(20);
      tx({ to: A.items, data: F.items.encodeFunctionData("mint", [id, amt]), gas: G.erc1155Mint, after: (it) => { if (it.success) addItem(w, id, BigInt(amt)); } }); break;
    }
    case "erc1155MintBatch": {
      const ids = [1, 2, 3, 4, 5].sort(() => Math.random() - 0.5).slice(0, 2 + rnd(2)); const amts = ids.map(() => 1 + rnd(20));
      tx({ to: A.items, data: F.items.encodeFunctionData("mintBatch", [ids, amts]), gas: G.erc1155MintBatch, after: (it) => { if (it.success) ids.forEach((id, i) => addItem(w, id, BigInt(amts[i]))); } }); break;
    }
    case "erc1155Transfer": {
      const mine = itemsOf(w); if (!mine.length) return null;
      const [id, have] = pick(mine); const amt = 1n; const to = other(w);
      items.set(`${w.address}:${id}`, have - amt);
      tx({ to: A.items, data: F.items.encodeFunctionData("safeTransferFrom", [w.address, to.address, id, amt, "0x"]), gas: G.erc1155Transfer, after: (it) => { if (it.success) addItem(to, id, amt); } }); break;
    }
    case "erc1155BatchTransfer": {
      const mine = itemsOf(w); if (mine.length < 2) return null;
      const two = mine.slice(0, 2); const to = other(w);
      for (const [id, have] of two) items.set(`${w.address}:${id}`, have - 1n);
      tx({ to: A.items, data: F.items.encodeFunctionData("safeBatchTransferFrom", [w.address, to.address, two.map((x) => x[0]), two.map(() => 1n), "0x"]), gas: G.erc1155BatchTransfer,
        after: (it) => { if (it.success) for (const [id] of two) addItem(to, id, 1n); } }); break;
    }
    case "trexTransfer":
      tx({ to: A.trex, data: F.trex.encodeFunctionData("transfer", [other(w, holders).address, U(1 + rnd(5))]), gas: G.trexTransfer }); break;
    case "trexRefused": // to the address that has no identity in the registry: the token refuses it, the transaction reverts on purpose
      tx({ to: A.trex, data: F.trex.encodeFunctionData("transfer", [W.unverified.address, U(1)]), gas: G.trexRefused, expectRevert: true }); break;
    case "vaultRecord":
      if (!fresh()) return null;
      tx({ to: A.vault, data: F.vault.encodeFunctionData("record") + payload.hex, gas: G.vaultRecord }); break;
    case "mercesDeposit":
      tx({ to: A.merces, data: F.merces.encodeFunctionData("deposit", [E("0.05")]), value: E("0.05"), gas: G.mercesDeposit, after: () => deposited.add(w.address) }); break;
    case "mercesTransfer": {
      if (!proofs.length || !deposited.has(w.address)) return null;
      const args = proofs.shift();
      tx({ to: A.merces, data: F.merces.encodeFunctionData("transfer", [other(w).address, ...args]), gas: G.mercesTransfer }); break;
    }
    case "revert": { // five ways to be refused, sent as real transactions
      const which = rnd(5);
      if (which === 0) tx({ to: A.tUSD, data: F.tok.encodeFunctionData("transfer", [other(w).address, U(999_999_999)]), gas: G.revert, sub: "ERC-20 amount over balance", expectRevert: true });
      else if (which === 1) tx({ to: A.items, data: F.items.encodeFunctionData("mint", [99, 1]), gas: G.revert, sub: "ERC-1155 bad id", expectRevert: true });
      else if (which === 2) tx({ to: A.wt, data: F.wt.encodeFunctionData("withdraw", [E("1000000")]), gas: G.revert, sub: "unwrap more than held", expectRevert: true });
      else if (which === 3) tx({ to: A.pass, data: F.pass.encodeFunctionData("transferFrom", [other(w).address, w.address, 999_999]), gas: G.revert, sub: "ERC-721 not the owner", expectRevert: true });
      else { approval(w, A.tUSD, A.router, out); tx({ to: A.router, data: F.router.encodeFunctionData("swapExactTokensForTokens", [U(20), E("999999"), [A.tUSD, A.tETH], w.address, deadline()]), gas: G.revert, sub: "swap: output below the minimum", expectRevert: true }); }
      break;
    }
    default: throw new Error("unknown kind " + kind);
  }
  return out;
}

// ---------------------------------------------------------------- sending
let gasPrice = 1_000_000_150n;
async function refreshGasPrice() { try { gasPrice = BigInt(await rpc("eth_gasPrice")); } catch {} }
let EVENTS = null;
const ev = (o) => { if (EVENTS) appendFileSync(EVENTS, JSON.stringify({ t: Date.now(), ...o }) + "\n"); };
const sent = new Map(); // hash -> record
const counters = { sent: 0, rejected: 0, resync: 0 };
// what became of the transactions that are final: success / reverted on purpose / unexpected revert (see classify.mjs)
const outcomes = emptyTally();
// the reason of an unexpected revert: the same call replayed with eth_call from the same wallet, a few per kind (the RPC budget is shared)
const findReason = reasonFinder(async (r) => {
  try { await rpc("eth_call", [{ from: r.from, to: r.call.to, data: r.call.data, value: r.call.value ? ethers.toBeHex(r.call.value) : undefined, gas: ethers.toBeHex(r.gas) }, "latest"]); return "the replay went through (state has changed since)"; }
  catch (e) { return reasonFromError(e); }
});
const reasonJobs = [];

function signed(w, spec, nonce) {
  const t = ethers.Transaction.from({ type: 2, chainId: cfg.chainId, nonce, to: spec.to, data: spec.data, value: spec.value ?? 0n, gasLimit: spec.gas,
    ...fees(gasPrice) });
  t.signature = w.signingKey.sign(t.unsignedHash);
  return { raw: t.serialized, hash: t.hash };
}
async function resync(w) {
  counters.resync++;
  try { nonces.set(w.address, Number(await rpc("eth_getTransactionCount", [w.address, "pending"]))); } catch {}
}
/** Signs and sends one transaction of wallet w. The nonce is taken at once (counted here), so sends of different wallets overlap freely. */
const sendChain = new Map();
async function send(w, spec, phase) {
  const nonce = nonces.get(w.address) ?? 0;
  nonces.set(w.address, nonce + 1);
  const { raw, hash } = signed(w, spec, nonce);
  const rec = { hash, kind: spec.kind, sub: spec.sub, from: w.address, nonce, phase, sentAt: Date.now(), expectRevert: !!spec.expectRevert, after: spec.after, undo: spec.undo, gas: spec.gas, call: { to: spec.to, data: spec.data, value: spec.value } };
  // one wallet's transactions go to the RPC in nonce order: two sent at once could pass each other while they wait for the rate budget, and the later one is refused (nonce gap)
  const go = async () => {
    try {
      await rpc("eth_sendRawTransaction", [raw]);
      rec.acceptedAt = Date.now(); sent.set(hash, rec); counters.sent++;
      ev({ e: "sent", hash, kind: spec.kind, sub: spec.sub, from: w.address, nonce, phase, sentAt: rec.sentAt, acceptedAt: rec.acceptedAt, gas: spec.gas, expectRevert: rec.expectRevert });
    } catch (e) {
      counters.rejected++;
      try { spec.undo?.(); } catch {}
      ev({ e: "rejected", hash, kind: spec.kind, sub: spec.sub, from: w.address, nonce, phase, err: String(e.message).slice(0, 200), code: e.code });
      log("rejected", spec.kind, String(e.message).slice(0, 100));
      await resync(w);
    }
  };
  const mine = (sendChain.get(w.address) ?? Promise.resolve()).then(go);
  sendChain.set(w.address, mine);
  await mine;
  return rec;
}

/** The three MPC public keys the Merces contract holds (an eth_call). The contract returns them as three values. */
async function mpcPks() {
  const r = F.merces.decodeFunctionResult("getMpcPublicKeys", await rpc("eth_call", [{ to: A.merces, data: F.merces.encodeFunctionData("getMpcPublicKeys") }, "latest"]));
  return (r.length === 1 ? r[0] : r).map((p) => ({ x: p.x, y: p.y }));
}

// ---------------------------------------------------------------- check-reverts
// Sends nothing: eth_call of every deliberate-revert case from one wallet. Each must revert; the swap case must revert for its own reason (output below the minimum)
// and the same swap with a minimum of 0 must go through (the control), so a missing allowance or balance cannot pass for the right revert.
if (mode === "check-reverts") {
  const w = pool[0];
  const seen = new Map();
  for (let i = 0; i < 500 && seen.size < 5; i++) for (const sp of plan("revert", w) ?? []) if (sp.expectRevert && !seen.has(sp.sub)) seen.set(sp.sub, sp);
  if (seen.size < 5) throw new Error("not every deliberate-revert case was planned: " + [...seen.keys()].join(", "));
  const call = async (sp, data) => { try { await rpc("eth_call", [{ from: w.address, to: sp.to, data, value: sp.value ? ethers.toBeHex(sp.value) : undefined, gas: ethers.toBeHex(sp.gas) }, "latest"]); return null; } catch (e) { return String(e.message); } };
  let bad = 0;
  for (const [sub, sp] of seen) {
    const err = await call(sp, sp.data);
    let ok = err !== null, note = err ? err.slice(0, 110) : "DID NOT REVERT";
    if (sub === "swap: output below the minimum") {
      const [amtIn, , path, to, dl] = F.router.decodeFunctionData("swapExactTokensForTokens", sp.data).toArray();
      const control = await call(sp, F.router.encodeFunctionData("swapExactTokensForTokens", [amtIn, 0, path, to, dl]));
      ok = ok && /INSUFFICIENT_OUTPUT_AMOUNT/.test(err) && control === null;
      note += control === null ? " | control with minimum 0: goes through" : ` | control with minimum 0 FAILED: ${control.slice(0, 80)}`;
    }
    if (!ok) bad++;
    log(ok ? "reverts" : "WRONG", sub, "->", note);
  }
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------- calibrate
if (mode === "calibrate") {
  EVENTS = null;
  await refreshGasPrice();
  // fresh nonces, MPC keys, one prover set-up, one RedStone try
  for (const w of [...pool.slice(0, 6), ...holders]) nonces.set(w.address, Number(await rpc("eth_getTransactionCount", [w.address, "pending"])));
  const { mpcKeys, proveTransfer } = await import("./merces-lib.mjs");
  const { pricePayload } = await import("./oracle.mjs");
  try { process.env.REDSTONE_WAIT_MIN = "0"; const p = await pricePayload(); payload = { hex: p.payload, at: Date.now() }; log("RedStone payload", p.bytes, "bytes"); } catch (e) { log("no RedStone payload:", e.message.slice(0, 100)); }
  const cverifierShim = { compressProof: async (flat) => F.cver.decodeFunctionResult("compressProof", await rpc("eth_call", [{ to: state.contracts["Merces ClientVerifier"].address, data: F.cver.encodeFunctionData("compressProof", [flat]) }, "latest"]))[0] };
  const pks = await mpcPks();
  proofs.push((await proveTransfer(E("0.1"), pks, cverifierShim)).args);
  const w = pool[0];
  deposited.add(w.address);
  const result = {};
  const kinds = ["erc20Transfer", "erc20Approve", "wrap", "unwrap", "swapUsdToTrome", "swapTromeToUsd", "swapEthToUsd", "swapUsdToEth", "addLiquidity", "removeLiquidity",
    "erc721Mint", "erc721Transfer", "erc1155Mint", "erc1155MintBatch", "erc1155Transfer", "erc1155BatchTransfer", "trexTransfer", "trexRefused", "vaultRecord", "mercesDeposit", "mercesTransfer", "revert"];
  // wrap first so that the WtROME actions can run; mints first for the same reason
  const order = ["wrap", "erc721Mint", "erc1155Mint", "erc1155MintBatch", ...kinds.filter((k) => !["wrap", "erc721Mint", "erc1155Mint", "erc1155MintBatch"].includes(k))];
  for (const k of order) {
    for (let tries = 0; tries < 2; tries++) {
      const w = k.startsWith("trex") ? holders[0] : pool[tries];
      if (k === "mercesTransfer") deposited.add(w.address);
      const specs = plan(k, w);
      if (!specs) { result[k] = "not possible yet"; continue; }
      for (const s of specs) {
        const rec = await send(w, s, "calibrate");
        let rc = null; for (let i = 0; i < 90 && !rc; i++) { await sleep(2000); rc = await rpc("eth_getTransactionReceipt", [rec.hash]); }
        const o = { tx: rec.hash, label: s.sub ?? s.kind, status: rc ? Number(rc.status) : "no receipt", gasUsed: rc ? Number(rc.gasUsed) : null, gasLimit: s.gas };
        if (rc?.logs?.length && k === "erc721Mint") { const l = rc.logs.find((x) => x.topics.length === 4); if (l) nfts.set(w.address, [...(nfts.get(w.address) ?? []), BigInt(l.topics[3])]); }
        if (rc && Number(rc.status) === 1 && s.after) s.after({ success: true, tokenId: null });
        if (rc && Number(rc.status) !== 1) s.undo?.();
        (result[k] ??= []).push(o);
        log(k, JSON.stringify(o));
      }
      break;
    }
  }
  writeFileSync(`${RUN}/calibrate.json`, JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
}

// ---------------------------------------------------------------- the run
if (mode !== "run") { console.error("usage: load.mjs seed|calibrate|check-reverts|run [name]|report <name>"); process.exit(2); }
const NAME = process.argv[3] ?? `run-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
const DIR = `${RUN}/load/${NAME}`;
mkdirSync(DIR, { recursive: true });
EVENTS = `${DIR}/events.ndjson`;
setBudget(M.rpcCallsPerMinute);
process.env.REDSTONE_WAIT_MIN = "0"; // one try each time: the feeder loop below asks again
const { pricePayload } = await import("./oracle.mjs");
const { proveTransfer } = await import("./merces-lib.mjs");
const t0 = Date.now();
let running = true;
const rest = async (path) => {
  for (let i = 0; ; i++) {
    const r = await fetch(cfg.explorer + path, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 429 && i < 6) { await sleep(2000); continue; }
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }
};

// nonces of every sender, read once (200 wallets: the first minute's budget)
for (let i = 0; i < pool.length + holders.length; i += 20) {
  const part = [...pool, ...holders].slice(i, i + 20);
  const res = await rpcBatch(part.map((w) => ["eth_getTransactionCount", [w.address, "pending"]]));
  part.forEach((w, j) => nonces.set(w.address, Number(res[j].result)));
}
await refreshGasPrice();
log(`run ${NAME}: ${pool.length} wallets and ${holders.length} holders; RPC budget ${M.rpcCallsPerMinute} calls a minute`);

// block watcher: the explorer's block list (REST, its own budget). A block with its final time set is final; its transactions are read then.
const blocks = new Map();
let headSeen = 0;
async function watch() {
  while (running || sent.size > finals()) {
    try {
      const j = await rest("/api/blocks?limit=30");
      const now = Date.now();
      if (!headSeen) headSeen = j.items[0].number; // what is on the chain before the run is not ours
      for (const b of j.items.slice().reverse()) {
        if (b.number <= headSeen && !blocks.has(b.number)) continue;
        let rec = blocks.get(b.number);
        if (!rec) { rec = { n: b.number, firstSeenAt: now, finalAt: null, txsDone: false }; blocks.set(b.number, rec); }
        if (b.finalSeconds != null && !rec.finalAt) { rec.finalAt = now; rec.info = b; ev({ e: "block", n: b.number, txCount: b.txCount, gasUsed: b.gasUsed, proofSeconds: b.proofSeconds, finalSeconds: b.finalSeconds, commitSeconds: b.commitSeconds, recordTime: b.recordTime, updateId: b.updateId, timestamp: b.timestamp, firstSeenAt: rec.firstSeenAt, finalAt: now }); }
        if (rec.finalAt && !rec.txsDone) await readTxs(rec);
      }
    } catch (e) { log("watch:", String(e.message).slice(0, 100)); }
    await sleep(1200);
  }
}
let finalCount = 0;
const finals = () => finalCount;
async function readTxs(rec) {
  let after = null;
  try {
    for (;;) {
      const j = await rest(`/api/blocks/${rec.n}/transactions?limit=100${after != null ? `&after=${after}` : ""}`);
      for (const t of j.items) {
        const r = sent.get(t.hash);
        if (!r || r.finalAt) continue;
        r.finalAt = rec.finalAt; r.block = rec.n; r.success = t.success; r.gasUsed = t.gasUsed; finalCount++;
        r.class = classify({ success: t.success, expectRevert: r.expectRevert }); outcomes[r.class]++;
        ev({ e: "final", hash: t.hash, block: rec.n, index: t.index, success: t.success, class: r.class, gasUsed: t.gasUsed, methodId: t.methodId, finalAt: rec.finalAt, firstSeenAt: rec.firstSeenAt, sentAt: r.sentAt });
        if (r.class === "unexpectedRevert") reasonJobs.push(findReason(r).then((reason) => { ev({ e: "revertReason", hash: t.hash, kind: r.kind, sub: r.sub, reason }); log("UNEXPECTED revert", r.sub ?? r.kind, "->", reason); }));
        if (!t.success && r.undo) { try { r.undo(); } catch {} }
        if (r.after) { try { r.after({ success: t.success, tokenId: t.tokenMoves?.first?.token === A.pass.toLowerCase() && t.tokenMoves.first.tokenId != null ? BigInt(t.tokenMoves.first.tokenId) : null }); } catch {} }
      }
      if (j.next == null) break;
      after = j.next;
    }
    rec.txsDone = true;
  } catch (e) { log("readTxs", rec.n, String(e.message).slice(0, 80)); }
}

// receipts through the RPC, with what is left of the call budget (everything while the rate is low, a sample when it is high)
let curRate = 2;
const rc = { checked: 0, mismatched: 0 };
async function receipts() {
  while (running || sent.size > finalCount) {
    await sleep(2500);
    const reserve = curRate * 10 + 15;
    const cand = [...sent.values()].filter((r) => r.finalAt && !r.checked).slice(0, 20);
    if (!cand.length || left() < reserve + cand.length) continue;
    const res = await rpcBatch(cand.map((r) => ["eth_getTransactionReceipt", [r.hash]]));
    cand.forEach((r, i) => {
      r.checked = true; const x = res[i].result;
      if (!x) { rc.mismatched++; ev({ e: "receipt", hash: r.hash, ok: false, why: "no receipt" }); return; }
      const ok = Number(x.status) === (r.success ? 1 : 0) && Number(x.gasUsed) === r.gasUsed && Number(x.blockNumber) === r.block;
      rc.checked++; if (!ok) rc.mismatched++;
      ev({ e: "receipt", hash: r.hash, ok, status: Number(x.status), gasUsed: Number(x.gasUsed) });
    });
  }
}

// helpers that run next to the sends: RedStone prices, Merces proofs, gas price, a price-vault read, the per-minute RPC count
async function redstoneLoop() {
  while (running) {
    try { const p = await pricePayload(); payload = { hex: p.payload, at: Date.now() }; ev({ e: "redstone", ok: true, bytes: p.bytes, signers: p.signers }); }
    catch (e) { ev({ e: "redstone", ok: false, why: String(e.message).slice(0, 120) }); }
    await sleep(45_000);
  }
}
const cverShim = { compressProof: async (flat) => F.cver.decodeFunctionResult("compressProof", await rpc("eth_call", [{ to: state.contracts["Merces ClientVerifier"].address, data: F.cver.encodeFunctionData("compressProof", [flat]) }, "latest"]))[0] };
async function proofLoop() {
  const pks = await mpcPks();
  while (running) {
    if (proofs.length < 3) {
      try { const r = await proveTransfer(E("0.1") * BigInt(1 + rnd(5)), pks, cverShim); proofs.push(r.args); ev({ e: "proof", ms: r.proveMs }); }
      catch (e) { log("proof:", String(e.message).slice(0, 100)); await sleep(5000); }
    } else await sleep(1000);
  }
}
async function misc() {
  let n = 0;
  while (running) {
    await sleep(15_000); n++;
    if (n % 2 === 0) await refreshGasPrice();
    if (n % 4 === 0) ev({ e: "rpcMinute", used: used(), calls: rpcStats.calls, httpLimited: rpcStats.httpLimited, waitedMs: rpcStats.waitedMs, sent: counters.sent, rejected: counters.rejected, final: finalCount, outcomes: { ...outcomes }, queue: queue.length, inflight });
    if (n % 4 === 0) log(`sent ${counters.sent}  final ${finalCount}  ${tallyLine(outcomes)}  rejected ${counters.rejected}  rpc ${used()}/min  proofs ${proofs.length}  prices ${fresh() ? "fresh" : "none"}  blocks ${blocks.size}`);
  }
}
let vaultReads = 0;
async function vaultRead() {
  while (running) {
    await sleep(60_000 / M.perMinute.vaultRead * (0.5 + Math.random()));
    if (!fresh() || left() < 30) continue;
    try {
      const data = F.vault.encodeFunctionData("usdValueOfEth", [E("2")]) + payload.hex;
      const r = F.vault.decodeFunctionResult("usdValueOfEth", await rpc("eth_call", [{ to: A.vault, data }, "latest"]))[0];
      vaultReads++; ev({ e: "vaultRead", usd8: r.toString() });
    } catch (e) { ev({ e: "vaultRead", err: String(e.message).slice(0, 120) }); }
  }
}

// the mix
const queue = [];
let inflight = 0;
const weights = Object.entries(M.weights);
const totalW = weights.reduce((a, [, v]) => a + v, 0);
const weighted = () => { let r = Math.random() * totalW; for (const [k, v] of weights) { if ((r -= v) < 0) return k; } return weights[0][0]; };
const skipped = {};
const free = (list) => { for (let i = 0; i < 40; i++) { const w = pick(list); if (!busy.has(w.address)) return w; } return null; };
const walletFor = (kind) => {
  if (kind.startsWith("trex")) return free(holders);
  if (kind === "mercesTransfer") { const l = pool.filter((w) => deposited.has(w.address)); return l.length ? free(l) : null; }
  return free(pool);
};
function tryKind(kind) {
  for (let i = 0; i < 25; i++) {
    const w = walletFor(kind); if (!w) return null;
    const specs = plan(kind, w);
    if (specs) { busy.add(w.address); specs.forEach((s, j) => queue.push({ w, spec: s, last: j === specs.length - 1 })); return true; }
    if (kind === "mercesTransfer" && !proofs.length) return null;
  }
  skipped[kind] = (skipped[kind] ?? 0) + 1;
  return null;
}
const periodic = ["trexRefused", "mercesDeposit", "mercesTransfer", "vaultRecord", "revert"];
for (const k of periodic) specials[k] = Date.now() + 20_000 + rnd(40_000);
function generate() {
  const now = Date.now();
  for (const k of periodic) {
    if (specials[k] <= now) {
      const ok = tryKind(k);
      specials[k] = now + (ok ? 60_000 / M.perMinute[k] * (0.6 + 0.8 * Math.random()) : 5_000);
      if (ok) return true;
    }
  }
  for (let i = 0; i < 8; i++) if (tryKind(weighted())) return true;
  return false;
}
async function dispatchOne(phase) {
  if (!queue.length && !generate()) return;
  const it = queue.shift();
  if (it.last) busy.delete(it.w.address);
  inflight++;
  send(it.w, it.spec, phase).finally(() => { inflight--; });
}

const phaseResults = [];
const best = () => { const ok = phaseResults.filter((p) => p.ok); return ok.length ? Math.max(...ok.map((p) => p.rate)) : 2; };
const bg = [watch(), receipts(), redstoneLoop(), proofLoop(), misc(), vaultRead()];
for (const ph of M.phases) {
  const rate = ph.rate === "best" ? best() : ph.rate;
  const start = Date.now(), end = start + ph.minutes * 60_000, interval = 1000 / rate;
  curRate = rate;
  ev({ e: "phase", name: ph.name === "best" ? `best (${rate} tx/s)` : ph.name, rate, start, end });
  log(`phase ${ph.name}: ${rate} tx/s for ${ph.minutes} min`);
  const sentBefore = counters.sent + counters.rejected;
  let next = start;
  while (Date.now() < end) {
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    if (inflight > 40) { await sleep(100); next = Math.max(next, Date.now()); continue; } // the RPC budget is the limit: do not pile sends up
    await dispatchOne(ph.name);
    next += interval;
    if (Date.now() - next > 2000) next = Date.now(); // far behind (a proof, a stall): do not burst to catch up
  }
  const achieved = (counters.sent + counters.rejected - sentBefore) / ph.minutes / 60;
  phaseResults.push({ name: ph.name, rate, achieved, end, ok: null });
  ev({ e: "phaseEnd", name: ph.name, rate, achieved });
  // decide whether the phase that just ended kept every transaction final (the transactions sent in its last minute are left out: they need time)
  const prev = phaseResults[phaseResults.length - 1];
  const mine = [...sent.values()].filter((r) => r.phase === ph.name && r.sentAt < prev.end - 60_000);
  prev.ok = mine.every((r) => r.finalAt) && prev.achieved >= 0.9 * rate;
  ev({ e: "phaseOk", name: ph.name, ok: prev.ok, accepted: mine.length, notFinal: mine.filter((r) => !r.finalAt).length });
  log(`phase ${ph.name} done: achieved ${achieved.toFixed(2)} tx/s, every transaction final: ${prev.ok}`);
}
// drain: stop sending, wait for every accepted transaction to be final
running = false;
log("sending stopped; waiting for the last transactions to be final");
const drainEnd = Date.now() + M.drainMinutes * 60_000;
while (Date.now() < drainEnd && sent.size > finalCount) await sleep(5000);
await Promise.race([Promise.all(bg), sleep(15_000)]);
await Promise.race([Promise.all(reasonJobs), sleep(30_000)]); // the replays of unexpected reverts
const notFinal = [...sent.values()].filter((r) => !r.finalAt).map((r) => ({ hash: r.hash, kind: r.kind, sentAt: r.sentAt }));
const summary = { name: NAME, startedAt: t0, endedAt: Date.now(), counters, finalCount, notFinal, rpc: { ...rpcStats, budget: M.rpcCallsPerMinute }, receipts: rc, vaultReads, skipped, phases: phaseResults.map(({ name, rate, achieved, ok }) => ({ name, rate, achieved, ok })), wallets: pool.length, outcomes, pass: passes(outcomes) };
ev({ e: "end", ...summary });
writeFileSync(`${DIR}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
log(`done: ${tallyLine(outcomes)}; ${passes(outcomes) ? "PASS" : "FAIL"} on unexpected reverts. sent ${counters.sent}, final ${finalCount}, not final ${notFinal.length}, rejected ${counters.rejected}`);
process.exit(0);
