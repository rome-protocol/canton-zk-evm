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

What has run on Ostia so far: the kit in `load/mixed/` (solc 0.8.17, built for `london`), Uniswap V2 (solc 0.5.16 and 0.6.6, `istanbul`) and TACEO's Merces contracts (solc 0.8.37, `osaka`; their deposit and transfer transactions go through and the on-chain verifier accepts the proofs, but no MPC network runs, so nothing settles privately). DevNet has run Osaka since 12:00 UTC on 28 October 2026 (its genesis sets `osakaTime` to 1793188800). Rome checked it at 12:01 and 12:03 UTC: a transaction of more than 2^24 gas was refused, and a contract that uses `CLZ` and `P256VERIFY` was deployed in block 23389 and was final on Canton. Any target up to `osaka` is accepted, and `london` is still a safe choice. A new local chain started from `network/genesis.json` runs Osaka from its first block.

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
2. The block is made. On 24 and 25 October a block was made about every 17 seconds at the median while there were transactions (23 seconds at the 95th percentile, over the 24 hours to 2026-10-25 11:54 UTC; full blocks took 20 to 23 seconds), with one block in flight. From 26 to 28 October DevNet ran three blocks in flight on two GPU provers: under a burst at the 60,000,000 gas cap (27 October) a full block was cut about every 14 seconds, its proof took 18 to 22 seconds, and a burst of 9,000 plain transfers reached its last final block 79 seconds after the first send. Since 19:27 UTC on 28 October DevNet runs two blocks in flight on one GPU prover; on 29 October at 11:00 UTC, with a light load, proving and committing one block took 12.3 seconds at the median and 14.8 seconds at the 95th percentile (the last 1,286 blocks). A block takes as many transactions as fit under the gas cap of 60,000,000, counting the gas they use, and under a cap on their raw bytes (393,216 on DevNet; 30,000,000 gas and 196,608 bytes until 27 October). DevNet also runs the builder's pre-check, which cuts a block short when its predicted proof time is over the budget, so a block can hold fewer transactions than these two caps allow. When no transaction waits, the builder makes an empty block once a minute, so the newest final block on a healthy chain is not much older than a couple of minutes. If a transaction the RPC accepted stays pending, check the status strip on the explorer's home page (or `/api/health`).
3. A zero-knowledge proof of the block is made. In the one-hour mixed load of 2026-10-24, the median proof time was 9.03 seconds across 223 blocks of 11 to 100 transactions.
4. The block's record, with its proof, is written to Canton DevNet. That write is what makes the block final. In the same run, a block was final about 9 to 12 seconds after it was made (about 9 seconds for a small block, about 11 seconds, at most 13, with 70 transactions in a block).

The public RPC only shows final blocks. A transaction you have just sent does not show up in `eth_getTransactionReceipt` until its block is final, so a receipt takes roughly 10 to 30 seconds to appear. Tools that wait for a receipt just wait a little longer than on other chains.

On the explorer, open your transaction (`/tx/<hash>`) and then its block (`/block/<number>`). The block page shows the Canton update that holds the block's record, the time Canton recorded it, and the proof. Its Verify button checks the proof in your browser, with no server involved. The same data is in the API, for example `GET /api/blocks/<number>` and `GET /api/canton/updates/<update id>`.

## Move tokens with the Bridge page

Anyone with MetaMask (or another browser wallet) can move tokens between Ostia and Canton on their own, on `https://ostia.devnet.romeprotocol.xyz/bridge`. DevNet only.

1. Open `/bridge` and press Connect MetaMask. The page adds Ostia DevNet to the wallet if it is not there.
2. Press Open my Canton account. MetaMask asks you to sign one message, which costs no gas. The first time it asks twice for the same message, so the page can check that your wallet signs it the same way each time. The page makes the Canton key from that signature, and Rome's validator hosts the account but cannot sign for it: only that key does. Anyone who gets you to sign the same message gets the same Canton key, so sign it only on this site, which shows its own address. Opening the account also signs two opt-ins with the new key: one to receive Ostia tokens, and one to accept withdrawals.
3. Get test coins on the same page: 1 tROME a day from the explorer's faucet, and 20 test Canton Coin a day. A visitor can open 3 new accounts a day, and DevNet's participant allows up to 1000 accounts.
4. Pick a token and an amount and press Move. The page signs the Canton steps itself, after it has checked each transaction; MetaMask asks only for the Ostia steps. A line under the button says about how long the move takes and how many MetaMask pop-ups it needs; open it to see each step.

The four moves:

