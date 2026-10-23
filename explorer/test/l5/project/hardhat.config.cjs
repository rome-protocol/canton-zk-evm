// The same compiler and settings as foundry.toml. The explorer's Etherscan-compatible API is the "etherscan" of the chain "rome".
require("@nomicfoundation/hardhat-verify");

const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// The compiler is the run's pinned solc (L5_SOLC, mounted by the nightly), so that nothing is downloaded from the Solidity servers.
const SOLC = process.env.L5_SOLC;
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (SOLC && args.solcVersion === "0.8.28") return { compilerPath: SOLC, isSolcJs: false, version: "0.8.28", longVersion: "0.8.28+commit.7893614a" };
  return runSuper();
});

const explorer = process.env.L5_EXPLORER;
const chainId = Number(process.env.L5_CHAIN_ID);

module.exports = {
  solidity: {
    version: process.env.L5_SOLC_VERSION || "0.8.28",
    settings: { optimizer: { enabled: true, runs: Number(process.env.L5_HARDHAT_RUNS || 200) }, evmVersion: "cancun" },
  },
  networks: { rome: { url: process.env.L5_RPC, chainId } },
  etherscan: {
    apiKey: { rome: "rome" },
    customChains: [{ network: "rome", chainId, urls: { apiURL: `${explorer}/api`, browserURL: explorer } }],
  },
  sourcify: { enabled: false },
};
