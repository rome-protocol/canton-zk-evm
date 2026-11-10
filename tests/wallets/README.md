# Wallet signature tests

The Bridge makes a person's Canton account key from one wallet signature (`explorer/src/bridge/canton/key.ts`): the page asks the wallet for an EIP-712 signature of a fixed message (`KEY_TYPED_DATA`), puts the signature in its normal form (`normaliseSignature`), and derives an Ed25519 key from it with HKDF (`seedFromSignature`). The same typed data always has the same signing digest, but the signature bytes are the same only if the wallet signs deterministically (RFC 6979 nonces) and in the same form. A wallet that signs a different way would make a different key, and so a different account.

This folder is a harness that checks that, wallet by wallet, and the results it made. It is **opt-in**: it downloads third-party browser extensions and opens the live DevNet site, so it is in no CI job. Run it by hand, on a machine you can throw away.

- Results: [`results/wallets.md`](results/wallets.md) (the table) and [`results/wallets.json`](results/wallets.json) (the same, for machines).
- Rerun: `tests/wallets/run.sh` (Docker, and a network). See below.

## What it does

1. **The reference.** A throwaway seed phrase is made at run time (and kept only in `tests/wallets/run/`, mode 0600, never printed). Its first account signs `KEY_TYPED_DATA` with viem (RFC 6979, so deterministic), and the harness derives the Canton key and account name (`rome::1220...`) the page would make, with the page's own functions from `key.ts` and `topology.ts`, not a copy.
2. **Each wallet.** The wallet's package is fetched from its official source (`wallets.json`; `fetch.ts` records the SHA-256 and unpacks it), loaded in Chromium with Playwright (a persistent profile, under a virtual display), set up with the same seed phrase, and connected to a small local test page that adds a stand-in chain with the chain id of the Bridge (so the wallet agrees to sign typed data for it) and asks for `eth_signTypedData_v4` with `KEY_TYPED_DATA`, each request started by a real click. The wallet's own screens are driven by `drivers.ts`. The browser is then closed, the same profile is opened again (the wallet is locked again, and is unlocked with its password), and the page asks again.
3. **The live check** (`live.ts`). With the first wallet in a new profile, the harness opens the Bridge account on the live DevNet site (it adds the chain from the site's API page, takes the faucet's coin, and signs in). It closes the browser, opens a second new profile with a second wallet that holds the same seed phrase, and signs in again. The two must reach the same Canton account, and it must be the reference's. Nothing else is signed, and nothing but the faucet's coin is used: the harness approves a wallet's signing screen only when it shows the Bridge's request (the domain name `Ostia bridge` or the start of the statement), and refuses any other signature request and counts it (`refusedSignatures` in the JSON). That guard reads the wallet's screen text, so it is only as good as that text; the live site asks for nothing else (the recorded `steps` show what was clicked). A browser profile that has never seen the account keeps no key, so the second visit makes the key from the second wallet's signature.
4. **The report** (`report.ts`) writes `results/`.

The signatures are not kept in the results: a signature is the Canton key of that throwaway account, so only SHA-256 hashes of the raw and of the normalised signature are written.

## The columns

| Column | Meaning |
|---|---|
| Wallet, Version | The wallet and the version in the package's `manifest.json`. |
| Package source and SHA-256 | Where the package came from (the maker's GitHub release, or the Chrome Web Store package by its id) and the SHA-256 of the package that was tested. For MetaMask the SHA-256 is also checked against the release's own `SHA256SUMS`. |
| Same signature twice | Two requests in a row, in one browser session, gave identical bytes. This is the check the page makes itself when an account is first made (`confirmKey`). |
| Same after restart | The browser was closed and the same profile opened again, the wallet unlocked, and the page asked twice more: all four signatures have identical bytes. |
| Matches reference | The wallet's signature, after `normaliseSignature`, equals viem's RFC 6979 signature after the same. The raw form (the recovery byte and whether `s` is low) is in the JSON (`form`, `rawMatchesReference`). `NO (another first address)` means the wallet's first account is not the seed's first account (it derives it by another path), so the keys differ and the signature is not expected to match: that is not a difference in signing (`addressIsReference` in the JSON). |
| Matches other wallets | `same bytes` when every tested wallet gave identical raw bytes; `same after normalising` when they differ only in form (recovery byte 0/1 against 27/28, or the high-`s` twin) and the page's normal form makes them one; `no` otherwise. Every run makes a new throwaway seed (a new reference), so this compares wallets tested in the same run; a wallet tested alone in a rerun says `only one wallet tested`, and the other rows keep the comparison their own run made. |
| Opens on the live Bridge | The live check names two wallets. `yes`: both reached the same Canton account, and it is the reference's (compared by the key's fingerprint, the part after `::`). `no`: the check ran and they reached different accounts, or not the reference's: that is the finding the check exists to make. `incomplete`: the check ran but reached no account (the faucet, the site or a wallet screen failed; the reason is in `results/wallets.json`), so it says nothing about the wallets. `not tried`: the wallet was not in the live check, or its package changed since it was. A verdict carries the day of the live check, for example `yes (2026-11-10)`: a later run of the wallet alone (the Date column) keeps the live verdict it had, with its own day. Each run makes a new throwaway seed, so the live block in the JSON names the reference it was made against (`referenceFingerprint`), which can differ from the document's `reference`. |
| Date | The day of the run. |

