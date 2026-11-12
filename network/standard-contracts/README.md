# Standard contracts

`deploy.py` puts four contracts that many tools expect at fixed addresses on an EVM chain, at those addresses, with the code their creators published. It was written for Ostia (chain 770101), and works on any chain that runs the EVM with Ethereum's gas rules.

| Name | Address | What it is | How it is deployed |
|---|---|---|---|
| `create2-deployer` | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | The deterministic CREATE2 deployer ("Nick's method"): a call with a salt and init code deploys the contract at a fixed address. Foundry's `CREATE2` scripts and many deploy tools use it | A presigned transaction of a one-time signer |
| `multicall3` | `0xcA11bde05977b3631167028862bE2a173976CA11` | Multicall3: batches many calls into one `eth_call` or one transaction. Wallets, front ends and indexers use it | A presigned transaction of a one-time signer |
| `createx` | `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` | CreateX: a factory for `CREATE`, `CREATE2` and `CREATE3` deployments, with deployer-protected salts | A presigned transaction of a one-time signer |
| `permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Permit2: signature-based token approvals and transfers, one approval per token for every app that uses it | A call to `create2-deployer` with the canonical salt and the canonical init code, from the funding account |

The Safe singleton factory (`0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7`) is not here. Its deployment transaction is signed by Safe for each chain id, on request, so it is a separate step.

## Run it

```
python3 network/standard-contracts/deploy.py --rpc <URL> --funding-key-file <FILE> --dry-run
python3 network/standard-contracts/deploy.py --rpc <URL> --funding-key-file <FILE>
```

`--funding-key-file` holds the funding account's key as hex, in a file with no permission for the group or others (mode 0600 or 0400; a file with any group or other permission is refused). The key is used to sign and is never printed. `--only create2-deployer,multicall3` deploys just those (Permit2 needs the deployer, from this run or already there). `--wait-seconds` is how long each transaction may take to be in a block (300 by default). Needs `pip install eth-account` (`demo/requirements.txt` pins it).

For each contract, in the order of the table:

- **The address has code with the canonical runtime code hash:** nothing is sent. A run that finds all four in place sends nothing and says so.
- **The address has other code:** the run stops before it sends anything for any contract, names the address, and exits 1. That address cannot be used on the chain.
- **No code, and a presigned transaction:** before anything is funded, the first presigned transaction that needs funding is sent once as a probe: a signer that holds too little makes the node answer `insufficient funds` and keep nothing, while a node that wants a transaction tied to a chain says so, and the run stops with nothing funded. Then the one-time signer is sent only the shortfall of `gasLimit x gasPrice` (nothing if it holds that already). Once that transfer is in a block, the presigned transaction is sent as it is, and after it is in a block the code at the address is read and its hash checked. If the node does not take the presigned transaction, the code at the address is read and reported: other code there is named with its hash, and the canonical code there is accepted as in place. A signer that has sent a transaction already (and the address has no code) is refused: its one deployment transaction can no longer be mined.
- **The funding account has a transaction waiting in the node's pool** (its pending nonce is above its latest nonce): a run that would send anything refuses, since a transfer of an earlier run that timed out may be among them and a new run would fund the signer twice. Run again once it is mined.
- **No code, Permit2:** the funding account calls the CREATE2 deployer, and the code is checked in the same way.

`--dry-run` reads the chain and prints each step and the funding account's expected cost, and sends nothing.

Before it reads the chain, the script checks `contracts.json` against itself, and stops on any mismatch: each presigned transaction is a creation with nonce 0, not tied to a chain (signed before EIP-155), with the stated gas limit and gas price; its signer is the stated one; the signer's first contract address is the canonical address; and the CREATE2 address that Permit2's salt and init code give from the deployer is Permit2's address.

## What it costs

The presigned transactions are priced at 100 gwei and have fixed gas limits, so the signers are funded with 0.01 coin (`create2-deployer`, 100,000 gas), 0.1 coin (`multicall3`, 1,000,000 gas) and 0.3 coin (`createx`, 3,000,000 gas), and only the gas used is spent: 68,137, 873,016 and 2,580,902 gas on reth 2.5.2 with Ostia's genesis (the test chain, not DevNet), which is about 0.007, 0.087 and 0.258 coin. The rest stays on the one-time signer. For `create2-deployer` (about 0.003 coin) nobody is known to hold a key that can spend it; for `multicall3` (about 0.013 coin) and `createx` (about 0.042 coin) the holders of those signers' keys can (see Notes). Permit2's deployment takes about 2.0 million gas, at the funding account's own gas price.

## Notes

**The presigned transactions need the chain's own reth RPC.** They are not tied to a chain, and Ostia's public RPC refuses such a transaction (`explorer/server/public-rpc.ts`, "This transaction is not tied to a chain"; `explorer/server/public-rpc.test.ts` checks it). reth does not: its transaction pool checks a transaction's chain id only if the transaction carries one (`crates/transaction-pool/src/validate/eth.rs` in reth 2.5.2), and reth 2.5.2 has no flag about unprotected transactions (`reth node --help` has none; `tests/standard_contracts.sh` checks that and that reth takes all three at the flags `network/reth/launch.sh` gives it, with no other flag). So run the script against the reth's RPC on the machine that runs reth. The 100 gwei price is above the base fee, which is all the fee rules ask, and each transaction's fee (gas limit x price, 0.3 coin at most) is under reth's default cap on one transaction's fee (1 coin).

**Two of the three one-time signers are not keyless in the strict sense.** No key is known for the signer of `create2-deployer` (its signature is a made-up value, and its address was worked out from it), so nobody is known to be able to send anything else from it. The signers of `multicall3` and `createx` signed with real keys. Whoever holds such a key can, on a chain where the signer has not sent its first transaction, deploy other code at the address. A sweep of the funding inside that window also uses up the signer's nonce, so the canonical address is lost on that chain either way (the script sees it and stops with a message). The Multicall3 project reports that its signer's key was found by a vanity search with Profanity and is compromised, and that someone has used it that way on one chain. The script limits the window (it funds the signer only when it is about to send, after the probe above, and sends as soon as the funding is in a block) and checks the code after, and a hash that is not the canonical one is reported as a failure. It cannot close the window. `--only` leaves `multicall3` out.

**Permit2's init code is not in any one file upstream.** It is rebuilt from two files of Uniswap's repository, and `contracts.json` says which: the constructor from Permit2's source compiled with solc 0.8.17, and the runtime code from Uniswap's precompiled copy (`test/utils/DeployPermit2.sol`). The check that it is the canonical init code is the address: CREATE2 from the deployer, with Permit2's salt, gives `0x000000000022D473030F116dDEE9F6B43aC78BA3` from exactly this init code, and the script checks that on every run.

**Permit2's runtime code differs by chain.** It holds the chain id and the domain separator built from it as immutables, so its runtime code hash is not the same on two chains. The script works the hash out for the chain it runs against from the init code (`contracts.json` also holds the hash for chain 770101, which the script checks too).

**Where each hash comes from** is in `contracts.json`, in each entry's `source`. For `create2-deployer` and `multicall3` the runtime code is the tail of the presigned transaction's init code (those two have no immutables). For `createx` it is the init code after its constructor with the contract's own address written into its 25 immutable slots, and it equals the repository's published `deployedBytecode` filled the same way.

## Tests

- `tests/test_standard_contracts.py`: the script against a stand-in node. The data checks itself, a dry run sends nothing, the first run deploys all four and the second sends nothing, only the shortfall is funded, other code or a used signer stops the run before anything is sent, a key file with any group or other permission is refused (0400 is taken), a node that refuses transactions not tied to a chain stops the run before any funding (also with `--only multicall3` and the deployer in place), a funding account with a transaction waiting in the pool is refused, a node that takes none of a presigned transaction because other code got there first is reported with that code's hash, and the key is never printed.
- `tests/standard_contracts.sh`: the script against a real reth, started only by `network/reth/launch.sh` (discovery off, no peers) and checked by `network/reth/check.sh`, on the chain's genesis. The first run puts all four at their addresses with the canonical code hashes (3 fundings, 3 presigned transactions and Permit2's deployment: 7 transactions), the second makes no block, a dry run makes no block, and a chain with other code at Multicall3's address is refused with nothing sent.
