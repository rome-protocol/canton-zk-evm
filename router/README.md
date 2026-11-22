# Canton router contracts

Contracts that move a Canton asset between Canton and the AggLayer chains in one user action each way: `CantonBook`, `CantonRouter`, `CantonInbox` and the narrow bridge interface they call.

- `src/CantonBook.sol` says what may move: which wrapped token stands for which Canton instrument, which routes and destinations are open, the fees, the minimums and the lock caps. Every switch is deployed off.
- `src/CantonRouter.sol` joins the steps. Flow A (Canton to another chain): `claimAndBridge`. Flow C (back to Canton): `openInbox`, `claimAndWithdraw`, `claimToInbox`, `forward`, `mark`, `refund`. Anyone may call it, because every call can only pay out to an address the user fixed. It holds no funds between calls.
- `src/CantonInbox.sol` is the fixed-code account of one (party, refund network, refund address), made by CREATE2. It is not a proxy. Its creation code is checked in (`artifacts/CantonInbox.creation.hex`) and embedded in the router (`src/InboxCode.sol`), so an inbox address never changes with a compiler or a setting.
- `src/Labels.sol` makes and reads the route label `r1:<network>:<address>:<maxFee>:<nonce>` and the deposit id Canton makes from it.

The book and the router sit behind OpenZeppelin 4.8.2 Transparent proxies (`artifacts/`), under one `ProxyAdmin` that a timelock owns. Each keeps all its state in one ERC-7201 namespaced struct (`rome.canton.book.v1`, `rome.canton.router.v1`), fields only appended, and locks its implementation's initializer.

## Tests

`./run.sh` runs the Foundry tests with the pinned tools: forge from `tests/FOUNDRY`, solc from `PINS`, forge-std from `TOOLS`. It sets up each one itself on Linux; set `FORGE` and `SOLC` (paths) to use your own. The tests use the real gateway (`gateway/Gateway.sol`) and a mock of Ostia's bridge (`test/Base.sol`).

`test/vectors/r1.json` holds fixed vectors: label text, deposit ids and inbox addresses that every implementation must reproduce byte for byte (`test/vectors/make.py` writes it). `test/Upgrade.t.sol` upgrades the proxies to a test version 2 with a coin held in an open inbox, a running refund clock and a deposit waiting, and checks that none of them moved.

Change the inbox on purpose only with `./inbox.sh`; it prints the new `inboxCodeHash` to pin in `r1.json`.

## Deploying

`deploy.py` deploys the `ProxyAdmin`, the timelock, the two implementations and the two proxies (each initialised in its own deploy transaction), hands the `ProxyAdmin` to the timelock, and reads everything back: the initializers are locked on each implementation and proxy, each proxy's admin and implementation slot, the owners, each timelock's delay and exact role holders (nobody holds its admin role but the timelock itself, the deployer holds none), the implementations' code hashes against the build, the router's `inboxCodeHash` against the pinned value, and its book, gateway and bridge. A second timelock for upgrades is configuration only (`upgradeTimelock`, see `deploy/mainnet.example.json`).

```
router/deploy.py --config deploy/testnet.json --state state.json \
  --deployer-keystore K --deployer-password-file P --proposer-keystore K2 --proposer-password-file P2 deploy
router/deploy.py ... settings-schedule     # list Canton Coin, set the destinations and claim parts, through the timelock
router/deploy.py ... settings-execute      # after the delay; reads the settings back
router/deploy.py ... check [--settings]    # the read-backs alone, against the chain
```

- Nothing is written to a chain that is not on this machine unless `--live` is given, and then the chain's id must be the config's `chainId`. `deploy-test.sh` runs the whole flow on a local chain with throwaway keys; it is what CI runs.
- Keys are keystore files with password files, given by path. The chain's address comes from `ROUTER_RPC_URL` or `--rpc-url-file` and is never printed. Needs `cast`; run `forge build` first.
- Every switch is deployed off (`outOpen`, `inOpen`, each destination's `open`). Listing an asset opens its route, and the direction switch and each destination's setting are what gate a flow.
- `deploy/testnet.json` leaves `instrument`, `refuser` and `feeRecipient` empty: `deploy.py` refuses until they are set. Its fees are starting values to set from measured costs before a flow is switched on.

## Upgrade checks

`upgrade-check.sh` (CI job `upgrade-safety`) checks the inbox bytes against the pinned hash, then runs OpenZeppelin's upgrade-safety check against `artifacts/deployed-v1`, the compiler output of the build that is deployed (`snapshot.sh` writes it; check it in when the version to deploy is final). The current `src/` and the test version 2 must pass; `test/Reordered.sol`, which swaps two fields, must be refused.
