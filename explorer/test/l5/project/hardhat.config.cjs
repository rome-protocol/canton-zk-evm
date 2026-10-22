// The same compiler and settings as foundry.toml. The explorer's Etherscan-compatible API is the "etherscan" of the chain "rome".
require("@nomicfoundation/hardhat-verify");

const explorer = process.env.L5_EXPLORER;
const chainId = Number(process.env.L5_CHAIN_ID);

module.exports = {
  solidity: {
    version: process.env.L5_SOLC_VERSION || "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: { rome: { url: process.env.L5_RPC, chainId } },
  etherscan: {
    apiKey: { rome: "rome" },
    customChains: [{ network: "rome", chainId, urls: { apiURL: `${explorer}/api`, browserURL: explorer } }],
  },
  sourcify: { enabled: false },
};
