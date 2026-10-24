# A realistic mixed load for Ostia

A kit that puts a realistic mix of contracts on an Ostia chain and drives mixed traffic through them, so that the zkVM on Canton is proven on more than transfers of one token. This first part is the deploy: tokens of four kinds, a DEX, and a permissioned token with identities. The traffic driver, the oracle consumer and the private transfers are added in the parts that follow (see [What is still to come](#what-is-still-to-come)).

## What it deploys

| What | Contracts |
|---|---|
| ERC-20 | `Test USD` (tUSD, 6 decimals) and `Test Ether` (tETH, 18 decimals), mintable by the deployer; `Wrapped tROME` (WtROME, a WETH9-style wrapper of the chain's coin) |
| ERC-721 | `Ostia Pass` (OPASS), public mint, capped |
| ERC-1155 | `Ostia Items` (ids 1 to 5), public mint and batch mint |
| Uniswap V2 | factory and router, with two pools seeded with liquidity: tUSD/WtROME and tETH/tUSD |
| ERC-3643 (T-REX) | the token `Ostia Gold Bond` (OGB, 6 decimals) with its ONCHAINID identity, identity registry and storage, claim topics registry (topic 1), trusted issuers registry (one issuer), modular compliance, four verified holders (each with an identity and a signed KYC claim) and one unverified address that cannot receive the token |

Our own contracts are in `contracts/` (small, Apache-2.0). Everything else is installed at run time.

## Run it

You need Docker and a funded account on the chain. Nothing else is installed on the machine: every step runs in a pinned container (Node from the repo's own pin in `../../PINS`, Foundry from `PINS` here).

```sh
cd load/mixed
mkdir -p -m 0700 runs/mine/keys
# put the funded key (0x and 64 hex digits) in runs/mine/keys/distributor.key, mode 0600.
# With config.json as it is the deploy needs a little over 5,100 tROME: 5,000 are wrapped for the first pool, 25 go to the test wallets, the rest is gas.
export RUN_DIR=$PWD/runs/mine
./run.sh build     # npm ci from the lockfile, then forge build (two passes, see below)
./run.sh deploy    # deploys, writes $RUN_DIR/addresses.json; run it again and it skips what exists
./run.sh smoke     # one action of each kind from the test wallets (writes smoke.json)
./run.sh verify    # verifies every contract on the explorer (about an hour: see below)
```

`config.json` holds the chain (`rpc`, `explorer`, `explorerApi`, `chainId`) and the sizes of the pools and the token. To use another Ostia RPC, change it there, or set `RPC` for one run. The chain's public RPC answers only for final blocks, so each transaction is waited for until it is final (about 15 seconds each), and a full deploy is about 20 minutes.

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

The GPL contracts are compiled into the bytecode that is deployed; their sources are never copied into this repository. Anyone who runs the kit gets them from npm. The explorer's verification stores the source of each deployed contract, GPL ones included, which their licence allows.

**The Uniswap pair hash.** The router finds a pair by CREATE2 with a hash of the pair's creation code written into its library. That hash belongs to the original build of the pair; our build is not byte for byte the same. `scripts/prepare.mjs` reads the pair's code from the first build, writes a copy of the router and its library into `contracts/gen/` (git ignores it) with the hash of our pair, and the second build compiles that. `run.sh build` stops if the pair code differs between the two builds.

## Verification

`./run.sh verify` sends every contract to the explorer with `forge verify-contract --verifier etherscan` and asks `/api/contracts/<address>` afterwards. The explorer takes 30 verifications an hour from one client, so the step waits about two minutes between submissions (copies made by a factory, such as the pairs and the identity proxies, share the code of the first and are matched by it). `./run.sh node scripts/verify.mjs check` prints which contracts are verified without submitting anything.

## Layout

| File | What |
|---|---|
| `run.sh` | build, deploy, smoke, verify, in containers |
| `config.json` | chain, explorer, sizes |
| `PINS`, `package.json`, `package-lock.json` | what everything runs in and on |
| `contracts/` | our contracts, and the files that pull third-party contracts into the build |
| `scripts/deploy.mjs` | the idempotent deploy |
| `scripts/smoke.mjs` | one action of each kind |
| `scripts/verify.mjs`, `scripts/prepare.mjs`, `scripts/lib.mjs` | verification lists and checks, the Uniswap hash, shared helpers |

## What is still to come

The oracle consumer (RedStone), the private-transfer client (Merces, client-side only), the traffic driver with its mix and the report, and a short guide for people who want to try the chain follow in later parts of this change.

## An example run

On Ostia DevNet (chain 770101), 24 October 2026. The deployer was funded with 20,000 tROME from the DevNet faucet in one transfer, [`0x8f0926d20c71ff7f7be6a430f3e21da6b29dc3dd7f610257d21c179f8ac5ae58`](https://ostia.devnet.romeprotocol.xyz/tx/0x8f0926d20c71ff7f7be6a430f3e21da6b29dc3dd7f610257d21c179f8ac5ae58). The deployer account is `0x5156D75f11D49990ae94Df0C92aFb7288be9FcBe`.

**Verification result.** `/api/contracts/<address>` says `verified: true` for all 32 contracts: the factory and one pair with a full match, two more copies by a similar match (the second pool's pair and the holders' identity proxies, which share their code with one that has a source), and the rest by a partial match. A partial match means only the metadata differs: the kit compiles without the metadata hash on purpose (the pair hash above needs a build that is the same byte for byte), so a contract's code does not end with the metadata hash that an ordinary build writes.

| Contract | Address | Created in |
|---|---|---|
| tUSD | [`0x136c750aE42Be4A24517669745467e48416c1998`](https://ostia.devnet.romeprotocol.xyz/address/0x136c750aE42Be4A24517669745467e48416c1998) | [`0xfab788c9…`](https://ostia.devnet.romeprotocol.xyz/tx/0xfab788c95ebe94709559727a936c150cd8bd9437d60f03e2ec772b49cb49943f) |
| tETH | [`0x8059Cf87A3c71C0DB15FF44C38736Ab1863ec26B`](https://ostia.devnet.romeprotocol.xyz/address/0x8059Cf87A3c71C0DB15FF44C38736Ab1863ec26B) | [`0x54d2a08e…`](https://ostia.devnet.romeprotocol.xyz/tx/0x54d2a08ea352e86b62f1d6afe6aa09c9a36f3acf8fe58c8264d3356212d1cb1a) |
| WtROME | [`0xF5Df8B5632f3F0d6D4E0A12B6AB6EdEFb0782Fb9`](https://ostia.devnet.romeprotocol.xyz/address/0xF5Df8B5632f3F0d6D4E0A12B6AB6EdEFb0782Fb9) | [`0x81a96320…`](https://ostia.devnet.romeprotocol.xyz/tx/0x81a963201fbaa311261b2f9171d1ce6531428a3510e70716bcdcd57c5bf19f9a) |
| OstiaPass | [`0xC4a8BeFA855feB37D676361D010589932dF2086d`](https://ostia.devnet.romeprotocol.xyz/address/0xC4a8BeFA855feB37D676361D010589932dF2086d) | [`0x4e85e38e…`](https://ostia.devnet.romeprotocol.xyz/tx/0x4e85e38e3fb81da7ced4944ee31b6e8f5133c9ffe0ec18665be6137394f9ace5) |
| OstiaItems | [`0x0396bffF6AdA6bbae060E14200527E81937B90B0`](https://ostia.devnet.romeprotocol.xyz/address/0x0396bffF6AdA6bbae060E14200527E81937B90B0) | [`0xce9a4eda…`](https://ostia.devnet.romeprotocol.xyz/tx/0xce9a4eda4359c150a950dcc0dcb418658941b07e5ec3cec7587b8044127ec0cc) |
| UniswapV2Factory | [`0x7480937c18f6cfff1D3Eea249a9aCDcb1f6b0d07`](https://ostia.devnet.romeprotocol.xyz/address/0x7480937c18f6cfff1D3Eea249a9aCDcb1f6b0d07) | [`0x83cc2300…`](https://ostia.devnet.romeprotocol.xyz/tx/0x83cc230012866e6e9fb57aea17c2fdea3c30a0ba194184c64f4d37912b1cc1c1) |
| UniswapV2Router02 | [`0x2B65d3b4EF99d9f5848d692D9e935Ab6ad3591F6`](https://ostia.devnet.romeprotocol.xyz/address/0x2B65d3b4EF99d9f5848d692D9e935Ab6ad3591F6) | [`0x50312405…`](https://ostia.devnet.romeprotocol.xyz/tx/0x50312405c25b2512760078dc74e6833126b197f0d7e8290daaba3d31ae0fdbef) |
| UniswapV2Pair tUSD/WtROME | [`0x2F8B1fF26664e571ED459CeF6CF1B15757C63642`](https://ostia.devnet.romeprotocol.xyz/address/0x2F8B1fF26664e571ED459CeF6CF1B15757C63642) | [`0x3a72a606…`](https://ostia.devnet.romeprotocol.xyz/tx/0x3a72a6062fdc53d31389437efd0d3311318a9944baf512f39ba63e5d719105ed) |
| UniswapV2Pair tETH/tUSD | [`0x1fec029c0124BdB6C0e822f7641E2365C93c04A8`](https://ostia.devnet.romeprotocol.xyz/address/0x1fec029c0124BdB6C0e822f7641E2365C93c04A8) | [`0x47eb6736…`](https://ostia.devnet.romeprotocol.xyz/tx/0x47eb6736ad973eb96a83ae441399f6b063f11a3c861cf5008cf3344c191633a4) |
| ONCHAINID Identity (library) | [`0xFFfFa401d1F65289Da7f990602085d43a0F32951`](https://ostia.devnet.romeprotocol.xyz/address/0xFFfFa401d1F65289Da7f990602085d43a0F32951) | [`0x6dd7f26d…`](https://ostia.devnet.romeprotocol.xyz/tx/0x6dd7f26d9b540a7d68dd89ff7515032e0465e951f9451d2e1de4e051c1a2aaf6) |
| ONCHAINID ImplementationAuthority | [`0x99A964fbA787BB6aaC61904C6F49C7F1A06dA84e`](https://ostia.devnet.romeprotocol.xyz/address/0x99A964fbA787BB6aaC61904C6F49C7F1A06dA84e) | [`0xa569869a…`](https://ostia.devnet.romeprotocol.xyz/tx/0xa569869a0d04a16b0578044325c3ddeeb51673d68877bcab56cabac4bcc17ae5) |
| ONCHAINID IdFactory | [`0xC945d3fB67A344B0aa0303DBE557C81ABb55D5d6`](https://ostia.devnet.romeprotocol.xyz/address/0xC945d3fB67A344B0aa0303DBE557C81ABb55D5d6) | [`0xb1a33f2f…`](https://ostia.devnet.romeprotocol.xyz/tx/0xb1a33f2f28ed3a4cb196fab76f62cde8936d71e4ca7ba98f9787c5305bbb9db4) |
| T-REX Token (implementation) | [`0xEA82f9eb88e06bE8967846084abec90027c39d3e`](https://ostia.devnet.romeprotocol.xyz/address/0xEA82f9eb88e06bE8967846084abec90027c39d3e) | [`0x664c9f5a…`](https://ostia.devnet.romeprotocol.xyz/tx/0x664c9f5a6d2fc1a0084a31724758634fda2e533693b114166ee4a1f1e5cdf943) |
| T-REX ClaimTopicsRegistry (implementation) | [`0xd029c3075f72C31eB2b2F818299B8C905DC532cF`](https://ostia.devnet.romeprotocol.xyz/address/0xd029c3075f72C31eB2b2F818299B8C905DC532cF) | [`0xcc5b1952…`](https://ostia.devnet.romeprotocol.xyz/tx/0xcc5b1952ca6e79c83d3966f8eac2bbaa4458f49572da33243b1c27faa71a8959) |
| T-REX IdentityRegistry (implementation) | [`0xf695a79ab373Ef4d88ae196F92f9379FAb403020`](https://ostia.devnet.romeprotocol.xyz/address/0xf695a79ab373Ef4d88ae196F92f9379FAb403020) | [`0x8370ea50…`](https://ostia.devnet.romeprotocol.xyz/tx/0x8370ea504fc8d754096b74d7bd47ec7a6ef5fd69f617cc264d15a5307a6fa018) |
| T-REX IdentityRegistryStorage (implementation) | [`0x9418d2B801e070d07fFfb9ce7ED4126FB771715A`](https://ostia.devnet.romeprotocol.xyz/address/0x9418d2B801e070d07fFfb9ce7ED4126FB771715A) | [`0x412d2052…`](https://ostia.devnet.romeprotocol.xyz/tx/0x412d2052efdc40fec33b1f8caf40eae1fc207d48c0bd7418812565baed54f819) |
| T-REX TrustedIssuersRegistry (implementation) | [`0x80F45f55Ea3d08A56E01E436acA4E051a7635eFb`](https://ostia.devnet.romeprotocol.xyz/address/0x80F45f55Ea3d08A56E01E436acA4E051a7635eFb) | [`0xca08a9c8…`](https://ostia.devnet.romeprotocol.xyz/tx/0xca08a9c8187d8fa91786c44ed5ecaf6977bc5c6e5522631972351a86d3cb904a) |
| T-REX ModularCompliance (implementation) | [`0x702EA79875d47ab3EE02Df906517e646960FAfa6`](https://ostia.devnet.romeprotocol.xyz/address/0x702EA79875d47ab3EE02Df906517e646960FAfa6) | [`0x8e3f37b1…`](https://ostia.devnet.romeprotocol.xyz/tx/0x8e3f37b129b6aa4584014c8f33fff998a3d02ea1aaa5502799ae49a2d5356a2d) |
| T-REX TREXImplementationAuthority | [`0xaFa12D376Cc34a3d4Dd6dfFd04348512B5175196`](https://ostia.devnet.romeprotocol.xyz/address/0xaFa12D376Cc34a3d4Dd6dfFd04348512B5175196) | [`0x8b668fc0…`](https://ostia.devnet.romeprotocol.xyz/tx/0x8b668fc0bc6eaa472eec028bf78bcab8838869c4d75c7616701c94dd3da80f2c) |
| T-REX TREXFactory | [`0xee850E54a392cc30376C5F365E54C20cd4422A26`](https://ostia.devnet.romeprotocol.xyz/address/0xee850E54a392cc30376C5F365E54C20cd4422A26) | [`0x04456356…`](https://ostia.devnet.romeprotocol.xyz/tx/0x044563562703cbe4583028fec4cc284ee1484b3674d1574ccfedf1f3035dc6a2) |
| ONCHAINID ClaimIssuer | [`0xB9Df14F0d85a5C0846507Eba82649635ce666e32`](https://ostia.devnet.romeprotocol.xyz/address/0xB9Df14F0d85a5C0846507Eba82649635ce666e32) | [`0x3c473851…`](https://ostia.devnet.romeprotocol.xyz/tx/0x3c4738517485238b8b0a45e7df3e203df932c33838b9dbe57193ab81a446e29f) |
| T-REX Token (proxy) | [`0xbaB81a03045E55E7dF67863A1d39457c22042a7b`](https://ostia.devnet.romeprotocol.xyz/address/0xbaB81a03045E55E7dF67863A1d39457c22042a7b) | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| T-REX IdentityRegistry (proxy) | [`0x78F46A6E6a5BbD455c55Ea5764A2865Df863b88a`](https://ostia.devnet.romeprotocol.xyz/address/0x78F46A6E6a5BbD455c55Ea5764A2865Df863b88a) | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| T-REX ModularCompliance (proxy) | [`0xd88B380e97B65Bb5934e411DBD5025B11065e2C0`](https://ostia.devnet.romeprotocol.xyz/address/0xd88B380e97B65Bb5934e411DBD5025B11065e2C0) | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| T-REX IdentityRegistryStorage (proxy) | [`0x69f6C537472516185A2d783FE6c9d6562d3A7608`](https://ostia.devnet.romeprotocol.xyz/address/0x69f6C537472516185A2d783FE6c9d6562d3A7608) | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| T-REX TrustedIssuersRegistry (proxy) | [`0x88fDf9D4f8d84e3c4488c0F85B78dEbD5663aAd1`](https://ostia.devnet.romeprotocol.xyz/address/0x88fDf9D4f8d84e3c4488c0F85B78dEbD5663aAd1) | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| T-REX ClaimTopicsRegistry (proxy) | [`0xAddf2A2777Cf011289EC7F8c5B155641488F92b2`](https://ostia.devnet.romeprotocol.xyz/address/0xAddf2A2777Cf011289EC7F8c5B155641488F92b2) | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| T-REX token ONCHAINID (proxy) | [`0xfF35e391223d0C25Ff853F28F1e63cFDfE67C365`](https://ostia.devnet.romeprotocol.xyz/address/0xfF35e391223d0C25Ff853F28F1e63cFDfE67C365) | [`0x953bfa37…`](https://ostia.devnet.romeprotocol.xyz/tx/0x953bfa37f447a386ce2f0088a3c36bfdf84917bd7ffa20acfc90ac0956dd795c) |
| ONCHAINID identity holder1 (proxy) | [`0xBD3bd3948e5C7B68A7E8A7EcC6660c29c21E7848`](https://ostia.devnet.romeprotocol.xyz/address/0xBD3bd3948e5C7B68A7E8A7EcC6660c29c21E7848) | [`0xf5fa8417…`](https://ostia.devnet.romeprotocol.xyz/tx/0xf5fa8417179cd54544b20b5d57b93f74a351ce42ff5be4137a02a9c81ed5f022) |
| ONCHAINID identity holder2 (proxy) | [`0x00745f1d55eF580429806E9e60B64859b5B54B28`](https://ostia.devnet.romeprotocol.xyz/address/0x00745f1d55eF580429806E9e60B64859b5B54B28) | [`0x2647a7cd…`](https://ostia.devnet.romeprotocol.xyz/tx/0x2647a7cd3d9861602fba946c6b1e27aed202e4b7206d819b22fda2508aeac531) |
| ONCHAINID identity holder3 (proxy) | [`0xeFb27D5Ff8BA2faaa71bEBe41cebaABcD81d8df0`](https://ostia.devnet.romeprotocol.xyz/address/0xeFb27D5Ff8BA2faaa71bEBe41cebaABcD81d8df0) | [`0x248efbb7…`](https://ostia.devnet.romeprotocol.xyz/tx/0x248efbb7292daab58f8486f20fb35912325160a961ee0436edd457fadc19e97a) |
| ONCHAINID identity holder4 (proxy) | [`0xC06439a88B02b891F30c0BCa2b796847CA15377A`](https://ostia.devnet.romeprotocol.xyz/address/0xC06439a88B02b891F30c0BCa2b796847CA15377A) | [`0xb35bd3e6…`](https://ostia.devnet.romeprotocol.xyz/tx/0xb35bd3e602b6568e5983c32e8c899279da6e0ca6a44b94b93b75bf6945f892f1) |

| Step | Transaction |
|---|---|
| mint-tUSD | [`0xf62cfa5a1aadd2fa5bd2a8b7aaeee90e201575685119d9afc3a42561ebd5f381`](https://ostia.devnet.romeprotocol.xyz/tx/0xf62cfa5a1aadd2fa5bd2a8b7aaeee90e201575685119d9afc3a42561ebd5f381) |
| mint-tETH | [`0x018797564b22991284d3b4e85c9d1395348ea52bb35927295719e8a544c2ec73`](https://ostia.devnet.romeprotocol.xyz/tx/0x018797564b22991284d3b4e85c9d1395348ea52bb35927295719e8a544c2ec73) |
| mint-pass-1 | [`0x74920a216cf12b672111c52e102ac991f538ee98d0bea41e1efbd4c5d568ae75`](https://ostia.devnet.romeprotocol.xyz/tx/0x74920a216cf12b672111c52e102ac991f538ee98d0bea41e1efbd4c5d568ae75) |
| mint-items-batch | [`0xbf6097c83d9e8d4e31eb7e069322f7bcc993333ad9df11e0db669e9e1b88e7f2`](https://ostia.devnet.romeprotocol.xyz/tx/0xbf6097c83d9e8d4e31eb7e069322f7bcc993333ad9df11e0db669e9e1b88e7f2) |
| wrap-trome | [`0xfcc3c87dff6be6c982970387414941624a5ff8029c5d5e64260da783d1de3d4f`](https://ostia.devnet.romeprotocol.xyz/tx/0xfcc3c87dff6be6c982970387414941624a5ff8029c5d5e64260da783d1de3d4f) |
| approve-router-tUSD | [`0x620ce9e9cdb4632abb3b4ca7af393f52d6616a4de8c3b620a9a74ba0ab5bea89`](https://ostia.devnet.romeprotocol.xyz/tx/0x620ce9e9cdb4632abb3b4ca7af393f52d6616a4de8c3b620a9a74ba0ab5bea89) |
| approve-router-tETH | [`0xf88b4c95b798959c2da2e16ff613cbba8d0cf066b20e734cb098db9ecdeee5ad`](https://ostia.devnet.romeprotocol.xyz/tx/0xf88b4c95b798959c2da2e16ff613cbba8d0cf066b20e734cb098db9ecdeee5ad) |
| approve-router-WtROME | [`0x2a36f52f0dd82887bd4accd53704ce23513c141f94cd97813fa8c4dcf70cf5c3`](https://ostia.devnet.romeprotocol.xyz/tx/0x2a36f52f0dd82887bd4accd53704ce23513c141f94cd97813fa8c4dcf70cf5c3) |
| liquidity-tUSD/WtROME | [`0x3a72a6062fdc53d31389437efd0d3311318a9944baf512f39ba63e5d719105ed`](https://ostia.devnet.romeprotocol.xyz/tx/0x3a72a6062fdc53d31389437efd0d3311318a9944baf512f39ba63e5d719105ed) |
| liquidity-tETH/tUSD | [`0x47eb6736ad973eb96a83ae441399f6b063f11a3c861cf5008cf3344c191633a4`](https://ostia.devnet.romeprotocol.xyz/tx/0x47eb6736ad973eb96a83ae441399f6b063f11a3c861cf5008cf3344c191633a4) |
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

| Smoke action | Transaction |
|---|---|
| deployer mints 1,000 tUSD to holder1 | [`0x14fda1f620f2840a576b7b5406e1e912f489379826a63c49b2f6460ac3084c6d`](https://ostia.devnet.romeprotocol.xyz/tx/0x14fda1f620f2840a576b7b5406e1e912f489379826a63c49b2f6460ac3084c6d) |
| ERC-20 transfer: holder1 sends 10 tUSD to holder2 | [`0x445c1361926d14d1ba4d5c7ad1c31cadb44bd42ba8976e9c2cd972c558f761b7`](https://ostia.devnet.romeprotocol.xyz/tx/0x445c1361926d14d1ba4d5c7ad1c31cadb44bd42ba8976e9c2cd972c558f761b7) |
| ERC-721: holder1 mints an Ostia Pass | [`0x304d0b41e9dcc6b9cdeebfaa5edccf2c2b436c0e3faa4ffa4c505d74608a6b8d`](https://ostia.devnet.romeprotocol.xyz/tx/0x304d0b41e9dcc6b9cdeebfaa5edccf2c2b436c0e3faa4ffa4c505d74608a6b8d) |
| ERC-1155: holder1 mints 3 Swords and 2 Keys in one batch | [`0xe282ca2f036c02162231d19f64f9f38d423e286915148834c1072a0b5e4bff3e`](https://ostia.devnet.romeprotocol.xyz/tx/0xe282ca2f036c02162231d19f64f9f38d423e286915148834c1072a0b5e4bff3e) |
| wrap: holder1 wraps 1 tROME | [`0xc075d54bd1e0d0ded27ef04a58668a04ee4985ef71692d81850b05a978773849`](https://ostia.devnet.romeprotocol.xyz/tx/0xc075d54bd1e0d0ded27ef04a58668a04ee4985ef71692d81850b05a978773849) |
| approve the router for tUSD | [`0xae11680ab91dfec3c1524789cea1f0063fec1984f4ed33436a317fa8e3005a85`](https://ostia.devnet.romeprotocol.xyz/tx/0xae11680ab91dfec3c1524789cea1f0063fec1984f4ed33436a317fa8e3005a85) |
| Uniswap V2: holder1 swaps 100 tUSD for WtROME | [`0xecb7ba05eafdac5ce61214f93a88007d7432044b3e05e1365dd247da8e1eb185`](https://ostia.devnet.romeprotocol.xyz/tx/0xecb7ba05eafdac5ce61214f93a88007d7432044b3e05e1365dd247da8e1eb185) |
| ERC-3643: verified holder1 sends 5 OGB to verified holder2 | [`0xce01bf6e93327077d70fa26608a928a145b669a1dc647b74ebd306cc8ecf251a`](https://ostia.devnet.romeprotocol.xyz/tx/0xce01bf6e93327077d70fa26608a928a145b669a1dc647b74ebd306cc8ecf251a) |
| ERC-3643: transfer to the unverified address (a call, not sent) | Transfer not possible |
