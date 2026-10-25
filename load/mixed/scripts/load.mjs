// The mixed load driver.
//   node scripts/load.mjs seed                 makes the test wallets (keys/wallets.json, 0600) and gives them their starting tROME, tUSD and tETH through the Seeder contract
//   node scripts/load.mjs calibrate            one action of every kind, sent and read back one at a time: the gas each uses and whether the deliberate reverts revert
//   node scripts/load.mjs run [name]           the timed run: the mix in config.json, phase by phase; every transaction is followed until it is in a final block
//   node scripts/load.mjs check-reverts        sends nothing: eth_call of each deliberate-revert case, each must revert (the swap case for its own reason, with a control that goes through)
//   node scripts/load.mjs report <name>        the numbers of a finished run (report.json and report.md in its folder)
// Everything goes to the public RPC like any user would send it, under the RPC's own limit (see load-rpc.mjs). Transactions are signed here; nonces are counted here.
import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { ethers } from "ethers";
import { cfg, state, save, log, provider, distributor, wallets, done, step, deploy, att, artifact, RUN } from "./lib.mjs";
import { fees } from "./fee.mjs";
import { Ledger, QuoteBook, RefillBudget, WrappedBooks, emptyRefillStats, refillCycle, refillGate, refillLine, planTopUp, refillEvents, pickWallet, readAllOnce, wtAllowed, wtDelta } from "./refill.mjs";
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
function wallets_addr(n) { return W[n].address; }
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

// slippage: a swap's minimum output comes from a fresh reading of the pool's reserves, less a tolerance (config mix.slippage). With no fresh reading the minimum is 0.
const SL = M.slippage, RF = M.refill;
const quotes = new QuoteBook(SL.quoteMaxAgeSeconds * 1000);
const minOut = (tokenIn, tokenOut, amountIn) => quotes.minOut(tokenIn, tokenOut, amountIn, SL.tolerancePercent);
// what each wallet is thought to hold (see refill.mjs); the holders carry gas only here, their T-REX balance is kept below
const ledger = new Ledger({ trome: E(M.seed.tromeEach), tUSD: U(M.seed.tUsdEach), tETH: E(M.seed.tEthEach) });
for (const h of holders) ledger.set(h.address, { trome: E(cfg.deploy.holderGasTrome) });
const refillStats = emptyRefillStats();
const trexBal = new Map(HOLDERS.map((n) => [wallets_addr(n), U(cfg.deploy.trex.mintPerHolder)]));

