# Checked-in compiled artifacts

Nothing here is compiled by this repository. Each file is the bytes that are deployed, checked in so that no compiler or setting can change them.

| File | What it is | SHA-256 |
|---|---|---|
| `ProxyAdmin.json` | OpenZeppelin Contracts 4.8.2 `ProxyAdmin`, as compiled in the `compiled-contracts` folder of agglayer-contracts v12.2.3 (commit `110bda5a03e70ee7331bc06407a8e79226d3e520`), unchanged | `5215fa78a338852f7872f380921cea95836bd50581c9e72e1c349752d47e1f44` |
| `TransparentUpgradeableProxy.json` | OpenZeppelin Contracts 4.8.2 `TransparentUpgradeableProxy`, from the same folder, unchanged | `c3b1850465d8bcc1f54d82837fdbcdacdd967ac7f928a68acd288aefb791a514` |
| `CantonInbox.creation.hex` | The creation code of `src/CantonInbox.sol`, written by `inbox.sh`. Every router embeds these bytes (`src/InboxCode.sol`). Its Keccak-256 is `inboxCodeHash` in `test/vectors/r1.json` | see `r1.json` |

The proxies are the same compiled files that Ostia's AggLayer bridge already runs behind. OpenZeppelin Contracts is under the MIT licence (NOTICE).

`src/vendor/Initializable.sol` is the `proxy/utils/Initializable.sol` of the `@openzeppelin/contracts` 5.1.0 release, byte for byte (SHA-256 `a8b7eafa0fdc7cb5a644c8c61a8e4c51e031d5e1e6f268f72dbe18b768ead56e`), taken from the 5.1.0 npm package (tarball SHA-256 `fcddd83ee65457e2dd40d207010c885b45cdf6ea2360ca8c9d4cf2cca5e2b3b2`).
