// Deploys PriceVault (the RedStone consumer) and records real prices in it a few times. Writes redstone.json into the run folder.
//   node scripts/redstone.mjs [recordings, default 3]
import { writeFileSync } from "node:fs";
import { ethers } from "ethers";
import { state, save, log, provider, distributor, deploy, att, RUN } from "./lib.mjs";
import { dataWithPrices } from "./oracle.mjs";

const n = Number(process.argv[2] ?? 3);
const d = distributor();
const vault = await deploy(d, "PriceVault", ["PriceVault.sol", "PriceVault"]);
const addr = await vault.getAddress();
const out = [];
for (let i = 0; i < n; i++) {
  const { data, signers, bytes } = await dataWithPrices(vault, "record");
  const tx = await d.sendTransaction({ to: addr, data });
  const rc = await tx.wait(1, 900_000);
  if (rc.status !== 1) throw new Error(`record failed ${tx.hash}`);
  const eth = await vault.latest(ethers.encodeBytes32String("ETH"));
  const btc = await vault.latest(ethers.encodeBytes32String("BTC"));
  const row = { tx: rc.hash, block: rc.blockNumber, gas: rc.gasUsed.toString(), payloadBytes: bytes, signers, ethUsd: Number(eth.price) / 1e8, btcUsd: Number(btc.price) / 1e8, signedAtMs: Number(eth.timestampMs) };
  log(`record #${i + 1}  ${rc.hash}  gas ${rc.gasUsed}  ETH ${row.ethUsd}  BTC ${row.btcUsd}  (${bytes} bytes of signed prices)`);
  out.push(row);
  await new Promise((r) => setTimeout(r, 5000));
}
if (n > 0) {
  // a view call with the payload: the value of 2 tETH in USD
  const v = await dataWithPrices(vault, "usdValueOfEth", [ethers.parseEther("2")]);
  const usd = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], await provider.call({ to: addr, data: v.data }))[0];
  log(`eth_call usdValueOfEth(2 tETH) = ${Number(usd) / 1e8} USD`);
}
state.redstone = { vault: addr, recordings: [...(state.redstone?.recordings ?? []), ...out] };
save();
writeFileSync(`${RUN}/redstone.json`, JSON.stringify(state.redstone, null, 2) + "\n");