| Move | MetaMask pop-ups | Measured |
|---|---|---|
| An Ostia token (TKA, tROME) to Canton: it arrives as the same token. tROME is wrapped first | 2 for TKA; 3 for tROME (wrap, approve, pay) | tROME: 2 min 13 s |
| Back from Canton to Ostia: the page signs on Canton, you release on Ostia. tROME comes back as WtROME | 1 | tROME: 58 s |
| Canton Coin to Ostia: it arrives as the CC token. The page signs twice on Canton, you claim on Ostia | 1 | 56 s |
| CC back to Canton Coin | 1 | 46 s |

The times were measured on the live site on 8 November 2026 with a fresh wallet. The chain itself was final in about 10 seconds; the rest is the wallet and the page waiting for the proven block. Expect about 1 minute for a move with one pop-up and about 2 minutes for a lock (two or three pop-ups).

Each move shows three marks: Sent (the transaction has a hash, or the explorer has it), Proven (the zero-knowledge proof of its block has ended) and Final (the block is final on Canton and the transaction went through). In the Activity tab each row links to the move's block on Ostia and to its Canton update. The Activity tab lists your moves, the unfinished ones and the ones started in another browser, and an unfinished move carries on from its row. A lock for an account that has not opted in is refused before anything is paid.

## Canton tokens on DevNet

The gateway's legs are live on DevNet. wTKB, at `0x294d3049874526910a69f6b61da14d10a8b1b3af`, is the wrapped form of TKB, a Canton test token, and it is an ordinary ERC-20 with 10 decimals: read `balanceOf` and `totalSupply` like any other. The first deposits, payments and withdrawals (25 October 2026, blocks 780, 783 and 784, and again 1465, 1471 and 1473) were made by Rome with test parties it runs. Canton Coin and the Ostia tokens now move on the [Bridge page](#move-tokens-with-the-bridge-page). Open `https://ostia.devnet.romeprotocol.xyz/legs` to see every leg, or `GET /api/legs`. Rome cycles a deposit, a payment and a withdrawal every 10 minutes, so the block numbers above are only the first runs. On 27 October 2026 (15:55 UTC) an OTC app (`apps/otc`) swapped TKB for an ERC-20, TKA at `0xf4b69022b3e6501101600743f17fbe0659dd1af8`. The buyer's payment and the seller's TKB settled together in block 16816, in one Canton update, and the buyer claimed the wrapped TKB in block 16823.

## Canton twins and Canton Coin on DevNet

Since 29 October 2026 an ERC-20 on Ostia can stand on Canton as a twin, and Canton Coin can move onto Ostia and back. The twins went live in commit 4b4f63c, deployed at 10:33 UTC that day, under Daml package 0.5.0. DevNet has run commit c350f87 since 8 November 2026, with the same twin flows, the twin acceptance below and the Bridge page.

How these flows work on DevNet (the Bridge page above makes the Canton steps for you; `demo/twin.py` and `demo/cc.py` show them one by one):

- **Lock an ERC-20 for a Canton party.** You pay the ERC-20 into the vault, and the Canton party you named holds the same amount of its twin, a CIP-0056 token with the instrument id `erc20:<token address>`. The twin moves on Canton like any CIP-0056 token. After each lock and redeem the twin's supply equals what the vault holds, and the explorer's token page compares the two.
- **Redeem it.** The holder of the twin signs a redeem request on Canton, `Vault.release` pays the ERC-20 to the EVM address in the request, and the twin is burnt.
- **Bring Canton Coin into Ostia and back.** A party deposits Canton Coin through the gateway and the recipient claims wCC (its symbol on Ostia is CC), the wrapped Canton Coin. Burning wCC through the gateway pays the Canton Coin back to the party.

The addresses:

| What | Address on Ostia |
|---|---|
| Vault | `0x69f13a94f986021f1a7650eb611bf9b717aa495a` (block 28208) |
| TKA, the ERC-20 that has a twin | `0xf4b69022b3e6501101600743f17fbe0659dd1af8` (18 decimals) |
| WtROME, wrapped tROME, the second twin | `0xc221fc4af51caa9d198e70e3cb3b8f3d9d2adc64` (18 decimals) |
| wCC, wrapped Canton Coin | `0x4db3dea7c13116961fd3e438542ccfcca61a7547` (10 decimals) |

The twin registry service answers at `https://ostia.devnet.romeprotocol.xyz/twin-registry/`. It holds no key and writes nothing to Canton. These paths are public:

```sh
R=https://ostia.devnet.romeprotocol.xyz/twin-registry
curl $R/healthz                                  # ok, the twins, the vaults
curl $R/registry/metadata/v1/instruments         # the twins, each with its total supply
curl $R/registry/metadata/v1/instruments/erc20:f4b69022b3e6501101600743f17fbe0659dd1af8
curl $R/twin/v1/twins                            # token, instrument id, rules contract, vaults
```

