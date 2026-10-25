# A realistic mixed load for Ostia

A kit that puts a realistic mix of contracts on an Ostia chain and drives mixed traffic through them, so that the zkVM on Canton is proven on more than transfers of one token. It deploys tokens of four kinds, a DEX, a permissioned token with identities, a vault for oracle prices (RedStone's pull model) and a private-transfer contract, then sends about an hour of mixed traffic (about twenty kinds of action, from 200 wallets, going up to about 4.5 transactions a second, the most one client's RPC budget allows) and writes a report. The hour that was run, with what it measured and what did not work (the oracle recorded no price), is in [`RESULTS-2026-10-24.md`](RESULTS-2026-10-24.md). The oracle vault, the private transfers and the traffic driver are described further down.

## What it deploys

| What | Contracts |
|---|---|
| ERC-20 | `Test USD` (tUSD, 6 decimals) and `Test Ether` (tETH, 18 decimals), mintable by the deployer; `Wrapped tROME` (WtROME, a wrapper of the chain's coin written on OpenZeppelin's ERC20: deposit mints, withdraw burns and pays) |
| ERC-721 | `Ostia Pass` (OPASS), public mint, capped |
| ERC-1155 | `Ostia Items` (ids 1 to 5), public mint and batch mint |
| Uniswap V2 | factory and router, with two pools seeded with liquidity: tUSD/WtROME and tETH/tUSD |
| RedStone | `PriceVault`, a consumer of RedStone's pull model; deployed and verified, but in the example run it recorded no price, because RedStone's public gateways refuse anonymous requests (see below) |
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

None of this is in the repository. `package.json` pins each package to an exact version and `package-lock.json` pins the tree by hash; `npm ci` installs it, and Foundry compiles the contracts from `node_modules` with the solc each one asks for. The compilers (solc 0.5.16, 0.6.6, 0.8.17 and, for Merces, 0.8.37) are fetched by `scripts/solc-fetch.mjs` from the Solidity binaries server with the project contact as User-Agent, each checked against the sha256 of the server's own list, and `forge build --offline` then makes no download of its own. This step works on linux x64 only.

| Package | Version | Licence | Used for |
|---|---|---|---|
| `@uniswap/v2-core` | 1.0.1 | GPL-3.0-or-later | Uniswap V2 factory and pair |
| `@uniswap/v2-periphery` | 1.1.0-beta.0 | GPL-3.0-or-later | the router (see the pair hash below) |
| `@uniswap/lib` | 4.0.1-alpha | GPL-3.0-or-later | the router's transfer helper |
| `@erc3643org/erc-3643` | 4.1.3 | GPL-3.0 | the ERC-3643 (T-REX) token, registries, compliance engine and factory. This is the community-governed, GPL package; it has no rule modules besides a test one, so compliance is the modular engine with no module bound |
| `@onchain-id/solidity` | 2.2.1 | ISC | ONCHAINID identities, claim issuers and the identity factory |
| `@openzeppelin/contracts`, `-upgradeable` | 4.9.6 | MIT | the base contracts of ours and of T-REX |
| `ethers` | 6.16.0 | MIT | the deploy and the driver |
| `@redstone-finance/evm-connector`, `-sdk`, `-protocol` | 0.9.0 | **Business Source License 1.1** for the whole packages, the connector contracts and the JS `sdk` client alike (the `package.json` of each says MIT, but the `LICENSE` file of each is BUSL-1.1, licensor Distributed Data Labs, and 17 contracts, the consumer base `PrimaryProdDataServiceConsumerBase` among them, carry `SPDX BUSL-1.1`) | the oracle consumer's base contract, and the client that fetches and packs signed prices. **Non-production use only**: `PriceVault` inherits the base, so it is BUSL-bound too, and the sdk is BUSL-bound when it runs; a production chain needs a licence from RedStone |
| `@taceo/merces1-client` | 1.0.1 | MIT | Merces proofs on the sending machine (only its proof functions are used) |
| `snarkjs`, `ffjavascript`, `r1csfile`, `fastfile`, `wasmbuilder`, `wasmcurves` | as locked | GPL-3.0 | what `@taceo/merces1-client` needs to make Groth16 proofs; installed by `npm ci`, never copied here |
| TACEO's Merces contracts and client (`TaceoLabs/merces1-x402`) | commit in `PINS` | TACEO's own licence is MIT, as the SPDX header of each contract says; the repository has no `LICENSE` file, so the header is all there is | the Merces contracts, fetched with `./run.sh merces-fetch` and compiled in place (`third_party/`, ignored by git) |

