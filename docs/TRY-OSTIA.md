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

In MetaMask or another wallet, add a custom network with these values. The gas price is about 1 gwei, and a block holds up to 60,000,000 gas (30,000,000 until 27 October 2026).

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

What has run on Ostia so far: the kit in `load/mixed/` (solc 0.8.17, built for `london`), Uniswap V2 (solc 0.5.16 and 0.6.6, `istanbul`) and TACEO's Merces contracts (solc 0.8.37, `osaka`; their deposit and transfer transactions go through and the on-chain verifier accepts the proofs, but no MPC network runs, so nothing settles privately). DevNet's rules include every fork up to Prague until 12:00 UTC on 28 October 2026, when its genesis (`osakaTime` 1793188800) moves it to Osaka. Until then any target up to `prague` is accepted, `london` is a safe choice, and an opcode that only Osaka adds will not run. A new local chain started from `network/genesis.json` runs Osaka from its first block.

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
2. The block is made. On 24 and 25 October a block was made about every 17 seconds at the median while there were transactions (23 seconds at the 95th percentile, over the 24 hours to 2026-10-25 11:54 UTC; full blocks took 20 to 23 seconds), with one block in flight. Since 26 October DevNet runs three blocks in flight on two GPU provers: under a burst at the 60,000,000 gas cap (27 October) a full block is cut about every 14 seconds, its proof takes 18 to 22 seconds, and a burst of 9,000 plain transfers reached its last final block 79 seconds after the first send. A block takes as many transactions as fit under the gas cap of 60,000,000, counting the gas they use, and under a cap on their raw bytes (393,216 on DevNet; 30,000,000 gas and 196,608 bytes until 27 October). When no transaction waits, the builder makes an empty block once a minute, so the newest final block on a healthy chain is not much older than a couple of minutes. If a transaction the RPC accepted stays pending, check the status strip on the explorer's home page (or `/api/health`).
3. A zero-knowledge proof of the block is made. In the one-hour mixed load of 2026-10-24, the median proof time was 9.03 seconds across 223 blocks of 11 to 100 transactions.
4. The block's record, with its proof, is written to Canton DevNet. That write is what makes the block final. In the same run, a block was final about 9 to 12 seconds after it was made (about 9 seconds for a small block, about 11 seconds, at most 13, with 70 transactions in a block).

The public RPC only shows final blocks. A transaction you have just sent does not show up in `eth_getTransactionReceipt` until its block is final, so a receipt takes roughly 10 to 30 seconds to appear. Tools that wait for a receipt just wait a little longer than on other chains.

On the explorer, open your transaction (`/tx/<hash>`) and then its block (`/block/<number>`). The block page shows the Canton update that holds the block's record, the time Canton recorded it, and the proof. Its Verify button checks the proof in your browser, with no server involved. The same data is in the API, for example `GET /api/blocks/<number>` and `GET /api/canton/updates/<update id>`.

## Canton tokens on DevNet

The gateway's legs are live on DevNet. wTKB, at `0x294d3049874526910a69f6b61da14d10a8b1b3af`, is the wrapped form of TKB, a Canton test token, and it is an ordinary ERC-20 with 10 decimals: read `balanceOf` and `totalSupply` like any other. The first deposits, payments and withdrawals (25 October 2026, blocks 780, 783 and 784, and again 1465, 1471 and 1473) were made by Rome with test parties it runs. Open `https://ostia.devnet.romeprotocol.xyz/legs` to see every leg, or `GET /api/legs`. You cannot make a deposit, payment or withdrawal of your own yet: self-serve onboarding is not built, so the Canton-side accounts and signing steps that deposits, payments and withdrawals need are not available to outside users. A legs lane cycles a deposit, a payment and a withdrawal every 10 minutes, so the block numbers above are only the first runs. On 27 October 2026 (15:55 UTC) an OTC app (`apps/otc`) swapped TKB for an ERC-20, TKA at `0xf4b69022b3e6501101600743f17fbe0659dd1af8`, the buyer's payment and the seller's TKB settled together in block 16816, in one Canton update, and the buyer claimed the wrapped TKB in block 16823.

## Limits to know about

- The RPC allows about 300 calls a minute from one client. A batch counts every call in it, and a batch is at most 20 calls.
- The RPC is HTTP only: there is no WebSocket, and no `eth_newFilter` or `eth_subscribe`. To follow events, poll `eth_getLogs` (in ethers v6, create the provider with `{ polling: true }`).
- The nonce of a transaction must follow the account's last one with no gap, or the RPC refuses it.
- `maxFeePerGas` must be at least the block's base fee (a few wei at the moment). Wallets and tools do this on their own.
- The explorer's REST API allows 20 requests a second with bursts of 60, and the Etherscan-compatible API 10 a second and 600 a minute.

## Something bigger to try

The `load/mixed/` folder in this repository deploys a set of contracts (ERC-20, ERC-721, ERC-1155, an ERC-3643 permissioned token, Uniswap V2, a RedStone price consumer, and TACEO's Merces contracts, with client-side proofs only; nothing settles) and drives an hour of mixed traffic through them. Its README has the commands and `load/mixed/RESULTS-2026-10-24.md` has what one run measured.
