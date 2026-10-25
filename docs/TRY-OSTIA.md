# Try Ostia

Ostia is an EVM chain on Canton DevNet. Ordinary Ethereum tools work on it: wallets, Foundry, Hardhat, ethers, viem. What is different is what happens after a block is made: a zero-knowledge proof of the block is made, and the block's record, with the proof, is written to Canton. This guide connects an existing Foundry or Hardhat project to Ostia. Before you start, have Foundry or Hardhat installed, a contract (and, for Hardhat, a deploy script), and a key to sign with. The guide shows how to fund that key from the faucet, deploy, verify, and see where your transaction becomes final on Canton.

Ostia is a DevNet. Its coin, tROME, has no value, and the chain can be reset.

## The network

| Setting | Value |
|---|---|
| Network name | Ostia DevNet |
| Chain ID | `770101` |
| Currency | tROME (18 decimals) |
| RPC URL | `https://ostia.devnet.romeprotocol.xyz/rpc` |
| Explorer | `https://ostia.devnet.romeprotocol.xyz` |
| Explorer API (Etherscan-compatible) | `https://ostia.devnet.romeprotocol.xyz/api` |

In MetaMask or another wallet, add a custom network with these values. The gas price is about 1 gwei, and a block holds up to 30,000,000 gas.

## Get tROME

Open `https://ostia.devnet.romeprotocol.xyz/faucet`, paste your address and ask. The faucet gives 1 tROME to an address once a day and answers one request every 10 minutes from the same internet address. You can also ask from a terminal:

```sh
curl -X POST https://ostia.devnet.romeprotocol.xyz/api/faucet \
  -H 'content-type: application/json' \
  -d '{"address":"0xYourAddress"}'
```

The payout is sent in the next block, so it arrives when that block is final (see below). One tROME pays for thousands of ordinary transactions at today's gas price.

## Deploy with Foundry

```sh
export RPC=https://ostia.devnet.romeprotocol.xyz/rpc
forge create src/Counter.sol:Counter --rpc-url $RPC --private-key $PRIVATE_KEY --evm-version london --broadcast
```

What has run on Ostia so far: the kit in `load/mixed/` (solc 0.8.17, built for `london`), Uniswap V2 (solc 0.5.16 and 0.6.6, `istanbul`) and TACEO's Merces contracts (solc 0.8.37, `osaka`; their deposit and transfer transactions go through and the on-chain verifier accepts the proofs, but no MPC network runs, so nothing settles privately). Ostia's rules include every fork up to Prague (`network/genesis.json`), so any EVM target up to `prague` is accepted; `london` is a safe choice. An opcode that only a later fork adds will not run.

Verify the source on the explorer. It speaks the Etherscan API, so `forge verify-contract` works with the Etherscan verifier and any API key text:

```sh
forge verify-contract <address> src/Counter.sol:Counter \
  --chain-id 770101 \
  --evm-version london \
  --verifier etherscan \
  --verifier-url https://ostia.devnet.romeprotocol.xyz/api \
  --etherscan-api-key any \
  --watch
```

Use the same compiler version, optimizer settings, EVM version and constructor arguments as in the deploy (settings in `foundry.toml` are shared by both). The explorer takes about 30 verifications an hour from one client. If it says so, wait and send the request again.

A large multi-file contract can be refused with HTTP 413. For Merces, the explorer's front proxy refused forge's url-encoded request (about 450 KB) and accepted the same input as JSON (about 265 KB). The kit's `load/mixed/scripts/verify-large.mjs` sends the compiler input and the contract's details to `POST /api/verify` as JSON. The front proxy takes about 300 KB a request, so a JSON input above that is still refused; the explorer itself takes a source of up to 500 KiB.

## Deploy with Hardhat

```js
// hardhat.config.js
module.exports = {
  solidity: { version: "0.8.17", settings: { evmVersion: "london" } },
  networks: {
    ostia: {
      url: "https://ostia.devnet.romeprotocol.xyz/rpc",
      chainId: 770101,
      accounts: [process.env.PRIVATE_KEY],
      timeout: 120000,
    },
  },
};
```

```sh
npx hardhat run scripts/deploy.js --network ostia
```

A receipt only comes back once the block is final (next section), so a deploy waits for it by polling. Hardhat's `timeout` above applies to each single request, not to that wait.

## Where a transaction becomes final

1. You send a transaction to the RPC. If the RPC accepts it, it enters the transaction pool. The builder chooses transactions for the blocks it makes next, so acceptance does not guarantee a place in the very next block.
2. The block is made, about every 16 seconds while there are transactions. The builder makes no empty blocks, so while no transaction waits, the chain makes no blocks at all, possibly for hours. An hours-old final block on the explorer is then expected. If a transaction the RPC accepted stays pending, check the status strip on the explorer's home page (or `/api/health`).
3. A zero-knowledge proof of the block is made. In the one-hour mixed load of 2026-10-24, the median proof time was 9.03 seconds across 223 blocks of 11 to 100 transactions.
4. The block's record, with its proof, is written to Canton DevNet. That write is what makes the block final. In the same run, a block was final about 9 to 12 seconds after it was made (about 9 seconds for a small block, about 11 seconds, at most 13, with 70 transactions in a block).

The public RPC only shows final blocks. A transaction you have just sent does not show up in `eth_getTransactionReceipt` until its block is final, so a receipt takes roughly 10 to 30 seconds to appear. Tools that wait for a receipt just wait a little longer than on other chains.

On the explorer, open your transaction (`/tx/<hash>`) and then its block (`/block/<number>`). The block page shows the Canton update that holds the block's record, the time Canton recorded it, and the proof. Its Verify button checks the proof in your browser, with no server involved. The same data is in the API, for example `GET /api/blocks/<number>` and `GET /api/canton/updates/<update id>`.

## Limits to know about

- The RPC allows about 300 calls a minute from one client. A batch counts every call in it, and a batch is at most 20 calls.
- The RPC is HTTP only: there is no WebSocket, and no `eth_newFilter` or `eth_subscribe`. To follow events, poll `eth_getLogs` (in ethers v6, create the provider with `{ polling: true }`).
- The nonce of a transaction must follow the account's last one with no gap, or the RPC refuses it.
- `maxFeePerGas` must be at least the block's base fee (a few wei at the moment). Wallets and tools do this on their own.
- The explorer's REST API allows 20 requests a second with bursts of 60, and the Etherscan-compatible API 10 a second and 600 a minute.

## Something bigger to try

The `load/mixed/` folder in this repository deploys a set of contracts (ERC-20, ERC-721, ERC-1155, an ERC-3643 permissioned token, Uniswap V2, a RedStone price consumer, and TACEO's Merces contracts, with client-side proofs only; nothing settles) and drives an hour of mixed traffic through them. Its README has the commands and `load/mixed/RESULTS-2026-10-24.md` has what one run measured.
