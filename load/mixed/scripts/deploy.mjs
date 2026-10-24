// Deploys the mixed load's contracts to the chain in config.json and writes addresses.json into the run folder. Run it again and it skips what exists.
import { ethers } from "ethers";
import { cfg, provider, state, save, log, distributor, wallets, artifact, done, step, deploy, record, att } from "./lib.mjs";

const d = distributor();
const D = d.address;
const E = ethers.parseEther;
const MAX = ethers.MaxUint256;
const deadline = () => Math.floor(Date.now() / 1000) + 3600;
const net = await provider.getNetwork();
if (Number(net.chainId) !== cfg.chainId) throw new Error(`the RPC is chain ${net.chainId}, config.json says ${cfg.chainId}`);
state.deployer = D; save();
log("deployer", D, "balance", ethers.formatEther(await provider.getBalance(D)), cfg.coin);

// ---- the plain tokens ---------------------------------------------------------------------------------------------------------------------------
const tUSD = await deploy(d, "tUSD", ["TestToken.sol", "TestToken"], ["Test USD", "tUSD", 6]);
const tETH = await deploy(d, "tETH", ["TestToken.sol", "TestToken"], ["Test Ether", "tETH", 18]);
const wtrome = await deploy(d, "WtROME", ["WtROME.sol", "WtROME"]);
const pass = await deploy(d, "OstiaPass", ["OstiaPass.sol", "OstiaPass"], [cfg.deploy.pass.cap]);
const items = await deploy(d, "OstiaItems", ["OstiaItems.sol", "OstiaItems"]);
await step("mint-tUSD", () => done("mint tUSD", tUSD.mint(D, ethers.parseUnits("2000000", 6))));
await step("mint-tETH", () => done("mint tETH", tETH.mint(D, E("2000"))));
await step("mint-pass-1", () => done("mint OPASS #1", pass.mint()));
await step("mint-items-batch", () => done("mint OITEM batch", items.mintBatch([1, 2, 3, 4, 5], [100, 100, 100, 100, 100])));

// ---- Uniswap V2 ---------------------------------------------------------------------------------------------------------------------------------
const factory = await deploy(d, "UniswapV2Factory", ["UniswapV2Factory.sol", "UniswapV2Factory"], [D]);
const router = await deploy(d, "UniswapV2Router02", ["UniswapV2Router02.sol", "UniswapV2Router02"], [await factory.getAddress(), await wtrome.getAddress()]);
const routerA = await router.getAddress();
for (const [n, t] of [["tUSD", tUSD], ["tETH", tETH], ["WtROME", wtrome]]) {
  await step(`approve-router-${n}`, () => done(`approve router for ${n}`, t.approve(routerA, MAX)));
}
const u = cfg.deploy.uniswap;
await step("wrap-trome", () => done("wrap tROME", wtrome.deposit({ value: E(u.wrapTrome) })));
async function pool(label, ta, tb, [na, nb], [aa, ab]) {
  const key = `liquidity-${label}`;
  await step(key, () => done(`add liquidity ${label}`, router.addLiquidity(ta, tb, aa, ab, 0, 0, D, deadline())));
  const pair = await factory.getPair(ta, tb);
  const factoryAbi = artifact("UniswapV2Factory.sol", "UniswapV2Factory").abi;
  record(`UniswapV2Pair ${label}`, pair, "UniswapV2Pair.sol:UniswapV2Pair", state.steps[key].tx);
  return pair;
}
const A = async (c) => c.getAddress();
await pool("tUSD/WtROME", await A(tUSD), await A(wtrome), ["tUSD", "WtROME"], [ethers.parseUnits(u.poolTusdWtrome.tUSD, 6), E(u.poolTusdWtrome.WtROME)]);
await pool("tETH/tUSD", await A(tETH), await A(tUSD), ["tETH", "tUSD"], [E(u.poolTethTusd.tETH), ethers.parseUnits(u.poolTethTusd.tUSD, 6)]);

// ---- ERC-3643 (T-REX) ---------------------------------------------------------------------------------------------------------------------------
const T = cfg.deploy.trex;
const W = wallets(Array.from({ length: T.verifiedHolders }, (_, i) => `holder${i + 1}`).concat(["unverified"]));
const idImpl = await deploy(d, "ONCHAINID Identity (library)", ["Identity.sol", "Identity"], [D, true]);
const idIA = await deploy(d, "ONCHAINID ImplementationAuthority", ["ImplementationAuthority.sol", "ImplementationAuthority"], [await A(idImpl)]);
const idFactory = await deploy(d, "ONCHAINID IdFactory", ["IdFactory.sol", "IdFactory"], [await A(idIA)]);
const impl = {};
for (const [k, f, c] of [["token", "Token.sol", "Token"], ["ctr", "ClaimTopicsRegistry.sol", "ClaimTopicsRegistry"], ["ir", "IdentityRegistry.sol", "IdentityRegistry"],
  ["irs", "IdentityRegistryStorage.sol", "IdentityRegistryStorage"], ["tir", "TrustedIssuersRegistry.sol", "TrustedIssuersRegistry"], ["mc", "ModularCompliance.sol", "ModularCompliance"]]) {
  impl[k] = await A(await deploy(d, `T-REX ${c} (implementation)`, [f, c]));
}
const trexIA = await deploy(d, "T-REX TREXImplementationAuthority", ["TREXImplementationAuthority.sol", "TREXImplementationAuthority"], [true, ethers.ZeroAddress, ethers.ZeroAddress]);
await step("trex-version", () => done("add T-REX version 4.0.0", trexIA.addAndUseTREXVersion({ major: 4, minor: 0, patch: 0 },
  { tokenImplementation: impl.token, ctrImplementation: impl.ctr, irImplementation: impl.ir, irsImplementation: impl.irs, tirImplementation: impl.tir, mcImplementation: impl.mc })));
