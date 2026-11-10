| Wallet | Version | Package source and SHA-256 | Same signature twice | Same after restart | Matches reference | Matches other wallets | Opens on the live Bridge | Date |
|---|---|---|---|---|---|---|---|---|
| MetaMask | 13.56.0 | [package](https://github.com/MetaMask/metamask-extension/releases/download/v13.56.0/metamask-chrome-13.56.0.zip) `7618eda1fba0ca2068054b69faddb5c511dbb49e7d8e3ad411a8ab90551c7159` | yes | yes | yes | same bytes | yes (2026-11-10) | 2026-11-10 |
| Rabby | 0.94.15 | [package](https://github.com/RabbyHub/Rabby/releases/download/v0.94.15/Rabby_v0.94.15.zip) `747eb5106352271e5bed051e970ce3e1dbffa16a2a777db529fa9994e5943ad7` | yes | yes | yes | same bytes | yes (2026-11-10) | 2026-11-10 |
| Coinbase Wallet | 3.151.0 | [package](https://chromewebstore.google.com/detail/hnfanknocfeofbddgcijnmhnfnkdnaad) `3216930a51551555b819219331c46129229fe7fbc3a27b586d3ffd3a208b0096` | not automated | not automated | not automated | not automated | not tried | 2026-11-10 |
| OKX Wallet | 4.23.0 | [package](https://chromewebstore.google.com/detail/mcohilncbfahbmgdjkbpemcciiolgcge) `4ccaf8d2faaca6266a5fcfa205d48f91d719b40603eeee6bd5faa18ac1616a6f` | yes | yes | yes | same bytes | not tried | 2026-11-10 |
| Phantom (EVM) | 26.38.1 | [package](https://chromewebstore.google.com/detail/bfnaelmomeimhlpmgjnjophhpkkoljpa) `425473795f87c2b8d7a47f60285b841f6fa6c4239fa6e52e2aa3b5e21fbbf97a` | not automated | not automated | not automated | not automated | not tried | 2026-11-10 |

Not covered: hardware wallets (Ledger, Trezor) and smart-contract wallets, which this harness cannot test (see [Not covered](../README.md#not-covered) in the README), and any wallet or version that is not in the table.

Notes on the wallets that were tested:
- OKX Wallet: Its screens are driven less reliably than the others': in one rerun a run stopped at the second signature (no signature in 90 s while the approval loop kept clicking Confirm), and an immediate rerun of this wallet alone passed with four identical signatures. If a run says 'not automated' for this wallet, run it again (tests/wallets/run.sh okx) before replacing a good row.

The live check (2026-11-10) was made with the throwaway account of an earlier run (`1220ec1eb66af7e2…`), not this run's (`122039f624847361…`); its verdict stands for the package it was made with.
The live check (2026-11-10) was made by an earlier version of the harness, before the signing guard that approves only the Bridge's request (it records no refused signatures).
A later live check (2026-11-10) reached no account: the account service refused to make a new account (429: it limits the new accounts one client (IP address) makes in a day, --accounts-per-day in apps/accounts/README.md; it said to retry after 70432 s).

Browser: Chromium 156.0.0.0 in mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf.

Not automated or not run, and why:
- Coinbase Wallet: stopped at "run 1: connect": no approval screen was reached in 90 s (run 1 connect). Earlier attempts found: The wallet was set up with the seed phrase. It then opened no approval screen for the page's connect request, with the page using either the wallet's EIP-6963 provider or window.ethereum, and with the request started by a real click. The wallet's own pop-up address, opened by hand, showed its home screen and not the request.
- Phantom (EVM): stopped at "run 1: connect": no approval screen was reached in 90 s (run 1 connect). Earlier attempts found: Its set-up asks for a username and checks it online; that check did not finish reliably from the test machine (it did in earlier attempts). When set-up did finish, the wallet opened no approval screen for the page's connect request, as with Coinbase Wallet. Whether it signs typed data for a chain id it does not list was not reached.
