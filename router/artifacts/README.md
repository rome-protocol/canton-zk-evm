# Checked-in compiled artifacts

Nothing here is compiled by this repository. Each file is the bytes that are deployed, checked in so that no compiler or setting can change them.

| File | What it is | SHA-256 |
|---|---|---|
| `ProxyAdmin.json` | OpenZeppelin Contracts 4.8.2 `ProxyAdmin`, as compiled in the `compiled-contracts` folder of agglayer-contracts v12.2.3 (commit `110bda5a03e70ee7331bc06407a8e79226d3e520`), unchanged | `5215fa78a338852f7872f380921cea95836bd50581c9e72e1c349752d47e1f44` |
| `TransparentUpgradeableProxy.json` | OpenZeppelin Contracts 4.8.2 `TransparentUpgradeableProxy`, from the same folder, unchanged | `c3b1850465d8bcc1f54d82837fdbcdacdd967ac7f928a68acd288aefb791a514` |
| `CantonInbox.creation.hex` | The creation code of `src/CantonInbox.sol`, written by `inbox.sh`. Every router embeds these bytes (`src/InboxCode.sol`). Its Keccak-256 is `inboxCodeHash` in `test/vectors/r1.json` | see `r1.json` |

The proxies are the same compiled files that Ostia's AggLayer bridge already runs behind. OpenZeppelin Contracts is under the MIT licence (NOTICE).

`src/vendor/Initializable.sol` is OpenZeppelin's `Initializable`, unchanged: its text is the same in every release from 5.0.0 to 5.2.0 (its header says "last updated v5.0.0"), which includes 5.1.0.
