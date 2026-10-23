import { describe } from "vitest";
import { ethersChecks } from "../test/etherscan-clients.ts";

/**
 * ethers' `EtherscanProvider` against an explorer that is running with a chain. They run only when EXPLORER_URL (where the explorer listens), CHAIN_ID,
 * ETHERSCAN_ADDRESS (an address without code), ETHERSCAN_BALANCE (its coins, in wei, at the final block) and ETHERSCAN_TX (a final transaction) are set.
 * tests/demo_rehearsal.sh sets them, after the faucet has paid its coin.
 */
const e = process.env;
describe.skipIf(!e.EXPLORER_URL || !e.ETHERSCAN_TX)("ethers' EtherscanProvider against the running explorer", () => {
  ethersChecks({ url: e.EXPLORER_URL ?? "", chainId: Number(e.CHAIN_ID), address: e.ETHERSCAN_ADDRESS ?? "", balance: BigInt(e.ETHERSCAN_BALANCE ?? "0"), txHash: e.ETHERSCAN_TX ?? "" });
});
