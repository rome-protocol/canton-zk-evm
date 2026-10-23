// The Hardhat project that explorer/server/rest/etherscan-contract-tools.test.ts runs `hardhat verify` in: Box.sol, compiled with the compiler the verifier runs
// (OSTIA_SOLC, a native solc 0.8.28, so that nothing is downloaded), and the explorer's Etherscan door as the block explorer of one custom chain.
require("@nomicfoundation/hardhat-verify");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

const SOLC = process.env.OSTIA_SOLC;
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (SOLC && args.solcVersion === "0.8.28") return { compilerPath: SOLC, isSolcJs: false, version: "0.8.28", longVersion: "0.8.28+commit.7893614a" };
  return runSuper();
});

module.exports = {
  solidity: { version: "0.8.28", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" } },
  networks: { ostia: { url: process.env.OSTIA_RPC || "http://127.0.0.1:1/rpc", chainId: Number(process.env.OSTIA_CHAIN_ID || 770101) } },
  etherscan: {
    apiKey: { ostia: "any" },
    customChains: [{ network: "ostia", chainId: Number(process.env.OSTIA_CHAIN_ID || 770101), urls: { apiURL: process.env.OSTIA_API || "http://127.0.0.1:1/api", browserURL: "http://127.0.0.1:1" } }],
  },
  sourcify: { enabled: false },
};
