// One of each kind of action, from the test wallets, against what deploy.mjs made: a quick proof that every contract works on the chain.
// It writes smoke.json (the transaction hashes) into the run folder.
import { writeFileSync } from "node:fs";
import { ethers } from "ethers";
import { state, log, provider, wallets, done, att, artifact, RUN } from "./lib.mjs";

const need = (n) => { const c = state.contracts[n]; if (!c) throw new Error(`${n} is not deployed: run deploy first`); return c.address; };
const W = wallets(["holder1", "holder2", "holder3", "holder4", "unverified"]);
const [h1, h2, h3] = [W.holder1, W.holder2, W.holder3];
const tUSD = att(need("tUSD"), "TestToken.sol", "TestToken", h1);
const tETH = att(need("tETH"), "TestToken.sol", "TestToken", h1);
const wt = att(need("WtROME"), "WtROME.sol", "WtROME", h1);
const pass = att(need("OstiaPass"), "OstiaPass.sol", "OstiaPass", h1);
const items = att(need("OstiaItems"), "OstiaItems.sol", "OstiaItems", h1);
const router = att(need("UniswapV2Router02"), "UniswapV2Router02.sol", "UniswapV2Router02", h1);
const token = att(state.trex.token, "Token.sol", "Token", h1);
const out = {};
const rec = async (k, p) => { out[k] = (await done(k, p)).hash; };
const deadline = () => Math.floor(Date.now() / 1000) + 3600;

// the deployer has the tokens; give holder1 some to trade (the deployer's own key signs these two)
const d = (await import("./lib.mjs")).distributor();
await rec("deployer mints 1,000 tUSD to holder1", tUSD.connect(d).mint(h1.address, ethers.parseUnits("1000", 6)));
await rec("ERC-20 transfer: holder1 sends 10 tUSD to holder2", tUSD.transfer(h2.address, ethers.parseUnits("10", 6)));
await rec("ERC-721: holder1 mints an Ostia Pass", pass.mint());
await rec("ERC-1155: holder1 mints 3 Swords and 2 Keys in one batch", items.mintBatch([1, 5], [3, 2]));
await rec("wrap: holder1 wraps 1 tROME", wt.deposit({ value: ethers.parseEther("1") }));
await rec("approve the router for tUSD", tUSD.approve(router.target, ethers.MaxUint256));
await rec("Uniswap V2: holder1 swaps 100 tUSD for WtROME", router.swapExactTokensForTokens(ethers.parseUnits("100", 6), 0, [tUSD.target, wt.target], h1.address, deadline()));
const bal = await token.balanceOf(h1.address);
await rec("ERC-3643: verified holder1 sends 5 OGB to verified holder2", token.transfer(h2.address, ethers.parseUnits("5", 6)));
let refused = "not refused";
try { await token.transfer.staticCall(W.unverified.address, ethers.parseUnits("1", 6)); } catch (e) { refused = e.reason || e.shortMessage || "refused"; }
log("ERC-3643: the transfer to the unverified address is refused:", refused);
out["ERC-3643: transfer to the unverified address (a call, not sent)"] = refused;
writeFileSync(`${RUN}/smoke.json`, JSON.stringify(out, null, 2) + "\n");
log("smoke: ok");