const trexFactory = await deploy(d, "T-REX TREXFactory", ["TREXFactory.sol", "TREXFactory"], [await A(trexIA), await A(idFactory)]);
await step("trex-ia-factory", () => done("set the factory on the authority", trexIA.setTREXFactory(await A(trexFactory))));
await step("idfactory-token-factory", () => done("let the T-REX factory create token identities", idFactory.addTokenFactory(await A(trexFactory))));
const issuer = await deploy(d, "ONCHAINID ClaimIssuer", ["ClaimIssuer.sol", "ClaimIssuer"], [D]);
const abi = ethers.AbiCoder.defaultAbiCoder();
const keyOf = (addr) => ethers.keccak256(abi.encode(["address"], [addr]));
await step("issuer-claim-key", () => done("give the issuer a claim-signing key", issuer.addKey(keyOf(D), 3, 1)));

const salt = "ostia-ogb";
await step("trex-suite", () => done("deploy the T-REX suite (token, registries, compliance, identity)", trexFactory.deployTREXSuite(salt,
  { owner: D, name: T.name, symbol: T.symbol, decimals: T.decimals, irs: ethers.ZeroAddress, ONCHAINID: ethers.ZeroAddress, irAgents: [D], tokenAgents: [D], complianceModules: [], complianceSettings: [] },
  { claimTopics: [T.claimTopic], issuers: [await A(issuer)], issuerClaims: [[T.claimTopic]] }, { gasLimit: 16_000_000 })));
const tokenAddr = await trexFactory.getToken(salt);
const token = att(tokenAddr, "Token.sol", "Token", d);
const ir = att(await token.identityRegistry(), "IdentityRegistry.sol", "IdentityRegistry", d);
const proxies = {
  "T-REX Token (proxy)": [tokenAddr, "TokenProxy.sol:TokenProxy"],
  "T-REX IdentityRegistry (proxy)": [await token.identityRegistry(), "IdentityRegistryProxy.sol:IdentityRegistryProxy"],
  "T-REX ModularCompliance (proxy)": [await token.compliance(), "ModularComplianceProxy.sol:ModularComplianceProxy"],
  "T-REX IdentityRegistryStorage (proxy)": [await ir.identityStorage(), "IdentityRegistryStorageProxy.sol:IdentityRegistryStorageProxy"],
  "T-REX TrustedIssuersRegistry (proxy)": [await ir.issuersRegistry(), "TrustedIssuersRegistryProxy.sol:TrustedIssuersRegistryProxy"],
  "T-REX ClaimTopicsRegistry (proxy)": [await ir.topicsRegistry(), "ClaimTopicsRegistryProxy.sol:ClaimTopicsRegistryProxy"],
};
for (const [n, [a, c]] of Object.entries(proxies)) record(n, a, c, state.steps["trex-suite"].tx);
record("T-REX token ONCHAINID (proxy)", await token.onchainID(), "IdentityProxy.sol:IdentityProxy", state.steps["trex-suite"].tx);

// the holders: an identity each (the deployer is its management key), a KYC claim signed by the issuer, a place in the registry
const idF = att(await A(idFactory), "IdFactory.sol", "IdFactory", d);
const idAbi = artifact("Identity.sol", "Identity").abi;
const holders = Object.keys(W).filter((n) => n.startsWith("holder"));
const identities = [];
for (const n of holders) {
  await step(`identity-${n}`, () => done(`create the identity of ${n}`, idF.createIdentityWithManagementKeys(W[n].address, `ogb-${n}`, [keyOf(D)])));
  const idAddr = await idF.getIdentity(W[n].address);
  identities.push(idAddr);
  record(`ONCHAINID identity ${n} (proxy)`, idAddr, "IdentityProxy.sol:IdentityProxy", state.steps[`identity-${n}`].tx);
  await step(`claim-${n}`, async () => {
    const data = ethers.hexlify(ethers.toUtf8Bytes("KYC passed"));
    const hash = ethers.keccak256(abi.encode(["address", "uint256", "bytes"], [idAddr, T.claimTopic, data]));
    const sig = await d.signMessage(ethers.getBytes(hash));
    return done(`add a KYC claim to ${n}`, new ethers.Contract(idAddr, idAbi, d).addClaim(T.claimTopic, 1, await A(issuer), sig, data, ""));
  });
}
await step("register-holders", () => done("register the holders in the identity registry", ir.batchRegisterIdentity(holders.map((n) => W[n].address), identities, holders.map(() => 840))));
if (await token.paused()) await done("unpause the token", token.unpause());
await step("mint-ogb", () => done("mint OGB to the holders", token.batchMint(holders.map((n) => W[n].address), holders.map(() => ethers.parseUnits(T.mintPerHolder, T.decimals)))));
for (const n of [...holders, "unverified"]) {
  await step(`gas-${n}`, () => done(`send ${cfg.deploy.holderGasTrome} ${cfg.coin} to ${n}`, d.sendTransaction({ to: W[n].address, value: E(cfg.deploy.holderGasTrome) })));
}

// ---- what we have ---------------------------------------------------------------------------------------------------------------------------------
state.wallets = Object.fromEntries(Object.entries(W).map(([n, w]) => [n, w.address]));
state.trex = { salt, token: tokenAddr, unverified: W.unverified.address };
save();
log("verified?", Object.fromEntries(await Promise.all(Object.keys(W).map(async (n) => [n, await ir.isVerified(W[n].address)]))));
log(`done: ${Object.keys(state.contracts).length} contracts, ${Object.keys(state.steps).length} steps, addresses in ${process.env.RUN_DIR || "./runs/local"}/addresses.json`);