`/registry/...` is the token standard's registry API (metadata, and the transfer and allocation factories with their choice contexts), so a wallet can send twins. `POST /twin/v1/lock-parts` takes `{"receiver": <Canton party id>, "ref": <text>}` before a lock and answers with the lock id and the registered vaults. The party id is a name, `::`, then `1220` and 64 lowercase hex digits. The answer also carries the contract id of the receiver's acceptance (`acceptance`), and the receiver must have accepted twins once; see the acceptance below. For example:

```sh
RECEIVER=alice::1220abababababababababababababababababababababababababababababababab
curl -X POST -H 'content-type: application/json' $R/twin/v1/lock-parts \
  -d "{\"receiver\":\"$RECEIVER\",\"ref\":\"my-first-lock\"}"
# {"lockId": "2317463a...01fd", "receiver": "alice::1220ab...", "ref": "my-first-lock", "acceptance": "00ab...", "vaults": ["69f13a94f986021f1a7650eb611bf9b717aa495a"]}
printf 'lock,%s,%s' "$RECEIVER" my-first-lock | shasum -a 256   # the same lockId
```

Check the id yourself, as the last line does (it is the SHA-256, in lowercase hex, of `lock,<receiver>,<ref>`), and take the vault from a source you trust, because the service is only a hint to the payer. The chain record, which names the registered vaults, is a Canton contract that only Rome's parties can read, so today there is no source outside Rome for which vault is registered: the table above and `curl $R/healthz` (under `vaults`) are both Rome's. What anyone can check is that the vault at that address is the reviewed build: `cast keccak $(cast code 0x69f13a94f986021f1a7650eb611bf9b717aa495a --rpc-url $RPC)` must equal `cast keccak 0x$(cat gateway/Vault.bin-runtime)`, which is `0x2fbcf33083dd26a360690a0d8d24cd333997b3c7000d950aa5e564e01460d4da` (the vault has no owner, no key and no upgrade).

What ran on 29 October 2026 (the blocks and Canton updates are in [DESIGN.md](DESIGN.md)):

- A lock of 5 TKA for a Canton party went into block 28389, and the party held 5 twin. 2 twin were sent to a second party on Canton. A redeem of those 2 went into block 28392. The twin's supply and the vault's balance were both 3 afterwards.
- A lock of a token with no twin was refused before anything was sent, and a payment into the vault with no announced parts was left out of block 28395.
- 5 Canton Coin went in through block 28473, so that the party held 15, the gateway held 5 and the wCC supply was 5. The withdrawal in block 28474 put all three back: 20, 0 and 0. DevNet charged no fee on these transfers.

A lock is for a party on one of Rome's two DevNet participants, which have vetted the twin package.

The acceptance keeps a lock from stranding a payer. It has been on DevNet since 8 November 2026. A party signs a `TwinAcceptance` once (a contract of the twin package 0.2.0, `apps/twin`), and the service refuses to announce a lock for a party without one (409). The builder reads the receiver's acceptance itself, and a lock for a party without one, even if it is paid, is left out of the block before it is proven, so the ERC-20 stays with the payer. A participant that hosts twin receivers vets twin 0.1.0 and 0.2.0, because the chain mints twin 0.1.0 and the acceptance is in 0.2.0. An account opened on the Bridge page signs its acceptance as part of opening.

Redeeming, and every Canton Coin step, needs a signature of a Canton party as well; the Bridge page signs it with the account's own key. [DESIGN.md](DESIGN.md#ostia-on-devnet) lists the other known limits of the twins.

`demo/twin.py` shows each step of the twins (`deploy-vault`, `rules`, `lock`, `send`, `redeem`, `balances`), and `demo/cc.py` shows each step of Canton Coin (`register`, `fund`, `deposit`, `withdraw`, `balances`). Both print one JSON object per command and are described in [demo/README.md](../demo/README.md).

## Limits to know about

- The RPC allows about 300 calls a minute from one client. A batch counts every call in it, and a batch is at most 20 calls.
- The RPC is HTTP only: there is no WebSocket, and no `eth_newFilter` or `eth_subscribe`. To follow events, poll `eth_getLogs` (in ethers v6, create the provider with `{ polling: true }`).
- The nonce of a transaction must follow the account's last one with no gap, or the RPC refuses it.
- `maxFeePerGas` must be at least the block's base fee (a few wei at the moment). Wallets and tools do this on their own.
- The explorer's REST API allows 20 requests a second with bursts of 60, and the Etherscan-compatible API 10 a second and 600 a minute.

## Something bigger to try

The `load/mixed/` folder in this repository deploys a set of contracts (ERC-20, ERC-721, ERC-1155, an ERC-3643 permissioned token, Uniswap V2, a RedStone price consumer, and TACEO's Merces contracts, with client-side proofs only; nothing settles) and drives an hour of mixed traffic through them. Its README has the commands and `load/mixed/RESULTS-2026-10-24.md` has what one run measured.