The GPL contracts are compiled into the bytecode that is deployed (so are RedStone's BUSL contracts, in `PriceVault`); their sources are never copied into this repository. Anyone who runs the kit gets them from npm. The explorer's verification stores the source of each deployed contract, GPL ones included, which their licence allows.

**The Uniswap pair hash.** The router finds a pair by CREATE2 with a hash of the pair's creation code written into its library. That hash belongs to the original build of the pair; our build is not byte for byte the same. `scripts/prepare.mjs` reads the pair's code from the first build, writes a copy of the router and its library into `contracts/gen/` (git ignores it) with the hash of our pair, and the second build compiles that. `run.sh build` stops if the pair code differs between the two builds. The pair's solc 0.5.16 output ends with a source hash that depends on the build settings, so the factory and the router of one deploy must come from the same build: after changing anything in `foundry.toml` or the packages, deploy a new factory and router together (this is why the example run below has a second Uniswap set). The metadata hash does not move the pair: solc 0.5.16 always carries its own hash, so the pair's code (and its init code hash) is the same with this setting as without it.

## Verification

`./run.sh verify` sends every contract to the explorer with `forge verify-contract --verifier etherscan` and asks `/api/contracts/<address>` afterwards. The explorer takes 30 verifications an hour from one client, so the step waits about two minutes between submissions (copies made by a factory, such as the pairs and the identity proxies, share the code of the first and are matched by it). `./run.sh node scripts/verify.mjs check` prints which contracts are verified without submitting anything.

**Full matches.** The explorer calls a match full when the compiled code and the metadata hash at its end are the same as on chain; with only the code the same it is partial. So the kit builds with the metadata hash that Foundry puts in by default (`foundry.toml`, and Merces's own project has it too), and a contract that is deployed and verified from one build is a full match. The same source, compiler and settings give the same hash. The Uniswap pair is a separate matter: it is solc 0.5.16, which always carries its own hash, so its code is the same as before this change (`run.sh build` checks that the pair code is the same in its two passes, and on a clean clone it equals the pair deployed on DevNet). The one thing that would make a match partial again is a change in what the hash covers: the library addresses go into the compiler settings, so `run.sh verify` does not send them (the code has holes where the libraries go, and the explorer reads the addresses from the chain). For full matches, deploy into a new `RUN_DIR`: `run.sh deploy` reuses every contract recorded in an existing one, so a folder from the build without the hash keeps its partial contracts (their code can never become a full match). `run.sh verify` ends with `verify.mjs check`, which prints a line `SUMMARY full …, similar …, partial …, unverified …` and exits 1 if a contract is unverified or only partial (`ALLOW_PARTIAL=1` makes partial a warning, for such an old folder; `RESUBMIT_PARTIAL=1` sends a partial contract again).

The explorer's front proxy takes 300 KB a request. Forge's url-encoded body for `Merces` (23 source files, 265 KB of standard JSON) is 450 KB and gets `413`; `run.sh verify` then sends the same input to the explorer's JSON route (`POST /api/verify`, `scripts/verify-large.mjs`, 265 KB) and that passes.

**ERC-3643 calls on the explorer.** The T-REX token, identity registry and the ONCHAINID identities are proxies of one kind: they keep the address of an implementation authority in a fixed slot and ask it, at each call, for the implementation (`getTokenImplementation()`, `getIRImplementation()` and so on; `getImplementation()` for an identity). The explorer follows them (kind `trex`, the authority in `beacon`, which the contract page labels as the implementation authority) from the change that closed this gap on, so inputs of `transfer`, `batchMint`, `batchRegisterIdentity` and `addClaim` on them show as decoded methods. The run of 2026-10-24 was read before that change, when they showed as raw data (see the results).

The explorer's contract list sorts by interactions. The partial contracts of the run of 24 October carried the hour of traffic, so they stay on top and a reader sees mostly partial matches first. The contracts of a run from this build are full or similar; the old set stays partial and ranks first by traffic until the new set carries load.

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

**What happened in the example run: the vault recorded no price.** `PriceVault` is deployed and verified (block 97) and its one transaction is its creation. The driver asked RedStone's gateways 80 times during the hour and got signed prices 0 times, so it sent no `record` call (about 120 were planned), and no price was read from the vault. RedStone's public gateways reject anonymous requests (`public_gateway_rejected`, HTTP 403). To get prices, the oracle needs a data-service access arrangement with RedStone (a gateway address and API key); none is part of this kit and none was used. The wording "RedStone `record` calls" in the driver's mix is a kind that was planned and could not be built, not one that ran.

RedStone is switching its public gateways off: they refuse requests in windows that grow each day and stop for good on 2026-10-29. A refused request is tried again every 45 seconds for `REDSTONE_WAIT_MIN` minutes (default 30). After that date the step needs a RedStone gateway and an API key, wired into `scripts/oracle.mjs` through the SDK's `authenticatedGateways`; that has not been built or tried.

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

`scripts/load.mjs` makes 200 test wallets (keys in `$RUN_DIR/keys/wallets.json`, 0600), gives each 30 tROME, 3,000 tUSD and 4 tETH (through the `Seeder` contract, 20 wallets per transaction), and sends the mix in `config.json`, phase by phase: 2, 3, 4 and 4.5 transactions a second for ten minutes each, then twenty minutes at the best of the rates tried (4.5 a second in the example run, held there by one client's RPC budget, not by the chain), then a drain of up to ten minutes. The kinds, with their weights: ERC-20 transfers and approvals, wrap and unwrap of tROME, swaps both ways in both pools, adding and removing liquidity, ERC-721 mint and transfer, ERC-1155 mint, batch mint, transfer and batch transfer, ERC-3643 transfers (and a refused one), RedStone `record` calls (planned only when a fresh signed price exists; in the example run none did, so none was sent), Merces deposits and private transfers, and deliberate reverts (an ERC-20 amount over balance, unwrapping more than held, a bad ERC-1155 id and so on). Transactions are signed by the driver, nonces are counted by it, and every transaction is followed until it is in a final block.

Everything goes to the public RPC like any user, under its limit of 300 calls a minute (the driver keeps to 285, retries included). `./run.sh load calibrate` first sends one action of each kind, one at a time, to learn the gas of each; `./run.sh load check-reverts` sends nothing and asks the chain (`eth_call`) whether each deliberate-revert case really reverts, the swap case for its own reason with a control that goes through; `./run.sh load report <name>` reads the run's log, `/api/blocks`, `/api/canton/updates` and the receipts, and writes `report.json` and `report.md`. The report lists counts by kind (sent, final, succeeded, reverted), deliberate and unexpected reverts, lost transactions and refusals by reason, kinds that were skipped, time to final by phase and by block size, proof and commit times, Canton bytes per block, the RedStone and Merces results and the RPC use.

The hour that was run, and what it measured, is in [`RESULTS-2026-10-24.md`](RESULTS-2026-10-24.md).

## An example run

On Ostia DevNet (chain 770101), 24 October 2026. The deployer account is `0x5156D75f11D49990ae94Df0C92aFb7288be9FcBe`. It was funded with 20,000 tROME in one transfer, [`0x8f0926d20c71ff7f7be6a430f3e21da6b29dc3dd7f610257d21c179f8ac5ae58`](https://ostia.devnet.romeprotocol.xyz/tx/0x8f0926d20c71ff7f7be6a430f3e21da6b29dc3dd7f610257d21c179f8ac5ae58), sent from the faucet's account by Rome on the machine that runs the chain's services (the faucet service itself gives 1 tROME a day); the transfer went through the public RPC.

**What is left over, on purpose not hidden.** The deploy was run more than once on the way, and the chain keeps every contract:

- A second `UniswapV2Factory` (block 44) and a `UniswapV2Router02` (block 45) from the first attempt; the router was built with the original Uniswap pair hash and never worked, and the router is unverified.
- The first `WtROME` (block 35) was a line-for-line port of Dapphub's WETH9, which is GPL-3.0-or-later, labelled Apache-2.0 by mistake. It is replaced by the wrapper on OpenZeppelin's ERC20 in this folder, deployed again (block 178 on) with its own factory, router and two pools before the hour-long traffic started; the old `WtROME`, factory, router and pools are in the table "Deployed and not used" and nothing calls them. A first try of the new set against the old factory also left one router that cannot work (the factory's pair code came from a different build, see the pair hash above).
- The explorer used to show the first `WtROME`'s source (`0xf5df8b56…2fb9`) as verified, labelled Apache-2.0. On 2026-10-24 Rome removed that verified-source record from the explorer, so the contract now shows as unverified; the file was never on `main`.

**Verification result.** Every contract in use shows `verified: true` at `/api/contracts/<address>`. Matches are full, similar (copies made by a factory share the code of the first) or partial (only the metadata differs). The partial ones are the contracts of that run, which was built without the metadata hash, and they stay partial: code built without the hash can never be a full match. The kit now builds with the hash (see Verification), and a run from that build, listed in [A run from the build with the hash](#a-run-from-the-build-with-the-hash) below, shows no partial contract. `Merces` was partial for another reason, also fixed: the library addresses had been sent with it, and `Merces` is full in the new run (and was changed to full in the old one by sending it again without them). Verified through the explorer's Etherscan API, paced under its 30 an hour; `Merces` through its JSON route (see Verification).

### Contracts in use

| Contract | Address | Created in block | Creation transaction |
|---|---|---:|---|
| tUSD | [`0x136c750aE42Be4A24517669745467e48416c1998`](https://ostia.devnet.romeprotocol.xyz/address/0x136c750aE42Be4A24517669745467e48416c1998) | 33 | [`0xfab788c9…`](https://ostia.devnet.romeprotocol.xyz/tx/0xfab788c95ebe94709559727a936c150cd8bd9437d60f03e2ec772b49cb49943f) |
| tETH | [`0x8059Cf87A3c71C0DB15FF44C38736Ab1863ec26B`](https://ostia.devnet.romeprotocol.xyz/address/0x8059Cf87A3c71C0DB15FF44C38736Ab1863ec26B) | 34 | [`0x54d2a08e…`](https://ostia.devnet.romeprotocol.xyz/tx/0x54d2a08ea352e86b62f1d6afe6aa09c9a36f3acf8fe58c8264d3356212d1cb1a) |
| OstiaPass | [`0xC4a8BeFA855feB37D676361D010589932dF2086d`](https://ostia.devnet.romeprotocol.xyz/address/0xC4a8BeFA855feB37D676361D010589932dF2086d) | 36 | [`0x4e85e38e…`](https://ostia.devnet.romeprotocol.xyz/tx/0x4e85e38e3fb81da7ced4944ee31b6e8f5133c9ffe0ec18665be6137394f9ace5) |
| OstiaItems | [`0x0396bffF6AdA6bbae060E14200527E81937B90B0`](https://ostia.devnet.romeprotocol.xyz/address/0x0396bffF6AdA6bbae060E14200527E81937B90B0) | 37 | [`0xce9a4eda…`](https://ostia.devnet.romeprotocol.xyz/tx/0xce9a4eda4359c150a950dcc0dcb418658941b07e5ec3cec7587b8044127ec0cc) |
| ONCHAINID Identity (library) | [`0xFFfFa401d1F65289Da7f990602085d43a0F32951`](https://ostia.devnet.romeprotocol.xyz/address/0xFFfFa401d1F65289Da7f990602085d43a0F32951) | 56 | [`0x6dd7f26d…`](https://ostia.devnet.romeprotocol.xyz/tx/0x6dd7f26d9b540a7d68dd89ff7515032e0465e951f9451d2e1de4e051c1a2aaf6) |
| ONCHAINID ImplementationAuthority | [`0x99A964fbA787BB6aaC61904C6F49C7F1A06dA84e`](https://ostia.devnet.romeprotocol.xyz/address/0x99A964fbA787BB6aaC61904C6F49C7F1A06dA84e) | 57 | [`0xa569869a…`](https://ostia.devnet.romeprotocol.xyz/tx/0xa569869a0d04a16b0578044325c3ddeeb51673d68877bcab56cabac4bcc17ae5) |
| ONCHAINID IdFactory | [`0xC945d3fB67A344B0aa0303DBE557C81ABb55D5d6`](https://ostia.devnet.romeprotocol.xyz/address/0xC945d3fB67A344B0aa0303DBE557C81ABb55D5d6) | 58 | [`0xb1a33f2f…`](https://ostia.devnet.romeprotocol.xyz/tx/0xb1a33f2f28ed3a4cb196fab76f62cde8936d71e4ca7ba98f9787c5305bbb9db4) |
| T-REX Token (implementation) | [`0xEA82f9eb88e06bE8967846084abec90027c39d3e`](https://ostia.devnet.romeprotocol.xyz/address/0xEA82f9eb88e06bE8967846084abec90027c39d3e) | 59 | [`0x664c9f5a…`](https://ostia.devnet.romeprotocol.xyz/tx/0x664c9f5a6d2fc1a0084a31724758634fda2e533693b114166ee4a1f1e5cdf943) |
| T-REX ClaimTopicsRegistry (implementation) | [`0xd029c3075f72C31eB2b2F818299B8C905DC532cF`](https://ostia.devnet.romeprotocol.xyz/address/0xd029c3075f72C31eB2b2F818299B8C905DC532cF) | 60 | [`0xcc5b1952…`](https://ostia.devnet.romeprotocol.xyz/tx/0xcc5b1952ca6e79c83d3966f8eac2bbaa4458f49572da33243b1c27faa71a8959) |
| T-REX IdentityRegistry (implementation) | [`0xf695a79ab373Ef4d88ae196F92f9379FAb403020`](https://ostia.devnet.romeprotocol.xyz/address/0xf695a79ab373Ef4d88ae196F92f9379FAb403020) | 61 | [`0x8370ea50…`](https://ostia.devnet.romeprotocol.xyz/tx/0x8370ea504fc8d754096b74d7bd47ec7a6ef5fd69f617cc264d15a5307a6fa018) |
| T-REX IdentityRegistryStorage (implementation) | [`0x9418d2B801e070d07fFfb9ce7ED4126FB771715A`](https://ostia.devnet.romeprotocol.xyz/address/0x9418d2B801e070d07fFfb9ce7ED4126FB771715A) | 62 | [`0x412d2052…`](https://ostia.devnet.romeprotocol.xyz/tx/0x412d2052efdc40fec33b1f8caf40eae1fc207d48c0bd7418812565baed54f819) |
| T-REX TrustedIssuersRegistry (implementation) | [`0x80F45f55Ea3d08A56E01E436acA4E051a7635eFb`](https://ostia.devnet.romeprotocol.xyz/address/0x80F45f55Ea3d08A56E01E436acA4E051a7635eFb) | 63 | [`0xca08a9c8…`](https://ostia.devnet.romeprotocol.xyz/tx/0xca08a9c8187d8fa91786c44ed5ecaf6977bc5c6e5522631972351a86d3cb904a) |
| T-REX ModularCompliance (implementation) | [`0x702EA79875d47ab3EE02Df906517e646960FAfa6`](https://ostia.devnet.romeprotocol.xyz/address/0x702EA79875d47ab3EE02Df906517e646960FAfa6) | 64 | [`0x8e3f37b1…`](https://ostia.devnet.romeprotocol.xyz/tx/0x8e3f37b129b6aa4584014c8f33fff998a3d02ea1aaa5502799ae49a2d5356a2d) |
| T-REX TREXImplementationAuthority | [`0xaFa12D376Cc34a3d4Dd6dfFd04348512B5175196`](https://ostia.devnet.romeprotocol.xyz/address/0xaFa12D376Cc34a3d4Dd6dfFd04348512B5175196) | 65 | [`0x8b668fc0…`](https://ostia.devnet.romeprotocol.xyz/tx/0x8b668fc0bc6eaa472eec028bf78bcab8838869c4d75c7616701c94dd3da80f2c) |
| T-REX TREXFactory | [`0xee850E54a392cc30376C5F365E54C20cd4422A26`](https://ostia.devnet.romeprotocol.xyz/address/0xee850E54a392cc30376C5F365E54C20cd4422A26) | 67 | [`0x04456356…`](https://ostia.devnet.romeprotocol.xyz/tx/0x044563562703cbe4583028fec4cc284ee1484b3674d1574ccfedf1f3035dc6a2) |
| ONCHAINID ClaimIssuer | [`0xB9Df14F0d85a5C0846507Eba82649635ce666e32`](https://ostia.devnet.romeprotocol.xyz/address/0xB9Df14F0d85a5C0846507Eba82649635ce666e32) | 70 | [`0x3c473851…`](https://ostia.devnet.romeprotocol.xyz/tx/0x3c4738517485238b8b0a45e7df3e203df932c33838b9dbe57193ab81a446e29f) |
| T-REX Token (proxy) | [`0xbaB81a03045E55E7dF67863A1d39457c22042a7b`](https://ostia.devnet.romeprotocol.xyz/address/0xbaB81a03045E55E7dF67863A1d39457c22042a7b) |  | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| T-REX IdentityRegistry (proxy) | [`0x78F46A6E6a5BbD455c55Ea5764A2865Df863b88a`](https://ostia.devnet.romeprotocol.xyz/address/0x78F46A6E6a5BbD455c55Ea5764A2865Df863b88a) |  | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| T-REX ModularCompliance (proxy) | [`0xd88B380e97B65Bb5934e411DBD5025B11065e2C0`](https://ostia.devnet.romeprotocol.xyz/address/0xd88B380e97B65Bb5934e411DBD5025B11065e2C0) |  | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| T-REX IdentityRegistryStorage (proxy) | [`0x69f6C537472516185A2d783FE6c9d6562d3A7608`](https://ostia.devnet.romeprotocol.xyz/address/0x69f6C537472516185A2d783FE6c9d6562d3A7608) |  | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| T-REX TrustedIssuersRegistry (proxy) | [`0x88fDf9D4f8d84e3c4488c0F85B78dEbD5663aAd1`](https://ostia.devnet.romeprotocol.xyz/address/0x88fDf9D4f8d84e3c4488c0F85B78dEbD5663aAd1) |  | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| T-REX ClaimTopicsRegistry (proxy) | [`0xAddf2A2777Cf011289EC7F8c5B155641488F92b2`](https://ostia.devnet.romeprotocol.xyz/address/0xAddf2A2777Cf011289EC7F8c5B155641488F92b2) |  | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| T-REX token ONCHAINID (proxy) | [`0xfF35e391223d0C25Ff853F28F1e63cFDfE67C365`](https://ostia.devnet.romeprotocol.xyz/address/0xfF35e391223d0C25Ff853F28F1e63cFDfE67C365) |  | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| ONCHAINID identity holder1 (proxy) | [`0xBD3bd3948e5C7B68A7E8A7EcC6660c29c21E7848`](https://ostia.devnet.romeprotocol.xyz/address/0xBD3bd3948e5C7B68A7E8A7EcC6660c29c21E7848) |  | [`0xf5fa8417…`](https://ostia.devnet.romeprotocol.xyz/tx/0xf5fa8417179cd54544b20b5d57b93f74a351ce42ff5be4137a02a9c81ed5f022) |
| ONCHAINID identity holder2 (proxy) | [`0x00745f1d55eF580429806E9e60B64859b5B54B28`](https://ostia.devnet.romeprotocol.xyz/address/0x00745f1d55eF580429806E9e60B64859b5B54B28) |  | [`0x2647a7cd…`](https://ostia.devnet.romeprotocol.xyz/tx/0x2647a7cd3d9861602fba946c6b1e27aed202e4b7206d819b22fda2508aeac531) |
| ONCHAINID identity holder3 (proxy) | [`0xeFb27D5Ff8BA2faaa71bEBe41cebaABcD81d8df0`](https://ostia.devnet.romeprotocol.xyz/address/0xeFb27D5Ff8BA2faaa71bEBe41cebaABcD81d8df0) |  | [`0x248efbb7…`](https://ostia.devnet.romeprotocol.xyz/tx/0x248efbb7292daab58f8486f20fb35912325160a961ee0436edd457fadc19e97a) |
| ONCHAINID identity holder4 (proxy) | [`0xC06439a88B02b891F30c0BCa2b796847CA15377A`](https://ostia.devnet.romeprotocol.xyz/address/0xC06439a88B02b891F30c0BCa2b796847CA15377A) |  | [`0xb35bd3e6…`](https://ostia.devnet.romeprotocol.xyz/tx/0xb35bd3e602b6568e5983c32e8c899279da6e0ca6a44b94b93b75bf6945f892f1) |
| PriceVault | [`0xe925B34bCbaC24710353B3EF9331E88BF7329F6e`](https://ostia.devnet.romeprotocol.xyz/address/0xe925B34bCbaC24710353B3EF9331E88BF7329F6e) | 97 | [`0x5c9c2c3b…`](https://ostia.devnet.romeprotocol.xyz/tx/0x5c9c2c3b3b6ec1a2c9879a75a78ffc28065b08dc8443eb365713c69ed81b50cc) |
| Merces ClientVerifier | [`0x97E76855fEdD75c90C1767A6F3Df6889e57F1603`](https://ostia.devnet.romeprotocol.xyz/address/0x97E76855fEdD75c90C1767A6F3Df6889e57F1603) | 104 | [`0x2a3b0a65…`](https://ostia.devnet.romeprotocol.xyz/tx/0x2a3b0a65e113b91eb3b8b30f05649f6ee0ebff219e54c3877d8d7d44ff9e14f7) |
| Merces ServerVerifier | [`0x742221c74E939d6CB167a36265b08abC822F4A44`](https://ostia.devnet.romeprotocol.xyz/address/0x742221c74E939d6CB167a36265b08abC822F4A44) | 105 | [`0xa6080e1a…`](https://ostia.devnet.romeprotocol.xyz/tx/0xa6080e1a0a25c8032dab3d9ed133d5fcbacec92afe6dabfa3242c03922caf40f) |
| Merces library BabyJubJub | [`0x1Ac83ef05A923CE683823BdF89400AcE43689D9C`](https://ostia.devnet.romeprotocol.xyz/address/0x1Ac83ef05A923CE683823BdF89400AcE43689D9C) | 106 | [`0x98ca300a…`](https://ostia.devnet.romeprotocol.xyz/tx/0x98ca300ab552a521308ebfb178a31c00abe1f69d2155c810d9e2a5462b8b11cf) |
| Merces library ActionQueueLib | [`0x68FeF7f5b3a0Caeb390f43896d09eAA619B9adAD`](https://ostia.devnet.romeprotocol.xyz/address/0x68FeF7f5b3a0Caeb390f43896d09eAA619B9adAD) | 107 | [`0x7257958a…`](https://ostia.devnet.romeprotocol.xyz/tx/0x7257958aac39b2f74112bcdf96364a64d9627497345b227bc12c8d2fa5906a85) |
| Merces library Poseidon2T2_BN254 | [`0xC46a882112cDD9b26d9924aEE4263E3D978Cb8Cd`](https://ostia.devnet.romeprotocol.xyz/address/0xC46a882112cDD9b26d9924aEE4263E3D978Cb8Cd) | 108 | [`0x97ae780c…`](https://ostia.devnet.romeprotocol.xyz/tx/0x97ae780cbdace8ecc4d33a6718be61d99b28c9ee927de024fdd600a4e999f169) |
| Merces | [`0x4AB4c952560e5feb8cCf7aC88071255eb3aa0b7c`](https://ostia.devnet.romeprotocol.xyz/address/0x4AB4c952560e5feb8cCf7aC88071255eb3aa0b7c) | 109 | [`0x9a937293…`](https://ostia.devnet.romeprotocol.xyz/tx/0x9a937293763c28542613a50bf6fa0eaeff92af2042a3da00a03fbb9b6af4c9d1) |
| Seeder | [`0xFd5F57CD7Af2d5038C27b2b0f3706D0d1BAba39d`](https://ostia.devnet.romeprotocol.xyz/address/0xFd5F57CD7Af2d5038C27b2b0f3706D0d1BAba39d) | 130 | [`0x9f17d20c…`](https://ostia.devnet.romeprotocol.xyz/tx/0x9f17d20c5a8397420fc4bb77d47caa3d29bb865f7620adb01465a6fd26d940ae) |
| WtROME | [`0xC9cCEcB19639aC7a447d1BAD0E41291898673357`](https://ostia.devnet.romeprotocol.xyz/address/0xC9cCEcB19639aC7a447d1BAD0E41291898673357) | 178 | [`0xab7e6da4…`](https://ostia.devnet.romeprotocol.xyz/tx/0xab7e6da4a3c3d7af7e011b8de69a7951c98ea0fa69b396b775673df89b5e469e) |
| UniswapV2Factory | [`0xA8d3182e701825211288650176103b76a24D44a9`](https://ostia.devnet.romeprotocol.xyz/address/0xA8d3182e701825211288650176103b76a24D44a9) | 184 | [`0x417a5943…`](https://ostia.devnet.romeprotocol.xyz/tx/0x417a5943b4ce71ac743946fb56cfe450381eeeb2ade43bff2e29e350ce785d2d) |
| UniswapV2Router02 | [`0x577cB26dc9752B22A52e92039A4942E509d02946`](https://ostia.devnet.romeprotocol.xyz/address/0x577cB26dc9752B22A52e92039A4942E509d02946) | 185 | [`0xaf3a3564…`](https://ostia.devnet.romeprotocol.xyz/tx/0xaf3a3564cbb17438180c14ec396bed318da764cda0db105512ce347f22a1a047) |
| UniswapV2Pair tUSD/WtROME | [`0x986D673e0B663C193C868E0Da7358d81cE47EF49`](https://ostia.devnet.romeprotocol.xyz/address/0x986D673e0B663C193C868E0Da7358d81cE47EF49) |  | [`0x61d44dd7…`](https://ostia.devnet.romeprotocol.xyz/tx/0x61d44dd7ac1a3c15e1f0b0f1c5f18ec9849abc2b3869d27b97bb31b72ed1a463) |
| UniswapV2Pair tETH/tUSD | [`0x62456a59B0628718871b82567C3F6368B8903BDe`](https://ostia.devnet.romeprotocol.xyz/address/0x62456a59B0628718871b82567C3F6368B8903BDe) |  | [`0x3043d32b…`](https://ostia.devnet.romeprotocol.xyz/tx/0x3043d32bd174931ef158923850df2670974e32fd5c9a09731c2df5e76edc2e67) |

### Deployed and not used

Left on the chain by earlier runs of the deploy (see the notes above); nothing in the mix calls them.

| Contract | Address | Created in block | Creation transaction |
|---|---|---:|---|
| UniswapV2Factory (first deploy, a second copy) | [`0x3633612e17c775d5cc8de2bc59552cd10cd88bbc`](https://ostia.devnet.romeprotocol.xyz/address/0x3633612e17c775d5cc8de2bc59552cd10cd88bbc) | 44 | [`0xa0336765…`](https://ostia.devnet.romeprotocol.xyz/tx/0xa033676514385cbaaba5aacfbb5dea3d65297219f508d2677e4f8fa463e903ec) |
| UniswapV2Router02 (first deploy, built with the original pair hash) | [`0x0b1732eea1c0d74639e43f5544f1ce45fba15f94`](https://ostia.devnet.romeprotocol.xyz/address/0x0b1732eea1c0d74639e43f5544f1ce45fba15f94) | 45 | [`0x2302353c…`](https://ostia.devnet.romeprotocol.xyz/tx/0x2302353cec173d9546943f7a2b927d7fb524bb925a1b0d4f0238730760015e9a) |
| WtROME | [`0xF5Df8B5632f3F0d6D4E0A12B6AB6EdEFb0782Fb9`](https://ostia.devnet.romeprotocol.xyz/address/0xF5Df8B5632f3F0d6D4E0A12B6AB6EdEFb0782Fb9) | 35 | [`0x81a96320…`](https://ostia.devnet.romeprotocol.xyz/tx/0x81a963201fbaa311261b2f9171d1ce6531428a3510e70716bcdcd57c5bf19f9a) |
| UniswapV2Router02 | [`0x2B65d3b4EF99d9f5848d692D9e935Ab6ad3591F6`](https://ostia.devnet.romeprotocol.xyz/address/0x2B65d3b4EF99d9f5848d692D9e935Ab6ad3591F6) | 50 | [`0x50312405…`](https://ostia.devnet.romeprotocol.xyz/tx/0x50312405c25b2512760078dc74e6833126b197f0d7e8290daaba3d31ae0fdbef) |
| UniswapV2Pair tUSD/WtROME | [`0x2F8B1fF26664e571ED459CeF6CF1B15757C63642`](https://ostia.devnet.romeprotocol.xyz/address/0x2F8B1fF26664e571ED459CeF6CF1B15757C63642) |  | [`0x3a72a606…`](https://ostia.devnet.romeprotocol.xyz/tx/0x3a72a6062fdc53d31389437efd0d3311318a9944baf512f39ba63e5d719105ed) |
| UniswapV2Factory | [`0x7480937c18f6cfff1D3Eea249a9aCDcb1f6b0d07`](https://ostia.devnet.romeprotocol.xyz/address/0x7480937c18f6cfff1D3Eea249a9aCDcb1f6b0d07) | 43 | [`0x83cc2300…`](https://ostia.devnet.romeprotocol.xyz/tx/0x83cc230012866e6e9fb57aea17c2fdea3c30a0ba194184c64f4d37912b1cc1c1) |
| UniswapV2Router02 (2) | [`0xf0953083fD95f3e0218360232728308640f7f383`](https://ostia.devnet.romeprotocol.xyz/address/0xf0953083fD95f3e0218360232728308640f7f383) | 179 | [`0x93949d95…`](https://ostia.devnet.romeprotocol.xyz/tx/0x93949d95a3c0994518528738a524db1c40fe2004953ee68d953a74f111ecee48) |
| UniswapV2Pair tETH/tUSD | [`0x1fec029c0124BdB6C0e822f7641E2365C93c04A8`](https://ostia.devnet.romeprotocol.xyz/address/0x1fec029c0124BdB6C0e822f7641E2365C93c04A8) |  | [`0x47eb6736…`](https://ostia.devnet.romeprotocol.xyz/tx/0x47eb6736ad973eb96a83ae441399f6b063f11a3c861cf5008cf3344c191633a4) |

### Deploy steps

| Step | Transaction |
|---|---|
| mint-tUSD | [`0xf62cfa5a1aadd2fa5bd2a8b7aaeee90e201575685119d9afc3a42561ebd5f381`](https://ostia.devnet.romeprotocol.xyz/tx/0xf62cfa5a1aadd2fa5bd2a8b7aaeee90e201575685119d9afc3a42561ebd5f381) |
| mint-tETH | [`0x018797564b22991284d3b4e85c9d1395348ea52bb35927295719e8a544c2ec73`](https://ostia.devnet.romeprotocol.xyz/tx/0x018797564b22991284d3b4e85c9d1395348ea52bb35927295719e8a544c2ec73) |
| mint-pass-1 | [`0x74920a216cf12b672111c52e102ac991f538ee98d0bea41e1efbd4c5d568ae75`](https://ostia.devnet.romeprotocol.xyz/tx/0x74920a216cf12b672111c52e102ac991f538ee98d0bea41e1efbd4c5d568ae75) |
| mint-items-batch | [`0xbf6097c83d9e8d4e31eb7e069322f7bcc993333ad9df11e0db669e9e1b88e7f2`](https://ostia.devnet.romeprotocol.xyz/tx/0xbf6097c83d9e8d4e31eb7e069322f7bcc993333ad9df11e0db669e9e1b88e7f2) |
| trex-version | [`0xe4c1f768082870bf0fa15f9adcaed32073833117c185e6a75ebe8e9b29754f91`](https://ostia.devnet.romeprotocol.xyz/tx/0xe4c1f768082870bf0fa15f9adcaed32073833117c185e6a75ebe8e9b29754f91) |
| trex-ia-factory | [`0x1013518c8e5359bea334f69601f4b5222ac631bbe645a9d5a3dc2ccc388bec97`](https://ostia.devnet.romeprotocol.xyz/tx/0x1013518c8e5359bea334f69601f4b5222ac631bbe645a9d5a3dc2ccc388bec97) |
| idfactory-token-factory | [`0x0916fc20efa8bb30ed97c953a5fb118e7e398cb56a8fc6c0eda0d56f2bc172cc`](https://ostia.devnet.romeprotocol.xyz/tx/0x0916fc20efa8bb30ed97c953a5fb118e7e398cb56a8fc6c0eda0d56f2bc172cc) |
| issuer-claim-key | [`0x7b1cfd55d3b5f2c945b54656b5c98ebdceaf290b64e3a4e72137b263caae9068`](https://ostia.devnet.romeprotocol.xyz/tx/0x7b1cfd55d3b5f2c945b54656b5c98ebdceaf290b64e3a4e72137b263caae9068) |
| trex-suite | [`0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| identity-holder1 | [`0xf5fa8417179cd54544b20b5d57b93f74a351ce42ff5be4137a02a9c81ed5f022`](https://ostia.devnet.romeprotocol.xyz/tx/0xf5fa8417179cd54544b20b5d57b93f74a351ce42ff5be4137a02a9c81ed5f022) |
| claim-holder1 | [`0x34f32f2164a62b94802a8397ae897e8f8e62d34321749129cafed15847b5dda0`](https://ostia.devnet.romeprotocol.xyz/tx/0x34f32f2164a62b94802a8397ae897e8f8e62d34321749129cafed15847b5dda0) |
| identity-holder2 | [`0x2647a7cd3d9861602fba946c6b1e27aed202e4b7206d819b22fda2508aeac531`](https://ostia.devnet.romeprotocol.xyz/tx/0x2647a7cd3d9861602fba946c6b1e27aed202e4b7206d819b22fda2508aeac531) |
| claim-holder2 | [`0x9747d8a0321bb8ac46d4dfd7a201b56247346e4134fddfdd6792df31aa2bf015`](https://ostia.devnet.romeprotocol.xyz/tx/0x9747d8a0321bb8ac46d4dfd7a201b56247346e4134fddfdd6792df31aa2bf015) |
| identity-holder3 | [`0x248efbb7292daab58f8486f20fb35912325160a961ee0436edd457fadc19e97a`](https://ostia.devnet.romeprotocol.xyz/tx/0x248efbb7292daab58f8486f20fb35912325160a961ee0436edd457fadc19e97a) |
| claim-holder3 | [`0xe64eb6892f04cf2379bb9937a7bff5e2ae48fa46e1da7f5d344cdcf0f4b601c4`](https://ostia.devnet.romeprotocol.xyz/tx/0xe64eb6892f04cf2379bb9937a7bff5e2ae48fa46e1da7f5d344cdcf0f4b601c4) |
| identity-holder4 | [`0xb35bd3e602b6568e5983c32e8c899279da6e0ca6a44b94b93b75bf6945f892f1`](https://ostia.devnet.romeprotocol.xyz/tx/0xb35bd3e602b6568e5983c32e8c899279da6e0ca6a44b94b93b75bf6945f892f1) |
| claim-holder4 | [`0x779541a2b840e32d88657a82a1b1e5d806e0ece19364bb4f922105214cf3fcb0`](https://ostia.devnet.romeprotocol.xyz/tx/0x779541a2b840e32d88657a82a1b1e5d806e0ece19364bb4f922105214cf3fcb0) |
| register-holders | [`0xe04e957e782c7fa8eaf5d24197d86ffd5cf5468448e46dbcab4dd2728e4d12df`](https://ostia.devnet.romeprotocol.xyz/tx/0xe04e957e782c7fa8eaf5d24197d86ffd5cf5468448e46dbcab4dd2728e4d12df) |
| mint-ogb | [`0xd3fde8a7b8b46ea2a608c7a575ada9ba1a2361a68f5670bd059e6bfa83a56990`](https://ostia.devnet.romeprotocol.xyz/tx/0xd3fde8a7b8b46ea2a608c7a575ada9ba1a2361a68f5670bd059e6bfa83a56990) |
| gas-holder1 | [`0xa9dae5b016f528bd620b7ba013e8c85338f6f1237d2969d54b828f40fac91f23`](https://ostia.devnet.romeprotocol.xyz/tx/0xa9dae5b016f528bd620b7ba013e8c85338f6f1237d2969d54b828f40fac91f23) |
| gas-holder2 | [`0x0711c22d1a35f2f43ef054490f3e0f8bf949ecc207559f41704ba9b3ff5f8fb6`](https://ostia.devnet.romeprotocol.xyz/tx/0x0711c22d1a35f2f43ef054490f3e0f8bf949ecc207559f41704ba9b3ff5f8fb6) |
| gas-holder3 | [`0x9841edf0654e428e707a6eaf16ab2ca9f28c2af01e89729e5970fef2aa0b590d`](https://ostia.devnet.romeprotocol.xyz/tx/0x9841edf0654e428e707a6eaf16ab2ca9f28c2af01e89729e5970fef2aa0b590d) |
| gas-holder4 | [`0x3149353ae5515aa10bf0a9a91639238bb46524e2757665e22718f0436122404d`](https://ostia.devnet.romeprotocol.xyz/tx/0x3149353ae5515aa10bf0a9a91639238bb46524e2757665e22718f0436122404d) |
| gas-unverified | [`0xe5a0e07e7eef0d62d05b488036e245780a83d7869ce251478067899e2e5b7959`](https://ostia.devnet.romeprotocol.xyz/tx/0xe5a0e07e7eef0d62d05b488036e245780a83d7869ce251478067899e2e5b7959) |
| fund-oracle | [`0xbc15725dd2e2c7b79072291a3616a7c5642fbbe89346ea1f1d8126aecfb76e88`](https://ostia.devnet.romeprotocol.xyz/tx/0xbc15725dd2e2c7b79072291a3616a7c5642fbbe89346ea1f1d8126aecfb76e88) |
| fund-merces-deployer | [`0xc95e26e65af0139465f25ab7fae9e5177e4810c6f5208ceb14e71aa3a6e209e1`](https://ostia.devnet.romeprotocol.xyz/tx/0xc95e26e65af0139465f25ab7fae9e5177e4810c6f5208ceb14e71aa3a6e209e1) |
| fund-merces-alice | [`0xf223572c1d2514c7362d5f12fea6e6c871f083e61022e3ff8a2d5cd1638a6fe8`](https://ostia.devnet.romeprotocol.xyz/tx/0xf223572c1d2514c7362d5f12fea6e6c871f083e61022e3ff8a2d5cd1638a6fe8) |
| fund-merces-bob | [`0x1fd81894e108644588027e6c22174ca3bd67b9991376d524aa760499335007a8`](https://ostia.devnet.romeprotocol.xyz/tx/0x1fd81894e108644588027e6c22174ca3bd67b9991376d524aa760499335007a8) |
| fund-merces-carol | [`0xacfcbef76efe8493ad376368f74e4b35e12dd00edd5ceaf3ee58c8af40d05703`](https://ostia.devnet.romeprotocol.xyz/tx/0xacfcbef76efe8493ad376368f74e4b35e12dd00edd5ceaf3ee58c8af40d05703) |
| fund-merces-dave | [`0x0b93983ff0261521edd0852972165b949bebb6d33769e4aec58fca3d18a97d9d`](https://ostia.devnet.romeprotocol.xyz/tx/0x0b93983ff0261521edd0852972165b949bebb6d33769e4aec58fca3d18a97d9d) |
| seeder-approve-tUSD | [`0x51b89f2b4dcb54dc0ee6d98f5869135ff8894262a2ae49a89c8e1f4992cd37ff`](https://ostia.devnet.romeprotocol.xyz/tx/0x51b89f2b4dcb54dc0ee6d98f5869135ff8894262a2ae49a89c8e1f4992cd37ff) |
| seeder-approve-tETH | [`0xb23dc4fd87392a181910dfe3a57f1c5639fd8796da17eb483254de94f382f387`](https://ostia.devnet.romeprotocol.xyz/tx/0xb23dc4fd87392a181910dfe3a57f1c5639fd8796da17eb483254de94f382f387) |
| seed-0 | [`0x32ed2b88ea9685345dad16e1fc4184d811a927be85efca15884b5bcb2b85939f`](https://ostia.devnet.romeprotocol.xyz/tx/0x32ed2b88ea9685345dad16e1fc4184d811a927be85efca15884b5bcb2b85939f) |
| seed-20 | [`0x153c9378b5dcc74f8d73b0602c1bea58cd7a6744e3334d2529317bf19a554639`](https://ostia.devnet.romeprotocol.xyz/tx/0x153c9378b5dcc74f8d73b0602c1bea58cd7a6744e3334d2529317bf19a554639) |
| seed-40 | [`0x382895e4ff49ac01661668560814df2b6f612dee39b2f4fd932e9a1249137d12`](https://ostia.devnet.romeprotocol.xyz/tx/0x382895e4ff49ac01661668560814df2b6f612dee39b2f4fd932e9a1249137d12) |
| seed-60 | [`0x44c888cd3c7806dcbc03a44845ebe1b0cf3cab47ceb082bfc13168172bebfcdb`](https://ostia.devnet.romeprotocol.xyz/tx/0x44c888cd3c7806dcbc03a44845ebe1b0cf3cab47ceb082bfc13168172bebfcdb) |
| seed-80 | [`0x5b70a52d156d27fe9da104b10f1d996189d36b6d5e2b5221811051a1227d7652`](https://ostia.devnet.romeprotocol.xyz/tx/0x5b70a52d156d27fe9da104b10f1d996189d36b6d5e2b5221811051a1227d7652) |
| seed-100 | [`0x45e6803f659db847127054c85b94dede9718394454e8d0fef971b0dde9eaeff8`](https://ostia.devnet.romeprotocol.xyz/tx/0x45e6803f659db847127054c85b94dede9718394454e8d0fef971b0dde9eaeff8) |
| seed-120 | [`0xea172f76cb3629de8c539e3c850dcf5cb72518112df363634da6776c9b4983b1`](https://ostia.devnet.romeprotocol.xyz/tx/0xea172f76cb3629de8c539e3c850dcf5cb72518112df363634da6776c9b4983b1) |
| seed-140 | [`0xf5317ec33098dd072ea020b618a5c694196e2fa09db5ac32989bcd7e12fd34f8`](https://ostia.devnet.romeprotocol.xyz/tx/0xf5317ec33098dd072ea020b618a5c694196e2fa09db5ac32989bcd7e12fd34f8) |
| seed-160 | [`0xd473018c8d80360f03cdf358310f2f2fa58ffc67fc86448b10cd7f377e68e4df`](https://ostia.devnet.romeprotocol.xyz/tx/0xd473018c8d80360f03cdf358310f2f2fa58ffc67fc86448b10cd7f377e68e4df) |
| seed-180 | [`0xbf87ebcce80d29ba56229ba62bee026bc7a7d9d59ee1fe8f4b9a46f997aeb370`](https://ostia.devnet.romeprotocol.xyz/tx/0xbf87ebcce80d29ba56229ba62bee026bc7a7d9d59ee1fe8f4b9a46f997aeb370) |
| wrap-trome | [`0x138e9f9b02022ec4a5954e8823e5e7afbb442ba66208736c16d013a169a2a151`](https://ostia.devnet.romeprotocol.xyz/tx/0x138e9f9b02022ec4a5954e8823e5e7afbb442ba66208736c16d013a169a2a151) |
| approve-router-tUSD | [`0x9bba579f298930c4c360204c9c3eb609394b1438ebd4d79b1ccbe2d452cdc167`](https://ostia.devnet.romeprotocol.xyz/tx/0x9bba579f298930c4c360204c9c3eb609394b1438ebd4d79b1ccbe2d452cdc167) |
| approve-router-tETH | [`0x6fb94ba3e565974f72a97f86fc0317471d30a91df8b48047af6acd7966b47ca0`](https://ostia.devnet.romeprotocol.xyz/tx/0x6fb94ba3e565974f72a97f86fc0317471d30a91df8b48047af6acd7966b47ca0) |
| approve-router-WtROME | [`0x32c70f9fb7cc628dea24cc273a5d39b816f4dcdc09a5a698f260cd507fc524ff`](https://ostia.devnet.romeprotocol.xyz/tx/0x32c70f9fb7cc628dea24cc273a5d39b816f4dcdc09a5a698f260cd507fc524ff) |
| liquidity-tUSD/WtROME | [`0x61d44dd7ac1a3c15e1f0b0f1c5f18ec9849abc2b3869d27b97bb31b72ed1a463`](https://ostia.devnet.romeprotocol.xyz/tx/0x61d44dd7ac1a3c15e1f0b0f1c5f18ec9849abc2b3869d27b97bb31b72ed1a463) |
| liquidity-tETH/tUSD | [`0x3043d32bd174931ef158923850df2670974e32fd5c9a09731c2df5e76edc2e67`](https://ostia.devnet.romeprotocol.xyz/tx/0x3043d32bd174931ef158923850df2670974e32fd5c9a09731c2df5e76edc2e67) |

### Smoke actions

| Action | Transaction |
|---|---|
| deployer mints 1,000 tUSD to holder1 | [`0x662ad5195c522505dae6103fe8656fccc60a58a6d91bcd9e336699674e786e39`](https://ostia.devnet.romeprotocol.xyz/tx/0x662ad5195c522505dae6103fe8656fccc60a58a6d91bcd9e336699674e786e39) |
| ERC-20 transfer: holder1 sends 10 tUSD to holder2 | [`0x394e023ec125b9ab7781a8b0dcf49c045567075268debd2052c041c2ebc9bbf9`](https://ostia.devnet.romeprotocol.xyz/tx/0x394e023ec125b9ab7781a8b0dcf49c045567075268debd2052c041c2ebc9bbf9) |
| ERC-721: holder1 mints an Ostia Pass | [`0xf8f5deee6ba01606faeff1fe3b4bcc9d9dd4d7ab63014395712a724d229611ac`](https://ostia.devnet.romeprotocol.xyz/tx/0xf8f5deee6ba01606faeff1fe3b4bcc9d9dd4d7ab63014395712a724d229611ac) |
| ERC-1155: holder1 mints 3 Swords and 2 Keys in one batch | [`0xc38e5e897c3dbac7712de8d76e26aca75a5625f1e255c9f94955133c63cd4ae4`](https://ostia.devnet.romeprotocol.xyz/tx/0xc38e5e897c3dbac7712de8d76e26aca75a5625f1e255c9f94955133c63cd4ae4) |
| wrap: holder1 wraps 1 tROME | [`0x2427fff98465e74d85cf652c2989efd8ed388d01e8cb4524dfd9633ca5fdb82c`](https://ostia.devnet.romeprotocol.xyz/tx/0x2427fff98465e74d85cf652c2989efd8ed388d01e8cb4524dfd9633ca5fdb82c) |
| approve the router for tUSD | [`0xf492b8da732675d3cc021e7a7b87fa25a0a0f203d5ebc221dc4d1cd47ac7ffc5`](https://ostia.devnet.romeprotocol.xyz/tx/0xf492b8da732675d3cc021e7a7b87fa25a0a0f203d5ebc221dc4d1cd47ac7ffc5) |
| Uniswap V2: holder1 swaps 100 tUSD for WtROME | [`0x5b534e958d77f5951dc5ef3532f91a7d6d1453cabc03468a70c0119d1da2d7c7`](https://ostia.devnet.romeprotocol.xyz/tx/0x5b534e958d77f5951dc5ef3532f91a7d6d1453cabc03468a70c0119d1da2d7c7) |
| ERC-3643: verified holder1 sends 5 OGB to verified holder2 | [`0xac0d77cd2fc4a128b77f111b10908118eac247ff183177e66e06a252ca28f7e1`](https://ostia.devnet.romeprotocol.xyz/tx/0xac0d77cd2fc4a128b77f111b10908118eac247ff183177e66e06a252ca28f7e1) |
| ERC-3643: transfer to the unverified address (a call, not sent) | Transfer not possible |

## A run from the build with the hash

On Ostia DevNet (chain 770101), 25 October 2026, from the kit's build with the metadata hash, into a new `RUN_DIR`: `./run.sh build`, `merces-fetch`, `deploy`, `smoke`, `merces.mjs deploy`, `redstone.mjs` (it deployed `PriceVault`; the gateways refused, as described above, so no price was recorded), `load seed`, then `./run.sh verify`. The contracts were created by three wallets: the deployer (the same account as above, which sent `deploy` and `load seed`: the tokens, the Uniswap contracts, ONCHAINID, T-REX, `ClaimIssuer` and the `Seeder`; the proxies and identities were made by its factories), the run's `merces-deployer` wallet (`Merces`, its three libraries and its two verifiers) and the run's `oracle` wallet (`PriceVault`). Blocks 695 to 765. Two sizes in `config.json` were smaller for this run, because the deployer held about 3,735 tROME: 1,000 tROME wrapped and a 10,000 tUSD / 1,000 WtROME pool, and 20 test wallets with 10 tROME each. The code and the compiler settings are the kit's, so the sizes do not touch the match.

`verify.mjs check` ends with `SUMMARY full 28, similar 12, partial 0, unverified 0 (of 40)` and exits 0. "Similar" is a contract whose code is the same as one the explorer already verified (the copies made by a factory, and the Uniswap and Merces contracts that the run of 24 October had verified).

| Contract | Address | Match |
|---|---|---|
| tUSD | `0x2db9AC14CD3aEd121CE2281c2978b5F2D8fD547F` | full |
| tETH | `0xC9eE0D52FAD7EfAb6fba2E580B162A312Fe88f2b` | full |
| WtROME | `0xc221fc4aF51cAA9D198E70e3cB3B8F3D9D2Adc64` | full |
| OstiaPass | `0x67d7ff1493c60dD1Bb298B64d0fe0f444352eEea` | full |
| OstiaItems | `0xCA068e06a63340CAF07f56BB7A7E199d763bB768` | full |
| UniswapV2Factory | `0xB8203531E77E74142e3F01fa2158Afc5986f91cF` | similar |
| UniswapV2Router02 | `0x4fb1D81a8D57C4a51b145ee03231f8B328ab9F9D` | full |
| UniswapV2Pair tUSD/WtROME | `0x6069d0d3adc5Af5a21979092F2d7Ef731543179F` | similar |
| UniswapV2Pair tETH/tUSD | `0xD342397b95883613b438F360760a89f8A61C8160` | similar |
| ONCHAINID Identity (library) | `0x7C6104b27e71e0397514cd1847fD359A6cE4F817` | full |
| ONCHAINID ImplementationAuthority | `0x290776AeB2B695B9516e4F6beb6B27720b93B2EE` | full |
| ONCHAINID IdFactory | `0x0b2b7835217c0D1c384e1bBb239723881B9feBe2` | full |
| T-REX Token (implementation) | `0xc1Cb0E5a8f772F7cDc18F2d16CEbB9E44E89F410` | full |
| T-REX ClaimTopicsRegistry (implementation) | `0x8a78f08Bd70e80a358069D503C67FD37D7B33CE6` | full |
| T-REX IdentityRegistry (implementation) | `0x35E8dF684511774D652691A5F72Df58CF4FB5F2B` | full |
| T-REX IdentityRegistryStorage (implementation) | `0xd38cd04BB891EA654614Fe064AC51734a2C87eD2` | full |
| T-REX TrustedIssuersRegistry (implementation) | `0x0cDAA84a5883a49830B05E25d437C5d1d166F9d7` | full |
| T-REX ModularCompliance (implementation) | `0x2515215B349FAEd51559eb3D72440f405F175A79` | full |
| T-REX TREXImplementationAuthority | `0xbdE7c517D7Ec588C47bf9fD46C363F72Fb71bcae` | full |
| T-REX TREXFactory | `0x2cFc36755d219Ea6F6802ea1c48B1D9199381f10` | full |
| ONCHAINID ClaimIssuer | `0xD1A73BffDEd476b7e21ebf7e5b0223A6074a19B2` | full |
| T-REX Token (proxy) | `0x6a5e3232513bd5912769701CdBCc172D2c700735` | full |
| T-REX IdentityRegistry (proxy) | `0xDbc89a983fCD1e17FcF5bCD8A13Bc542B86fccCE` | full |
| T-REX ModularCompliance (proxy) | `0xa89412E5c4F3A470526F5fff110DE9dFe983518E` | full |
| T-REX IdentityRegistryStorage (proxy) | `0x75f035bf38ef1A12Ff0656aaB8440EB746BA094c` | full |
| T-REX TrustedIssuersRegistry (proxy) | `0x586D3DEc998802530aCF73560673343cdc56610B` | full |
| T-REX ClaimTopicsRegistry (proxy) | `0x6C6654f1949fADDE40A9aCcc635043c9cA89FAf7` | full |
| T-REX token ONCHAINID (proxy) | `0xF1410A0A58970D3DD20733f5f02aFEcf2Fce683C` | full |
| ONCHAINID identity holder1 (proxy) | `0x1F406b0f3A08656966B05024f7ca3E21E5074D74` | similar |
| ONCHAINID identity holder2 (proxy) | `0xDa81DbD77871c0bb0C6Fed041f65F6B57E743176` | similar |
| ONCHAINID identity holder3 (proxy) | `0xcf705545b90A6283779450bAB1AE8FeD46944D48` | similar |
| ONCHAINID identity holder4 (proxy) | `0xa996B5b8BCC4812E49bC8BbF13DdF18A2b6EAb3D` | similar |
| Seeder | `0x7f6B50B3ED309Da569306Ddc58666334dA551Bdf` | full |
| Merces library BabyJubJub | `0x797eCEE3FEf9c2D8f2f14e044670687C922F499A` | similar |
| Merces library ActionQueueLib | `0x4b4Cbdd4c07Bd615AC728D0A5169699ec09f1F9d` | similar |
| Merces library Poseidon2T2_BN254 | `0x81E277BbcFECa7dfd0Ea77419D9e590A97497E58` | similar |
| Merces ClientVerifier | `0xFAF0C5D65e13CcfE0392999175ef48A3e2b40966` | similar |
| Merces ServerVerifier | `0xB5B344176a52630053F0aDb27a6284Df1BD9479D` | similar |
| Merces | `0xe4B4Bf9771cC884e53998Bea44fAa51AD00deDd6` | full |
| PriceVault | `0x4D72f294F9AeB0ea07dF840cA479ab6B1beC0f46` | full |
