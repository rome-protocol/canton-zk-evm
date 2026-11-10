# Wallet signature tests

The Bridge makes a person's Canton account key from one wallet signature (`explorer/src/bridge/canton/key.ts`): the page asks the wallet for an EIP-712 signature of a fixed message (`KEY_TYPED_DATA`), puts the signature in its normal form (`normaliseSignature`), and derives an Ed25519 key from it with HKDF (`seedFromSignature`). The same typed data always has the same signing digest, but the signature bytes are the same only if the wallet signs deterministically (RFC 6979 nonces) and in the same form. A wallet that signs a different way would make a different key, and so a different account.

This folder is a harness that checks that, wallet by wallet, and the results it made. It is **opt-in**: it downloads third-party browser extensions and opens the live DevNet site, so it is in no CI job. Run it by hand, on a machine you can throw away.

- Results: [`results/wallets.md`](results/wallets.md) (the table) and [`results/wallets.json`](results/wallets.json) (the same, for machines).
- Rerun: `tests/wallets/run.sh` (Docker, and a network). See below.

## What it does

1. **The reference.** A throwaway seed phrase is made at run time (and kept only in `tests/wallets/run/`, mode 0600, never printed). Its first account signs `KEY_TYPED_DATA` with viem (RFC 6979, so deterministic), and the harness derives the Canton key and account name (`rome::1220...`) the page would make, with the page's own functions from `key.ts` and `topology.ts`, not a copy.
2. **Each wallet.** The wallet's package is fetched from its official source (`wallets.json`; `fetch.ts` records the SHA-256 and unpacks it), loaded in Chromium with Playwright (a persistent profile, under a virtual display), set up with the same seed phrase, and connected to a small local test page that adds a stand-in chain with the chain id of the Bridge (so the wallet agrees to sign typed data for it) and asks for `eth_signTypedData_v4` with `KEY_TYPED_DATA`, each request started by a real click. The wallet's own screens are driven by `drivers.ts`. The browser is then closed, the same profile is opened again (the wallet is locked again, and is unlocked with its password), and the page asks again.
3. **The live check** (`live.ts`). With the first wallet in a new profile, the harness opens the Bridge account on the live DevNet site (it adds the chain from the site's API page, takes the faucet's coin, and signs in). It closes the browser, opens a second new profile with a second wallet that holds the same seed phrase, and signs in again. The two must reach the same Canton account, and it must be the reference's. Nothing else is signed, and nothing but the faucet's coin is used. A browser profile that has never seen the account keeps no key, so the second visit makes the key from the second wallet's signature.
4. **The report** (`report.ts`) writes `results/`.

The signatures are not kept in the results: a signature is the Canton key of that throwaway account, so only SHA-256 hashes of the raw and of the normalised signature are written.

## The columns

| Column | Meaning |
|---|---|
| Wallet, Version | The wallet and the version in the package's `manifest.json`. |
| Package source and SHA-256 | Where the package came from (the maker's GitHub release, or the Chrome Web Store package by its id) and the SHA-256 of the package that was tested. For MetaMask the SHA-256 is also checked against the release's own `SHA256SUMS`. |
| Same signature twice | Two requests in a row, in one browser session, gave identical bytes. This is the check the page makes itself when an account is first made (`confirmKey`). |
| Same after restart | The browser was closed and the same profile opened again, the wallet unlocked, and the page asked twice more: all four signatures have identical bytes. |
| Matches reference | The wallet's signature, after `normaliseSignature`, equals viem's RFC 6979 signature after the same. The raw form (the recovery byte and whether `s` is low) is in the JSON (`form`, `rawMatchesReference`). |
| Matches other wallets | `same bytes` when every tested wallet gave identical raw bytes; `same after normalising` when they differ only in form (recovery byte 0/1 against 27/28, or the high-`s` twin) and the page's normal form makes them one; `no` otherwise. |
| Opens on the live Bridge | `yes` for the two wallets of the live check when both reached the same account as the reference. `not tried` for the rest. |
| Date | The day of the run. |

A wallet that cannot be driven reliably is `not automated`, with the stage it stopped at. That is a limit of the harness, not a result about the wallet.

## Not covered

- **Hardware wallets (Ledger, Trezor).** They need a device and a person's button press, so they cannot be automated. Whether a device signs by RFC 6979 is its vendor's claim, not something this harness checked. A hardware wallet behind a software wallet is covered only as far as the software wallet's own signing path goes.
- **Smart-contract wallets (Safe and others).** They cannot open a Bridge account. `walletSignature` in `key.ts` takes the signature, recovers the signer with `recoverTypedDataAddress` and refuses with `wrong_signer` when it is not the connected address; and `normaliseSignature` refuses anything that is not a 65-byte secp256k1 signature. A contract wallet's signature (ERC-1271) is not one, and its address is the contract's, never the address of a key that signed.
- **Other wallets and versions.** Only what is in the table. A wallet that updates may change how it signs; run the harness again.

## Rerun it

```sh
tests/wallets/run.sh              # all wallets, then the live check
tests/wallets/run.sh --no-live    # without the live check (no faucet coin)
tests/wallets/run.sh metamask     # one wallet
tests/wallets/run.sh --debug rabby   # what the wallet's screens show, to fix a driver
tests/wallets/run.sh --update     # accept the packages that are there now
```

`run.sh` needs Docker and a network. It runs in the browser image that `PINS` names (`EXPLORER_BROWSER_IMAGE`), installs the explorer's and the harness's pinned npm packages, fetches the wallets, and writes `tests/wallets/run/` (the seed, the profiles, the downloaded packages: never commit it, and delete it when you are done: `rm -rf tests/wallets/run`) and `tests/wallets/results/`.

**When a wallet updates.** `wallets.json` pins each package by SHA-256 (a GitHub release also by its tag). A newer package makes `fetch.ts` stop: change the tag and asset there for a GitHub release, then run with `--update` to test and record the new package. Read the table: a wallet that does not match the reference, or does not match the others, is the finding. If a wallet's screens changed so that the harness cannot drive it, the row says `not automated` and where it stopped: fix its entry in `src/drivers.ts` (`--debug` shows each screen's text and buttons).

**Adding a wallet.** Add it to `wallets.json` (an official source and, for the store, its extension id) and to `src/drivers.ts` (`generic(...)` takes the wallet's first page, its buttons in order, the text of its ready screen and the address of its pop-ups). Wallets that draw in a frame (`frame`), or that need a narrow window (`narrow`), say so there.

**Tests of the harness itself** need no browser: `cd tests/wallets && npm ci && node --experimental-transform-types --test src/report.test.ts`.

## Notes on how it works

- The chain added to each wallet is a stand-in that the harness serves itself (HTTPS with a certificate made for the run, because some wallets add a chain only by an HTTPS address; the browser accepts it for this run only). The Bridge's chain id is what matters: wallets refuse typed data for a chain they are not on.
- A wallet's own pop-up window is not reliably seen by the browser driver, so the harness opens the wallet's page of pending requests in a tab and clicks what it asks for. A wallet that shows nothing for the page's request is `not automated`.
- `src/probe.ts` is a debug helper: `node src/probe.ts <wallet> [rounds] [path]` opens a wallet and prints what each of its pages shows.
- The harness's own downloads (the wallets' packages and checksums) carry the project's contact in their User-Agent.
