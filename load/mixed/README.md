# A realistic mixed load for Ostia

A kit that puts a realistic mix of contracts on an Ostia chain and drives mixed traffic through them, so that the zkVM on Canton is proven on more than transfers of one token. It deploys tokens of four kinds, a DEX, a permissioned token with identities, an oracle consumer and a private-transfer contract, then sends about an hour of mixed traffic (about a dozen kinds of action, from 200 wallets, up to the chain's best rate) and writes a report. The oracle consumer, the private transfers and the traffic driver are described further down.

## What it deploys

| What | Contracts |
|---|---|
| ERC-20 | `Test USD` (tUSD, 6 decimals) and `Test Ether` (tETH, 18 decimals), mintable by the deployer; `Wrapped tROME` (WtROME, a wrapper of the chain's coin written on OpenZeppelin's ERC20: deposit mints, withdraw burns and pays) |
| ERC-721 | `Ostia Pass` (OPASS), public mint, capped |
| ERC-1155 | `Ostia Items` (ids 1 to 5), public mint and batch mint |
| Uniswap V2 | factory and router, with two pools seeded with liquidity: tUSD/WtROME and tETH/tUSD |
| RedStone | `PriceVault`, a consumer of RedStone's pull model (see below) |
| Merces (TACEO) | TACEO's private-transfer contracts, deployed as they are; proofs are made client side only (see below) |
| ERC-3643 (T-REX) | the token `Ostia Gold Bond` (OGB, 6 decimals) with its ONCHAINID identity, identity registry and storage, claim topics registry (topic 1), trusted issuers registry (one issuer), modular compliance, four verified holders (each with an identity and a signed KYC claim) and one unverified address that cannot receive the token |

Our own contracts are in `contracts/` (small, Apache-2.0: the test tokens, the wrapper, the NFTs, the vault, the seeder). Everything else is installed or fetched at run time.

## Run it

You need Docker and a funded account on the chain. Nothing else is installed on the machine: every step runs in a pinned container (Node from the repo's own pin in `../../PINS`, Foundry from `PINS` here).

```sh
cd load/mixed
mkdir -p -m 0700 runs/mine/keys
# put the funded key (0x and 64 hex digits) in runs/mine/keys/distributor.key, mode 0600.
# Funding with config.json as it is: the deploy needs about 5,025 tROME (5,000 are wrapped for the first pool, 25 go to the test wallets, the rest is gas);
# the mixed load then gives each of its 200 wallets 30 tROME (6,000), and the oracle and Merces wallets take about 20 + 4 x 50 more. About 11,500 tROME in all; 12,000 is comfortable.
export RUN_DIR=$PWD/runs/mine
./run.sh build     # npm ci from the lockfile, then forge build (two passes, see below)
./run.sh deploy    # deploys, writes $RUN_DIR/addresses.json; run it again and it skips what exists
./run.sh smoke     # one action of each kind from the test wallets (writes smoke.json)
./run.sh verify    # verifies every contract on the explorer (about an hour: see below)
./run.sh merces-fetch                          # TACEO's Merces project at the pinned commit, compiled (see below)
./run.sh node scripts/merces.mjs deploy        # Merces: fund its wallets first, see below
./run.sh node scripts/redstone.mjs 3           # the oracle consumer (needs RedStone's gateways, see below)
./run.sh load seed         # 200 test wallets, funded, with tUSD and tETH
./run.sh load calibrate    # one action of every kind, to learn the gas of each
./run.sh load run mix1     # the timed hour (about 70 minutes with the drain)
./run.sh load report mix1  # the numbers: report.json and report.md in the run folder
```

`config.json` holds the chain (`rpc`, `explorer`, `explorerApi`, `chainId`) and the sizes of the pools and the token. To use another Ostia RPC, change it there, or set `RPC` for one run (`RPC=https://… ./run.sh deploy`; it reaches every step). The chain's public RPC answers only for final blocks, so each transaction is waited for until it is final (about 15 seconds each), and a full deploy is about 30 minutes.

The deployer's key and the test wallets' keys stay in `$RUN_DIR/keys/` (a 0700 folder, 0600 files, never printed, ignored by git).

## What is installed at run time, and its licence

None of this is in the repository. `package.json` pins each package to an exact version and `package-lock.json` pins the tree by hash; `npm ci` installs it, and Foundry compiles the contracts from `node_modules` with the solc each one asks for.

| Package | Version | Licence | Used for |
|---|---|---|---|
| `@uniswap/v2-core` | 1.0.1 | GPL-3.0-or-later | Uniswap V2 factory and pair |
| `@uniswap/v2-periphery` | 1.1.0-beta.0 | GPL-3.0-or-later | the router (see the pair hash below) |
| `@uniswap/lib` | 4.0.1-alpha | GPL-3.0-or-later | the router's transfer helper |
| `@erc3643org/erc-3643` | 4.1.3 | GPL-3.0 | the ERC-3643 (T-REX) token, registries, compliance engine and factory. This is the community-governed, GPL package; it has no rule modules besides a test one, so compliance is the modular engine with no module bound |
| `@onchain-id/solidity` | 2.2.1 | ISC | ONCHAINID identities, claim issuers and the identity factory |
| `@openzeppelin/contracts`, `-upgradeable` | 4.9.6 | MIT | the base contracts of ours and of T-REX |
| `ethers` | 6.16.0 | MIT | the deploy and the driver |
| `@redstone-finance/evm-connector`, `-sdk`, `-protocol` | 0.9.0 | **Business Source License 1.1** for the Solidity contracts (their `package.json` says MIT, but the package's `LICENSE` file is BUSL-1.1 and 17 contracts, the consumer base `PrimaryProdDataServiceConsumerBase` among them, carry `SPDX BUSL-1.1`) | the oracle consumer's base contract, the client that fetches and packs signed prices. **Non-production use only**: `PriceVault` inherits the base, so it is BUSL-bound too, and a production chain needs a licence from RedStone |
| `@taceo/merces1-client` | 1.0.1 | MIT | Merces proofs on the sending machine (only its proof functions are used) |
| `snarkjs`, `ffjavascript`, `r1csfile`, `fastfile`, `wasmbuilder`, `wasmcurves` | as locked | GPL-3.0 | what `@taceo/merces1-client` needs to make Groth16 proofs; installed by `npm ci`, never copied here |
| TACEO's Merces contracts and client (`TaceoLabs/merces1-x402`) | commit in `PINS` | MIT in the SPDX header of each contract; the repository has no `LICENSE` file | the Merces contracts, fetched with `./run.sh merces-fetch` and compiled in place (`third_party/`, ignored by git) |

The GPL contracts are compiled into the bytecode that is deployed (so are RedStone's BUSL contracts, in `PriceVault`); their sources are never copied into this repository. Anyone who runs the kit gets them from npm. The explorer's verification stores the source of each deployed contract, GPL ones included, which their licence allows.

**The Uniswap pair hash.** The router finds a pair by CREATE2 with a hash of the pair's creation code written into its library. That hash belongs to the original build of the pair; our build is not byte for byte the same. `scripts/prepare.mjs` reads the pair's code from the first build, writes a copy of the router and its library into `contracts/gen/` (git ignores it) with the hash of our pair, and the second build compiles that. `run.sh build` stops if the pair code differs between the two builds. The pair's solc 0.5.16 output ends with a source hash that depends on the build settings, so the factory and the router of one deploy must come from the same build: after changing anything in `foundry.toml` or the packages, deploy a new factory and router together (this is why the example run below has a second Uniswap set).

## Verification

`./run.sh verify` sends every contract to the explorer with `forge verify-contract --verifier etherscan` and asks `/api/contracts/<address>` afterwards. The explorer takes 30 verifications an hour from one client, so the step waits about two minutes between submissions (copies made by a factory, such as the pairs and the identity proxies, share the code of the first and are matched by it). `./run.sh node scripts/verify.mjs check` prints which contracts are verified without submitting anything.

The explorer's front proxy takes 300 KB a request. Forge's url-encoded body for `Merces` (23 source files, 265 KB of standard JSON) is 450 KB and gets `413`; `run.sh verify` then sends the same input to the explorer's JSON route (`POST /api/verify`, `scripts/verify-large.mjs`, 265 KB) and that passes.

**Known gap: ERC-3643 calls are not decoded on the explorer.** The T-REX token, identity registry and the ONCHAINID identities are verified as the proxies they are (`TokenProxy`, `IdentityRegistryProxy`, `IdentityProxy`); the explorer's proxy detection knows EIP-1967, EIP-1822, beacon and EIP-1167 proxies but not T-REX's implementation-authority proxies, so inputs of `transfer`, `batchMint`, `batchRegisterIdentity` and `addClaim` on them show as raw data. Supporting that proxy kind would be a change to the explorer, not to this kit.

## Layout

| File | What |
|---|---|
| `run.sh` | build, deploy, smoke, verify, in containers |
| `config.json` | chain, explorer, sizes |
| `PINS`, `package.json`, `package-lock.json` | what everything runs in and on |
| `contracts/` | our contracts, and the files that pull third-party contracts into the build |
| `scripts/deploy.mjs` | the idempotent deploy |
| `scripts/load.mjs`, `scripts/load-rpc.mjs`, `scripts/load-report.mjs` | the traffic driver (seed, calibrate, run), its rate-limited RPC client, and the report |
| `scripts/verify-large.mjs`, `scripts/tables.mjs` | verification for sources the front proxy refuses, and the run record's tables |
| `scripts/smoke.mjs` | one action of each kind |
| `scripts/oracle.mjs`, `scripts/redstone.mjs`, `scripts/merces.mjs`, `scripts/merces-lib.mjs`, `scripts/fund.mjs` | the RedStone client and vault step, the Merces deploy and private transfers, funding a named wallet |
| `scripts/verify.mjs`, `scripts/prepare.mjs`, `scripts/lib.mjs` | verification lists and checks, the Uniswap hash, shared helpers |

## The oracle consumer (RedStone)

`contracts/PriceVault.sol` is a small consumer of RedStone's pull model: it reads ETH/USD and BTC/USD from signed prices that ride at the end of the call data, checks them against RedStone's `redstone-primary-prod` data service (3 of its 5 public signers) and keeps the latest value. `scripts/oracle.mjs` fetches the signed prices from RedStone's gateways with `@redstone-finance/sdk` and builds the payload; `scripts/redstone.mjs` deploys the vault and records prices in it a few times.

```sh
./run.sh node scripts/fund.mjs oracle=20       # the oracle step has its own wallet
./run.sh node scripts/redstone.mjs 3           # deploys PriceVault, records 3 times, writes redstone.json
```

RedStone is switching its public gateways off: they refuse requests in windows that grow each day and stop for good on 2026-10-29. A refused request is tried again every 45 seconds for `REDSTONE_WAIT_MIN` minutes (default 30). After that date the same step works with a gateway address and API key passed to the SDK's `authenticatedGateways`; none is part of this kit.

## Private transfers (Merces, client side only)

`scripts/merces.mjs` deploys TACEO's Merces contracts as they are (fetched at the commit pinned in `PINS` by `./run.sh merces-fetch`: three libraries, two Groth16 verifiers and `Merces`, holding the chain's own coin) with three MPC public keys that were made for this test and that no MPC node holds. It then runs deposits and private transfers: each transfer's Groth16 proof is made on the machine that sends it, with the published TACEO client (`@taceo/merces1-client`, only its proof functions), and the verifier contract on the chain checks it before the action is queued. Nothing is settled: no MPC cluster runs behind it, so the queue only grows and the held coin stays in the contract until the test's own "MPC address" takes it back with `retrieve`. No message goes to TACEO and nothing of theirs is called.

```sh
./run.sh merces-fetch
./run.sh node scripts/merces.mjs deploy
./run.sh node scripts/merces.mjs demo 8        # 4 deposits, 8 private transfers, a tampered proof that must be refused, a withdraw request
./run.sh node scripts/merces.mjs probe 30      # proves 30 transfers and asks the chain to verify each with an eth_call
```

**A fix worth knowing.** The client's own proof compression chose the wrong sign for one curve point in about two proofs of five, and the verifier refused those (the same on a local chain, so it is not the network). The kit compresses with the verifier contract's own `compressProof` view call instead; with it, 30 of 30 proofs are accepted. The failed transaction that showed it, on the chain: [`0x010b34e1…`](https://ostia.devnet.romeprotocol.xyz/tx/0x010b34e10e1ff1c8bb4ea37c392ac1efb8664da35599e3ff5d03f4af65b8e5e1) (block 116, a transfer whose proof had the wrong sign).

## The mixed load (the driver)

`scripts/load.mjs` makes 200 test wallets (keys in `$RUN_DIR/keys/wallets.json`, 0600), gives each 30 tROME, 3,000 tUSD and 4 tETH (through the `Seeder` contract, 20 wallets per transaction), and sends the mix in `config.json`, phase by phase: 2, 3, 4 and 4.5 transactions a second for ten minutes each, then twenty minutes at the best rate the RPC budget allows, then a drain of up to ten minutes. The kinds, with their weights: ERC-20 transfers and approvals, wrap and unwrap of tROME, swaps both ways in both pools, adding and removing liquidity, ERC-721 mint and transfer, ERC-1155 mint, batch mint, transfer and batch transfer, ERC-3643 transfers (and a refused one), RedStone `record` calls, Merces deposits and private transfers, and deliberate reverts (an ERC-20 amount over balance, unwrapping more than held, a bad ERC-1155 id and so on). Transactions are signed by the driver, nonces are counted by it, and every transaction is followed until it is in a final block.

Everything goes to the public RPC like any user, under its limit of 300 calls a minute (the driver keeps to 285, retries included). `./run.sh load calibrate` first sends one action of each kind, one at a time, to learn the gas of each; `./run.sh load report <name>` reads the run's log, `/api/blocks`, `/api/canton/updates` and the receipts, and writes `report.json` and `report.md`. The report lists counts by kind (sent, final, succeeded, reverted), deliberate and unexpected reverts, lost transactions and refusals by reason, kinds that were skipped, time to final by phase and by block size, proof and commit times, Canton bytes per block, the RedStone and Merces results and the RPC use.

The hour that was run, and what it measured, is in [`RESULTS-2026-10-24.md`](RESULTS-2026-10-24.md).

## An example run

On Ostia DevNet (chain 770101), 24 October 2026. The deployer account is `0x5156D75f11D49990ae94Df0C92aFb7288be9FcBe`. It was funded with 20,000 tROME in one transfer, [`0x8f0926d20c71ff7f7be6a430f3e21da6b29dc3dd7f610257d21c179f8ac5ae58`](https://ostia.devnet.romeprotocol.xyz/tx/0x8f0926d20c71ff7f7be6a430f3e21da6b29dc3dd7f610257d21c179f8ac5ae58), sent from the faucet's account by the operator on the machine that runs the chain's services (the faucet service itself gives 1 tROME a day); the transfer went through the public RPC.

**What is left over, on purpose not hidden.** The deploy was run more than once on the way, and the chain keeps every contract:

- A second `UniswapV2Factory` (block 44) and a `UniswapV2Router02` (block 45) from the first attempt; the router was built with the original Uniswap pair hash and never worked, and the router is unverified.
- The first `WtROME` (block 35) was a line-for-line port of Dapphub's WETH9, which is GPL-3.0-or-later, labelled Apache-2.0 by mistake. It is replaced by the wrapper on OpenZeppelin's ERC20 in this folder, deployed again (block 178 on) with its own factory, router and two pools before the hour-long traffic started; the old `WtROME`, factory, router and pools are in the table "Deployed and not used" and nothing calls them. A first try of the new set against the old factory also left one router that cannot work (the factory's pair code came from a different build, see the pair hash above).
- The explorer shows the first `WtROME`'s source under an Apache-2.0 label; that source is no longer in this repository.

**Verification result.** See the end of this section; every contract in use shows `verified: true` at `/api/contracts/<address>`. Matches are full, similar (copies made by a factory share the code of the first) or partial (only the metadata differs: the kit compiles without the metadata hash on purpose, as the pair hash needs a build that is the same byte for byte). Verified through the explorer's Etherscan API, paced under its 30 an hour; `Merces` through its JSON route (see Verification).

<!--TABLES-->