// wallets' bookkeeping, kept here (no reads from the chain): nonces, approvals, what a wallet holds of what it made
const nonces = new Map(), approved = new Set(), lp = new Map(), nfts = new Map(), items = new Map(), deposited = new Set(), busy = new Set();
// wrapped tROME: the books lean low (see refill.mjs), are corrected from the real balance whenever the refill reads a wallet, and a kind is allowed only by them
const wbooks = new WrappedBooks();
const wrp = (w) => wbooks.get(w.address);
const itemsOf = (w) => [...items.entries()].filter(([k, v]) => k.startsWith(w.address) && v > 0n).map(([k, v]) => [Number(k.split(":")[1]), v]);
/** Bookkeeping is booked when an action is planned, so two actions of one wallet do not use the same funds; `undo` takes it back when the send is refused or the transaction fails. */
const undoWith = (s, f) => { const prev = s.undo; s.undo = () => { prev?.(); f(); }; };
const doneWith = (s, f) => { const prev = s.done; s.done = () => { prev?.(); f(); }; };
const book = (s, w, v) => { wbooks.book(w.address, v); undoWith(s, () => wbooks.settle(w.address, v, false)); doneWith(s, () => wbooks.settle(w.address, v, true)); };
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
      const t = pick(["tUSD", "tUSD", "tETH"].filter((k) => ledger.canSpend(w.address, [k])));
      if (!t) return null; // the wallet is known low in both tokens: another wallet or kind
      const amt = t === "tUSD" ? U(1 + rnd(10)) : E("0.001") * BigInt(1 + rnd(9));
      tx({ to: A[t], data: F.tok.encodeFunctionData("transfer", [other(w).address, amt]), gas: G.erc20Transfer, spend: { [t]: amt } }); break;
    }
    case "erc20Approve": // a plain approval of a friend, a finite amount
      tx({ to: A[pick(["tUSD", "tETH"])], data: F.tok.encodeFunctionData("approve", [other(w).address, U(100 * (1 + rnd(9)))]), gas: G.erc20Approve }); break;
    case "wrap":
      if (!wtAllowed("wrap", wrp(w))) return null;
      tx({ to: A.wt, data: F.wt.encodeFunctionData("deposit"), value: E("0.5"), gas: G.wrap }); book(out.at(-1), w, wtDelta("wrap")); break;
    case "unwrap":
      if (!wtAllowed("unwrap", wrp(w))) return null;
      tx({ to: A.wt, data: F.wt.encodeFunctionData("withdraw", [E("0.2")]), gas: G.unwrap }); book(out.at(-1), w, wtDelta("unwrap")); break;
    case "swapUsdToTrome": {
      approval(w, A.tUSD, A.router, out);
      const mo = minOut(A.tUSD, A.wt, U(20)); // what the swap gets at least: the wallet is booked only that much WtROME, the rest shows when its real balance is read
      tx({ to: A.router, data: F.router.encodeFunctionData("swapExactTokensForTokens", [U(20), mo, [A.tUSD, A.wt], w.address, deadline()]), gas: G.swap, spend: { tUSD: U(20) } }); book(out.at(-1), w, wtDelta("swapUsdToTrome", mo)); break;
    }
    case "swapTromeToUsd":
      if (!wtAllowed("swapTromeToUsd", wrp(w))) return null;
      approval(w, A.wt, A.router, out);
      tx({ to: A.router, data: F.router.encodeFunctionData("swapExactTokensForTokens", [E("0.2"), minOut(A.wt, A.tUSD, E("0.2")), [A.wt, A.tUSD], w.address, deadline()]), gas: G.swap, spend: {} }); book(out.at(-1), w, wtDelta("swapTromeToUsd")); break;
    case "swapEthToUsd":
      approval(w, A.tETH, A.router, out);
      tx({ to: A.router, data: F.router.encodeFunctionData("swapExactTokensForTokens", [E("0.01"), minOut(A.tETH, A.tUSD, E("0.01")), [A.tETH, A.tUSD], w.address, deadline()]), gas: G.swap, spend: { tETH: E("0.01") } }); break;
    case "swapUsdToEth":
      approval(w, A.tUSD, A.router, out);
      tx({ to: A.router, data: F.router.encodeFunctionData("swapExactTokensForTokens", [U(30), minOut(A.tUSD, A.tETH, U(30)), [A.tUSD, A.tETH], w.address, deadline()]), gas: G.swap, spend: { tUSD: U(30) } }); break;
    case "addLiquidity": {
      if (Math.random() < 0.5 && wtAllowed("addLiquidity", wrp(w))) {
        approval(w, A.tUSD, A.router, out); approval(w, A.wt, A.router, out);
        tx({ to: A.router, data: F.router.encodeFunctionData("addLiquidity", [A.tUSD, A.wt, U(5), E("0.5"), 0, 0, w.address, deadline()]), gas: G.addLiquidity, spend: { tUSD: U(5) } });
        book(out.at(-1), w, wtDelta("addLiquidity")); bookLp(out.at(-1), w, A.pairUW, 1);
      } else {
        approval(w, A.tETH, A.router, out); approval(w, A.tUSD, A.router, out);
        tx({ to: A.router, data: F.router.encodeFunctionData("addLiquidity", [A.tETH, A.tUSD, E("0.01"), U(35), 0, 0, w.address, deadline()]), gas: G.addLiquidity, spend: { tETH: E("0.01"), tUSD: U(35) } });
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
      if (p === A.pairUW) book(out.at(-1), w, wtDelta("removeLiquidity")); // a removal returns a negligible amount (1e9 LP wei): nothing is booked
      break;
    }
    case "erc721Mint":
      tx({ to: A.pass, data: F.pass.encodeFunctionData("mint"), gas: G.erc721Mint, after: (it) => { if (it.tokenId != null) nfts.set(w.address, [...(nfts.get(w.address) ?? []), it.tokenId]); } }); break;
    case "erc721Transfer": {
      const mine = nfts.get(w.address) ?? [];
      if (!mine.length) return null;
      const id = mine.shift(); const to = other(w);
      tx({ to: A.pass, data: F.pass.encodeFunctionData("safeTransferFrom(address,address,uint256)", [w.address, to.address, id]), gas: G.erc721Transfer,
        undo: () => nfts.set(w.address, [id, ...(nfts.get(w.address) ?? [])]),
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
      tx({ to: A.items, data: F.items.encodeFunctionData("safeTransferFrom", [w.address, to.address, id, amt, "0x"]), gas: G.erc1155Transfer, undo: () => addItem(w, id, amt), after: (it) => { if (it.success) addItem(to, id, amt); } }); break;
    }
    case "erc1155BatchTransfer": {
      const mine = itemsOf(w); if (mine.length < 2) return null;
      const two = mine.slice(0, 2); const to = other(w);
      for (const [id, have] of two) items.set(`${w.address}:${id}`, have - 1n);
      tx({ to: A.items, data: F.items.encodeFunctionData("safeBatchTransferFrom", [w.address, to.address, two.map((x) => x[0]), two.map(() => 1n), "0x"]), gas: G.erc1155BatchTransfer,
        undo: () => { for (const [id] of two) addItem(w, id, 1n); },
        after: (it) => { if (it.success) for (const [id] of two) addItem(to, id, 1n); } }); break;
    }
    case "trexTransfer": { // only from a holder that holds enough; the books follow the move and take it back if it fails
      const amt = U(1 + rnd(5)), have = trexBal.get(w.address) ?? ZERO;
      if (have < amt) return null;
      const to = other(w, holders);
      trexBal.set(w.address, have - amt);
      tx({ to: A.trex, data: F.trex.encodeFunctionData("transfer", [to.address, amt]), gas: G.trexTransfer,
        undo: () => trexBal.set(w.address, (trexBal.get(w.address) ?? ZERO) + amt),
        after: (it) => { if (it.success) trexBal.set(to.address, (trexBal.get(to.address) ?? ZERO) + amt); } }); break;
    }
    case "trexRefused": // (a holder with no T-REX left would revert for another reason, so it does not send this) to the address that has no identity in the registry: the token refuses it, the transaction reverts on purpose
      if ((trexBal.get(w.address) ?? ZERO) < U(1)) return null;
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
// the reason of an unexpected revert: the same call replayed with eth_call from the same wallet at the block before the one it was in (so a wallet that a
// top-up has since refilled still shows its own reason), a few per kind (the RPC budget is shared). Only an unexpected revert keeps its call (see readTxs).
const findReason = reasonFinder(async (r) => {
  const call = { from: r.from, to: r.call.to, data: r.call.data, value: r.call.value ? ethers.toBeHex(r.call.value) : undefined, gas: ethers.toBeHex(r.gas) };
  const at = async (block) => { try { await rpc("eth_call", [call, block]); return null; } catch (e) { return e; } };
  const parent = r.block > 0 ? "0x" + (r.block - 1).toString(16) : "latest";
  let e = await at(parent);
  if (e === null) return "the replay at the block before went through (the revert came from state of its own block)";
  if (!(typeof e.data === "string" && e.data.length >= 10) && !/revert/i.test(String(e.message))) { // the node did not serve that block's state: fall back to the latest
    const e2 = await at("latest");
    return e2 === null ? "the replay went through at the latest block (state has changed since)" : reasonFromError(e2);
  }
  return reasonFromError(e);
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
  const rec = { hash, kind: spec.kind, sub: spec.sub, from: w.address, nonce, phase, sentAt: Date.now(), expectRevert: !!spec.expectRevert, after: spec.after, undo: spec.undo, done: spec.done, gas: spec.gas, call: { to: spec.to, data: spec.data, value: spec.value } };
  // one wallet's transactions go to the RPC in nonce order: two sent at once could pass each other while they wait for the rate budget, and the later one is refused (nonce gap)
  const go = async () => {
    try {
      await rpc("eth_sendRawTransaction", [raw]);
      rec.acceptedAt = Date.now(); sent.set(hash, rec); counters.sent++;
      ledger.spend(w.address, { trome: (spec.value ?? ZERO) + BigInt(spec.gas) * gasPrice, ...spec.spend });
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
        if (r.class === "unexpectedRevert") reasonJobs.push(findReason(r).then((reason) => { ev({ e: "revertReason", hash: t.hash, kind: r.kind, sub: r.sub, reason }); log("UNEXPECTED revert", r.sub ?? r.kind, "->", reason); }).finally(() => { r.call = null; }));
        else r.call = null; // the call is kept only to replay an unexpected revert: a long soak does not hold every transaction's calldata
        if (!t.success && r.undo) { try { r.undo(); } catch {} }
        if (t.success && r.done) { try { r.done(); } catch {} }
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
    if (n % 4 === 0) log(`sent ${counters.sent}  final ${finalCount}  ${tallyLine(outcomes)}  rejected ${counters.rejected}  ${refillLine(refillStats)}  rpc ${used()}/min  proofs ${proofs.length}  prices ${fresh() ? "fresh" : "none"}  blocks ${blocks.size}`);
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
// a wallet sends only once its real balance has been read, and not while it is known low in what the action spends (until a top-up has gone out)
const free = (list, kind) => pickWallet({ list, kind, busy, ledger, pick });
const walletFor = (kind) => {
  if (kind.startsWith("trex")) return free(holders, kind);
  if (kind === "mercesTransfer") { const l = pool.filter((w) => deposited.has(w.address)); return l.length ? free(l, kind) : null; }
  return free(pool, kind);
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

// ---------------------------------------------------------------- refill: the wallets keep what they spend, and a swap's price is read fresh
// The distributor (the funded deploy key) may be in use for other load while a soak runs, so the top-ups are not sent from it: they come from the refill key, made once
// (keys/refill.key, 0600, never printed) and funded by the distributor in bundles (a few transactions each time, see planTopUp in refill.mjs). Nothing else may send from it.
const D = RF.enabled ? distributor() : null;
function refillKey() {
  const p = `${RUN}/keys/refill.key`;
  if (!existsSync(p)) { writeFileSync(p, ethers.Wallet.createRandom().privateKey + "\n", { mode: 0o600 }); chmodSync(p, 0o600); }
  const k = readFileSync(p, "utf8").trim();
  return new ethers.Wallet(k.startsWith("0x") ? k : "0x" + k, provider);
}
const R = RF.enabled ? refillKey() : null;
const seederAddr = state.contracts.Seeder?.address;
const F2 = { seeder: I("Seeder.sol", "Seeder"), pair: I("UniswapV2Pair.sol", "UniswapV2Pair") };
/** One transaction from the distributor or the refill key, waited for until it has a receipt. The nonce is read fresh every time (the key may have other senders), and a refused
 *  nonce is read again, twice. Throws when it is refused, reverts or has no receipt in 75 s. */
async function wsend(w, spec, who) {
  let hash;
  for (let attempt = 0; ; attempt++) {
    const nonce = Number(await rpc("eth_getTransactionCount", [w.address, "pending"]));
    const t = signed(w, spec, nonce); hash = t.hash;
    try { await rpc("eth_sendRawTransaction", [t.raw]); break; }
    catch (e) { if (attempt < 2 && /nonce|underpriced|already known/i.test(String(e?.message))) { await sleep(1000); continue; } throw e; }
  }
  for (let i = 0; i < 25; i++) {
    await sleep(3000);
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) { if (Number(r.status) !== 1) throw new Error(`the ${who}'s transaction reverted`); return r; }
  }
  throw new Error(`no receipt for the ${who}'s transaction in 75 s`);
}
const bal = (data, to) => ["eth_call", [{ to, data }, "latest"]];
/** Real balances of tROME and, with `tokens`, of tUSD, tETH and WtROME (wt). A wallet whose reads failed is left out. */
const readBalances = async (addrs, tokens = true) => {
  const calls = addrs.flatMap((a) => tokens
    ? [["eth_getBalance", [a, "latest"]], ...[A.tUSD, A.tETH, A.wt].map((t) => bal(F.tok.encodeFunctionData("balanceOf", [a]), t))]
    : [["eth_getBalance", [a, "latest"]]]);
  const per = tokens ? 4 : 1, out = new Map();
  const res = [];
  for (let i = 0; i < calls.length; i += 20) res.push(...await rpcBatch(calls.slice(i, i + 20)));
  addrs.forEach((a, i) => {
    const r = res.slice(i * per, i * per + per);
    if (r.some((x) => !x.result)) return;
    out.set(a, tokens ? { trome: BigInt(r[0].result), tUSD: BigInt(r[1].result), tETH: BigInt(r[2].result), wt: BigInt(r[3].result) } : { trome: BigInt(r[0].result) });
  });
  return out;
};
let approvedSeeder = false;
/** One Seeder call from the refill key: each wallet gets only the kinds it was low in (the others are sent as 0). The refill key is brought up to a bundle first when it is short. */
async function topUp(g, addrs, kinds) {
  const n = BigInt(addrs.length), amt = (k) => (kinds.includes(k) ? g.topUp[k] ?? ZERO : ZERO);
  const each = { trome: amt("trome"), tUSD: amt("tUSD"), tETH: amt("tETH") };
  const m = await readBalances([R.address, D.address]);
  if (!m.get(R.address) || !m.get(D.address)) throw new Error("could not read the refill key's or the distributor's balances");
  const { fund, short } = planTopUp({ each, full: g.topUp, n, mine: m.get(R.address), distributorTrome: m.get(D.address).trome, fundTopUps: RF.fundTopUps, minTrome: E(RF.distributorMinTrome), gasMargin: E(RF.refillGasMarginTrome) });
  if (short) { refillStats.distributorShort++; log(`refill: the distributor is short of ${cfg.coin} (${ethers.formatEther(m.get(D.address).trome)}); ${g.name} wallets wait`); return false; }
  for (const [key, addr] of [["tUSD", A.tUSD], ["tETH", A.tETH]]) { // the distributor owns the test tokens: it mints straight to the refill key
    if (!fund[key]) continue;
    const rc = await wsend(D, { to: addr, data: F.tok.encodeFunctionData("mint", [R.address, fund[key]]), gas: 300_000 }, "distributor");
    refillStats.minted++; log(`refill: minted ${key} for the refill key`); ev(refillEvents.mint(key, fund[key], rc));
  }
  if (fund.trome) { const rc = await wsend(D, { to: R.address, data: "0x", value: fund.trome, gas: 100_000 }, "distributor"); refillStats.funded++; refillStats.tromeTaken += fund.trome; log(`refill: sent ${ethers.formatEther(fund.trome)} ${cfg.coin} to the refill key`); ev(refillEvents.fund(fund.trome, rc)); }
  if (!approvedSeeder && (each.tUSD || each.tETH)) {
    for (const addr of [A.tUSD, A.tETH]) await wsend(R, { to: addr, data: F.tok.encodeFunctionData("approve", [seederAddr, ethers.MaxUint256]), gas: 100_000 }, "refill key");
    approvedSeeder = true;
  }
  const r = await wsend(R, { to: seederAddr, data: F2.seeder.encodeFunctionData("seed", [addrs, each.trome, A.tUSD, each.tUSD, A.tETH, each.tETH]), value: each.trome * n, gas: RF.gasLimit }, "refill key");
  ev(refillEvents.topUp({ group: g.name, wallets: addrs.length, kinds, each }, r));
  log(`refill: ${addrs.length} ${g.name} wallets topped up in ${kinds.join(", ")} (each ${[each.trome && `${ethers.formatEther(each.trome)} ${cfg.coin}`, each.tUSD && `${ethers.formatUnits(each.tUSD, 6)} tUSD`, each.tETH && `${ethers.formatEther(each.tETH)} tETH`].filter(Boolean).join(", ")})`);
  return true;
}
const groups = [
  { name: "pool", addrs: pool.map((w) => w.address), low: { trome: E(RF.lowTrome), tUSD: U(RF.lowTusd), tETH: E(RF.lowTeth) }, topUp: { trome: E(M.seed.tromeEach), tUSD: U(M.seed.tUsdEach), tETH: E(M.seed.tEthEach) }, rereadMs: RF.rereadMinutes * 60_000 },
  { name: "holders", addrs: holders.map((w) => w.address), low: { trome: E(RF.holderLowTrome) }, topUp: { trome: E(RF.holderTopUpTrome) } },
];
const holderAddrs = new Set(holders.map((h) => h.address));
const refillBudget = new RefillBudget({ perMinute: RF.maxWalletsPerMinute, perRun: RF.maxWalletsPerRun });
const refillOn = RF.enabled && !!seederAddr;
if (refillOn) ledger.markUnread(groups.flatMap((g) => g.addrs)); // with the refill off nothing reads them: the books stay as seeded
const io = {
  readBalances: async (as) => {
    const holder = as.every((a) => holderAddrs.has(a));
    const m = await readBalances(as, !holder);
    for (const [a, r] of m) if (r.wt != null) wbooks.correct(a, r.wt); // the books of wrapped tROME follow the real balance
    return new Map([...m].map(([a, { wt, ...rest }]) => [a, rest]));
  },
  topUp,
};
async function refillLoop() {
  if (!RF.enabled || !seederAddr) { log(`refill is off${RF.enabled ? " (no Seeder in the state: run seed first)" : ""}`); return; }
  log(`refill: top-ups are sent from the refill key ${R.address} (fund it only through the distributor; nothing else may send from it)`);
  let lastCheck = Date.now();
  while (running) {
    const unread = ledger.unreadIn(groups.flatMap((g) => g.addrs)).length;
    // the sends come first, but the check is never starved: after twice its period it runs anyway and waits for the RPC budget in the queue
    const gate = refillGate({ left: left(), need: RF.readWalletsPerCheck * 4 + curRate * 10 + 15, sinceLastCheckMs: Date.now() - lastCheck, checkMs: RF.checkSeconds * 1000 });
    if (gate === "wait") { await sleep(2000); continue; }
    if (gate === "forced") refillStats.budgetWaits++;
    try { await refillCycle({ ledger, groups, budget: refillBudget, io, readPerCheck: RF.readWalletsPerCheck, stats: refillStats, log }); } catch (e) { log("refill", String(e.message).slice(0, 100)); }
    lastCheck = Date.now();
    await sleep(unread ? 1000 : RF.checkSeconds * 1000);
  }
}
const poolPairs = [[A.pairUW, A.tUSD, A.wt], [A.pairET, A.tETH, A.tUSD]];
async function readQuotes() {
  const res = await rpcBatch(poolPairs.map(([p]) => ["eth_call", [{ to: p, data: F2.pair.encodeFunctionData("getReserves") }, "latest"]]));
  res.forEach((r, i) => {
    if (!r.result) return;
    const [r0, r1] = F2.pair.decodeFunctionResult("getReserves", r.result);
    const [, a, b] = poolPairs[i]; const aIs0 = a.toLowerCase() < b.toLowerCase();
    quotes.set(a, aIs0 ? r0 : r1, b, aIs0 ? r1 : r0);
  });
}
async function quoteLoop() {
  while (running) { try { await readQuotes(); } catch (e) { log("quotes", String(e.message).slice(0, 80)); } await sleep(SL.quoteRefreshSeconds * 1000); }
}
try { await readQuotes(); } catch {}
try { // the holders' real T-REX balances (the books start from what the deploy minted)
  const calls = holders.map((h) => bal(F.trex.encodeFunctionData("balanceOf", [h.address]), A.trex));
  (await rpcBatch(calls)).forEach((r, i) => { if (r.result) trexBal.set(holders[i].address, BigInt(r.result)); });
} catch {}

const phaseResults = [];
const best = () => { const ok = phaseResults.filter((p) => p.ok); return ok.length ? Math.max(...ok.map((p) => p.rate)) : 2; };
// every wallet is read once (and topped up where it is low) before the first send: what a wallet holds at the start of a run is not known until it is read
if (refillOn) {
  log(`reading every wallet once before sending (${ledger.unreadIn(groups.flatMap((g) => g.addrs)).length} wallets)`);
  const still = await readAllOnce({ ledger, groups, budget: refillBudget, io, readPerCheck: RF.readWalletsPerCheck * 3, stats: refillStats, log });
  if (still.length) { log(`stopping: ${still.length} wallets could not be read, so the run does not send from them (the RPC did not answer)`); process.exit(1); }
  log(`all wallets read; ${refillStats.toppedUp} topped up before the start`);
}
const bg = [watch(), receipts(), redstoneLoop(), proofLoop(), misc(), vaultRead(), refillLoop(), quoteLoop()];
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
const summary = { name: NAME, startedAt: t0, endedAt: Date.now(), counters, finalCount, notFinal, rpc: { ...rpcStats, budget: M.rpcCallsPerMinute }, receipts: rc, vaultReads, skipped, phases: phaseResults.map(({ name, rate, achieved, ok }) => ({ name, rate, achieved, ok })), wallets: pool.length, outcomes, pass: passes(outcomes, notFinal.length), refills: { ...refillStats, tromeTaken: refillStats.tromeTaken.toString(), quotes: quotes.stats } };
ev({ e: "end", ...summary });
writeFileSync(`${DIR}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
log(`done: ${tallyLine(outcomes)}; ${passes(outcomes, notFinal.length) ? "PASS" : "FAIL"} (unexpected reverts, deliberate reverts that went through, lost transactions). sent ${counters.sent}, final ${finalCount}, not final ${notFinal.length}, rejected ${counters.rejected}`);
process.exit(0);