The JSON also records the browser each row was tested in (`browser`: the image with its digest, from `PINS`, and the Chromium version) and the same for the live check.

OKX Wallet's screens are driven less reliably than the others': one rerun stopped at its second signature, and an immediate rerun of that wallet alone passed. If a run says `not automated` for a wallet that had a result, run that wallet again (`tests/wallets/run.sh okx`) before replacing its row; its `notes` in `wallets.json` say so too.

A wallet that cannot be driven reliably is `not automated`, with the stage it stopped at and the reason of this run (and, after it, what earlier attempts found, from `wallets.json`). That is a limit of the harness, not a result about the wallet. A wallet that was not run in an invocation keeps the row it has in the committed results, with its own version, SHA-256 and date, so running one wallet changes one row; a wallet with no earlier result is `not run`.

## Not covered

- **Hardware wallets (Ledger, Trezor).** They need a device and a person's button press, so they cannot be automated. Whether a device signs by RFC 6979 is its vendor's claim, not something this harness checked. A hardware wallet used through a software wallet is not covered either, because the device makes the signature, not the software wallet.
- **Smart-contract wallets (Safe and others).** They cannot open a Bridge account. `walletSignature` in `key.ts` takes the signature, recovers the signer with `recoverTypedDataAddress` and refuses with `wrong_signer` when it is not the connected address; and `normaliseSignature` refuses anything that is not a 65-byte secp256k1 signature. A contract wallet's signature (ERC-1271) is usually not a 65-byte key signature; and even when it is (a Safe's contract signature can be 65 bytes), it never recovers to the contract's address, so `wrong_signer` refuses it.
- **Other wallets and versions.** Only what is in the table. A wallet that updates may change how it signs; run the harness again.

## Rerun it

```sh
tests/wallets/run.sh              # all wallets, then the live check
tests/wallets/run.sh --no-live    # without the live check (no faucet coin)
tests/wallets/run.sh okx          # one wallet (the live check runs only when no wallet is named)
tests/wallets/run.sh --debug rabby   # what the wallet's screens show, to fix a driver
tests/wallets/run.sh --update     # accept the packages that are there now
```

`run.sh` needs Docker and a network. It runs in the browser image that `PINS` names (`EXPLORER_BROWSER_IMAGE`), installs the explorer's and the harness's pinned npm packages, fetches the wallets, and writes `tests/wallets/run/` (the seed, the profiles, the downloaded packages: never commit it, and delete it when you are done: `rm -rf tests/wallets/run`; whatever step fails, the files the container made are given back to you on the way out, so that command works) and `tests/wallets/results/`.

**When a wallet updates.** `wallets.json` pins each package by SHA-256 (a GitHub release also by its tag). A newer package makes `fetch.ts` stop: change the tag and asset there for a GitHub release, then run with `--update` to test and record the new package. Read the table: a wallet that does not match the reference, or does not match the others, is the finding. If a wallet's screens changed so that the harness cannot drive it, the row says `not automated` and where it stopped: fix its entry in `src/drivers.ts` (`--debug` shows each screen's text and buttons).

**Adding a wallet.** Add it to `wallets.json` (an official source and, for the store, its extension id) and to `src/drivers.ts` (`generic(...)` takes the wallet's first page, its buttons in order, the text of its ready screen and the address of its pop-ups). Wallets that draw in a frame (`frame`), or that need a narrow window (`narrow`), say so there.

**Tests of the harness itself** need no browser and download nothing: `cd tests/wallets && node --experimental-transform-types --test src/*.test.ts`. The CI job `wallet-harness` runs them (and `shellcheck` on `run.sh`); it never fetches a wallet or opens a browser, so the harness stays opt-in.

## Notes on how it works

- The chain added to each wallet is a stand-in that the harness serves itself (HTTPS with a certificate made for the run, because some wallets add a chain only by an HTTPS address). The browser ignores certificate errors only for that one certificate (`--ignore-certificate-errors-spki-list` with the hash of its public key), and only in the per-wallet run; the live check's browser checks every certificate as usual. The Bridge's chain id is what matters: wallets refuse typed data for a chain they are not on.
- A wallet's own pop-up window is not reliably seen by the browser driver, so the harness opens the wallet's page of pending requests in a tab and clicks what it asks for. A wallet that shows nothing for the page's request is `not automated`.
- `src/probe.ts` is a debug helper: `node src/probe.ts <wallet> [rounds] [path]` opens a wallet and prints what each of its pages shows.
- A wallet screen's text is read only through `describe` (`src/browser.ts`), which takes the seed's words and the unlock password out of it where it is read (`src/scrub.ts`), because a failing screen could show them. The harness's own fixed words in a reason are not changed (so a reason never shows that a word is in the phrase); a last guard takes out the password and any two phrase words in a row. Logs on screen are scrubbed fully (and are not committed).
- The harness's own downloads (the wallets' packages and checksums) carry the project's contact in their User-Agent.
