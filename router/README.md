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
