# Try Ostia

Ostia is an EVM chain on Canton DevNet. Ordinary Ethereum tools work on it: wallets, Foundry, Hardhat, ethers, viem. What is different is what happens after a block is made: a zero-knowledge proof of the block is made, and the block's record, with the proof, is written to Canton. This guide gets you from nothing to a deployed, verified contract, and shows you where your transaction becomes final on Canton.

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
forge create src/Counter.sol:Counter --rpc-url $RPC --private-key $PRIVATE_KEY --broadcast
```

Verify the source on the explorer. It speaks the Etherscan API, so `forge verify-contract` works with the Etherscan verifier and any API key text:

```sh
forge verify-contract <address> src/Counter.sol:Counter \
  --chain-id 770101 \
  --verifier etherscan \
  --verifier-url https://ostia.devnet.romeprotocol.xyz/api \
  --etherscan-api-key any \
  --watch
```

The explorer takes about 30 verifications an hour from one client. If it says so, wait and send the request again.

## Deploy with Hardhat

```js
// hardhat.config.js
module.exports = {
  solidity: "0.8.24",
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

The longer timeout is there because a receipt only comes back once the block is final (next section).

## Where a transaction becomes final

1. You send a transaction to the RPC. It is put in the next block.
2. The block is made, about every 16 seconds while there are transactions. When the chain is quiet, there can be minutes between blocks.
3. A zero-knowledge proof of the block is made. In our measurements this took about 7.6 seconds for a small block and about 12.4 seconds for a block of more than a thousand transactions.
4. The block's record, with its proof, is written to Canton DevNet. That write is what makes the block final. In our measurements a transaction was final about 9 seconds after its block was made.

The public RPC only shows final blocks. A transaction you have just sent does not show up in `eth_getTransactionReceipt` until its block is final, so a receipt takes roughly 10 to 25 seconds to appear. Tools that wait for a receipt just wait a little longer than on other chains.

On the explorer, open your transaction (`/tx/<hash>`) and then its block (`/block/<number>`). The block page shows the Canton update that holds the block's record, the time Canton recorded it, and the proof. Its Verify button checks the proof in your browser, with no server involved. The same data is in the API, for example `GET /api/blocks/<number>` and `GET /api/canton/updates/<update id>`.

## Limits to know about

- The RPC allows about 300 calls a minute from one client. A batch counts every call in it, and a batch is at most 20 calls.
- The nonce of a transaction must follow the account's last one with no gap, or the RPC refuses it.
- `maxFeePerGas` must be at least the block's base fee (a few hundred wei at the moment). Wallets and tools do this on their own.
- The explorer's REST API allows 20 requests a second with bursts of 60, and the Etherscan-compatible API 10 a second and 600 a minute.

## Something bigger to try

The `load/mixed/` folder in this repository deploys a set of contracts (ERC-20, ERC-721, ERC-1155, an ERC-3643 permissioned token, Uniswap V2, a RedStone price consumer, and private transfers with Merces) and drives an hour of mixed traffic through them. Its README has the commands and `load/mixed/RESULTS-2026-10-24.md` has what one run measured.
