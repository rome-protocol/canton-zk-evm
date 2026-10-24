// Gives named test wallets tROME from the distributor, once each (a step per wallet; run again and nothing is sent twice).
//   node scripts/fund.mjs name=amount [name=amount ...]      e.g. oracle=20 merces-deployer=50
import { ethers } from "ethers";
import { cfg, log, distributor, wallets, done, step } from "./lib.mjs";

const want = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=")));
const d = distributor();
const W = wallets(Object.keys(want));
for (const [n, amount] of Object.entries(want)) {
  await step(`fund-${n}`, () => done(`send ${amount} ${cfg.coin} to ${n}`, d.sendTransaction({ to: W[n].address, value: ethers.parseEther(amount) })));
}
