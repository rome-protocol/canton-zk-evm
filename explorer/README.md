# explorer

A block explorer and faucet for Ostia, a Canton zkEVM (chain id 770101). It shows each block next to its record on Canton, and gives out the chain's test coin, tROME.

The explorer combines EVM data from reth with block records from Canton. The block page's Verify button checks the proof in the visitor's browser and is greyed out while a block is being proven.

## Running it

The explorer runs as a container beside the chain it shows, on the same machine. `run.sh` builds the image and starts it:

```sh
explorer/run.sh setup        # the faucet's key for this run, and a genesis that funds it
CZE_GENESIS_FILE=state/faucet/genesis.json network/up.sh
explorer/run.sh start        # then open http://127.0.0.1:8088
explorer/run.sh stop
```

`setup` comes before the network starts, because reth starts from that genesis (see [The faucet](#the-faucet)). `start` takes what it needs from the run's state folder (`CZE_STATE_DIR`, `./state` by default): the reader party from `canton/parties.env`, the run's own pins from `net/guest.txt` and the faucet's key from `faucet/key`. The caller can set `READER_PARTY`, `PINS_FILE` and `FAUCET_KEY_FILE` instead, and any of the [settings](#settings) below. With no key the faucet is off.

Neither `network/up.sh` nor `run.sh start` runs the builder. A payout waits for the next proven block, so run the builder once per block, as `network/smoke.sh` does: `CZE_LEDGER_USER=builder CZE_BUILDER_PARTY=$(sed -n 's/^BUILDER_PARTY=//p' state/canton/parties.env) CZE_FEE_RECIPIENT=<address> state/venv/bin/python3 builder/builder.py once`. The other settings are in [builder/README.md](../builder/README.md#settings).

The container runs on the host's network, because the explorer reads reth and Canton on the machine's own ports, and it listens on 127.0.0.1 only. It runs as the user who starts it, with a read-only filesystem and no added rights, and it gets the pins file and the key as read-only files. This needs Docker on Linux.

`Dockerfile` has three stages. The first builds the Verify check for WebAssembly with the Rust toolchain that `rust-toolchain.toml` pins. The second builds the pages from the lockfile. The third is the server with the pages and the check's file, and nothing else: no tests and no development packages. Both base images come from `PINS` (`EXPLORER_NODE_IMAGE` and `EXPLORER_RUST_IMAGE`), by digest, and `run.sh` passes them in; the Dockerfile has no image of its own. The recorded session's pins, `prover/fixtures/session.txt`, are in the image, for a run that gives no pins file.

`tests/demo_explorer_static.sh` checks the pins, the Dockerfile and what `run.sh` gives the container, without Docker. The rehearsal in `tests/demo_rehearsal.sh` starts the explorer against the chain it runs, with no GPU. On run 1's block it checks the page (the Canton side, the update id, and that Verify says no, because the rehearsal's proof is a stand-in). It checks that the faucet sends 1 tROME, and refuses the same address a second time. And it checks from a log of the explorer's calls that it asked Canton only for the ledger end and the updates, as the reader party and for the block record alone, and reth only for `eth_`, `net_` and `web3_` methods. The page checks are in `e2e/running.test.tsx`, which runs only when `EXPLORER_URL` and `RUN1_FILE` are set.

## Settings

The server takes its settings from environment variables. A wrong value stops it at start, with a message that names the variable.

| Variable | Default | What it is |
|---|---|---|
| `EXPLORER_HOST`, `EXPLORER_PORT` | `127.0.0.1`, `8088` | Where the explorer listens |
| `RETH_RPC_URL` | `http://127.0.0.1:8545` | The chain's reth HTTP RPC |
| `LEDGER_URL` | `http://127.0.0.1:7577` | The JSON Ledger API of the participant that holds the reader party |
| `READER_PARTY` | none, required | Canton's id for the reader party. The server stops at start, naming it, when it is not set |
| `PINS_FILE` | `prover/fixtures/session.txt` | A file of `key=value` lines with `programVK` and `rootC`: the proving program and ZisK release this explorer expects. A run's `state/net/guest.txt` has the same form |
| `CHAIN_ID`, `CHAIN_NAME`, `COIN_SYMBOL` | `770101`, `Ostia`, `tROME` | How the chain and its native coin are named on every page |
| `RPC_TIMEOUT_MS`, `POLL_MS` | `5000`, `2000` | How long one call to reth may take, and how often the explorer looks for a new block |
| `PUBLIC_RPC` | `0` | Set to `1` to serve the public RPC at `POST /rpc`. See [The public RPC](#the-public-rpc) |
| `RPC_RATE_PER_MINUTE` | `300` | Calls per client address per minute on `/rpc`. A batch counts each of its calls |
| `TRUSTED_IP_HEADER` | none | The request header that holds the client's address, such as `X-Real-IP`, for a server that sits behind a proxy that writes it. With none, the address of the connection is used |
| `TRACKER_FILE` | none | Where the transaction tracker keeps its list across restarts. With none, the list is in memory only. `run.sh` mounts a writable folder for it and sets `/var/lib/explorer/tracker.json` |
| `TRACKER_MAX`, `TRACKER_MAX_BYTES`, `TRACKER_PER_SENDER` | `10000`, `16777216`, `64` | The most entries the tracker holds, the most characters of signed transactions it holds for open entries, and the most open entries one sender may have. See [The transaction tracker](#the-transaction-tracker) |
| `FAUCET_KEY_FILE` | none | The faucet's key. With none, the faucet is off |
| `FAUCET_AMOUNT` | `1` | Coins given per request |
| `FAUCET_PER_ADDRESS_SECONDS`, `FAUCET_MIN_INTERVAL_MS` | `86400`, `2000` | One request per address per day, and the least time between two sends |

## What it reads from reth

Only the `eth_` methods listed in `server/reth.ts`. reth's HTTP port serves `eth`, `net` and `web3`, so the explorer cannot list the pool of waiting transactions. It never uses the builder's WebSocket port or the Engine port, and it never starts a node. The reader refuses any method that is not on its list, before it makes a call.

## What it reads from Canton

Two calls on the JSON Ledger API of the participant that holds the reader party, and no others (`server/ledger.ts`): `GET /v2/state/ledger-end`, and `POST /v2/updates` for the transactions after the last offset the explorer has seen. Every request names only the reader party and the block record template, and asks for the ACS delta. For each block record the explorer keeps the update id, the record time and the record's fields: number, hash, parent hash, header, transactions and proof, and the party ids of the two signers, the chain's operator and confirmer. It reads the builder's and the reader's party ids too, and keeps neither. The reader refuses any call that is not on its list, before it makes it.

`READER_PARTY` must be set. The local network runs without Ledger API authentication, so it is this code, and its test of what it asks for, that keeps the explorer to the reader party's view. The reader party shares the users participant with other parties, and without Ledger API authentication anyone who can reach that participant can read all of them. Do not give the explorer a public address before that changes.

## What a proof says

`server/proof.ts` reads three facts from the bytes of a block's proof: the program key, the ZisK release and the block hash its public values commit to. It compares each with this explorer's pins and with the block the record is for. Reading a value is not verifying the proof. Canton's confirmers verified it when the block committed, and the Verify button runs that check again, in the visitor's browser (see below).

## The index

`server/chain-index.ts` keeps the final blocks in memory, up to Canton's head. There is no database. At start it walks every block record on Canton once, then looks again every `POLL_MS`. For each block it keeps reth's hash, time, transaction count and gas used, the record's update id and record time, the proof's facts next to this explorer's pins, and the record's header, transactions and proof. For each transaction it keeps its block and place, for each contract a transaction created it keeps that transaction, and for each token it reads the name, symbol and decimals once. It keeps the two signers' party ids once per run.

It checks three things. reth's block hash, the hash in the record and the Keccak of the record's header must be the same. Block 1's record must name reth's genesis as its parent. And each record must be the next block in order. A failed check turns the status red and names the block, and so does a read of reth that fails while a block is being read. A failed read of Canton, or of reth's genesis, turns it red and says what failed. The status is also red until the first complete look at reth and Canton has finished (it says when the last one did), and the health check reads that status. A block that is still being proven is not in the index.

A new run is noticed when reth's genesis changes, when reth's block of the newest indexed number is a different block, or when Canton's ledger end is lower than the offset of the newest block record the index holds. With no block held, it reads Canton from the start each time. The index then drops everything and walks again.

## The server and its API

`npm start` runs `server/main.ts`: one process on plain `node:http`. It serves the pages from `dist/` (set `EXPLORER_DIST` to use another folder), gives the home page for any route the pages own, and answers `/api/*`. It follows Canton with the index, and reads reth for what the index does not hold: a block still being proven, a transaction waiting in the pool, an address.

| Route | Answer |
|---|---|
| `GET /api/status` and `GET /healthz` | The same answer. The status code is 200 when reth and Canton can be read and the index's checks pass, and 503 when not. It names the chain, its coin, the pins, the newest final block, the newest ten final blocks (`latest`, newest first, for the home page's list), the block being proven if there is one, and the two signers of the block records |
| `GET /api/block/:number-or-hash` | The block's EVM side, and its Canton side when it is final: update id, record time, proof facts, whether the three hashes match, and the record's proof, header and transactions as hex. Its status is `final`, `proving` or `genesis` |
| `GET /api/tx/:hash` | The transaction, its receipt, the decoded ERC-20 `transfer` if it is one, and its status: `final`, `proving` or `waiting` (in reth's pool, in no block yet). It also carries `state` (`pending`, `proving`, `final`, `replaced`, `dropped`) and `reason`, a plain sentence or null, from the [transaction tracker](#the-transaction-tracker). A transaction that reth no longer holds, but that this chain accepted, still answers with its state instead of 404. A hash that neither reth nor the tracker knows is 404 |
| `GET /api/address/:address` | Balance, count of sent transactions, whether it is an account, a contract or a token, and the transaction that created it, if a block the index holds did |
| `GET /api/search?q=` | The page to open for what was typed (a block number, a block or transaction hash, an address or a Canton update id), or 404 |
| `GET /api/faucet` | Whether the faucet is on, its address, its balance, what it gives per request and how long an address waits between requests |
| `POST /api/faucet` | Gives the coin to the address in the body, `{"address": "0x…"}`. See [The faucet](#the-faucet) |

Amounts are whole numbers as decimal strings, in the coin's smallest unit. Each answer, and each object inside it, carries exactly the fields listed in `FIELDS` in `server/api.ts`, built one field at a time; the field test gives the server objects with extra fields and checks that none gets through. No raw Canton answer reaches the API, and no party id except the two signers of the block records. A request target that is not a path is a 400, and a route that does not exist is a 404. A failed read of reth or Canton is a 502 with a plain message, and the detail goes to the server's log.

## The public RPC

With `PUBLIC_RPC=1` the server answers `POST /rpc`, the address a wallet adds as its network. It forwards to reth, but it shows only what is final on Canton.

**The guarantee: a receipt from Ostia's RPC means the block is proven and final on Canton.** reth makes a new block its head while the block is still being proven, and goes back if Canton refuses it. The public RPC never shows that block. Its view of the chain ends at reth's finalized block, which is Canton's head.

- `latest`, `safe`, `pending` and `finalized` all mean the finalized block, and `eth_blockNumber` is its number. The one exception is `eth_getTransactionCount` with `pending`, which counts the transactions in the pool, so a wallet picks its next nonce well.
- A block read for a number above the finalized block answers `null`. A state read (balance, code, storage, count, call, estimate) at such a number is an error that says the block is not final yet.
- A block, transaction or receipt looked up by hash answers `null` while its block is above the finalized one. A transaction that is in the pool and in no block may be returned, with a null block number.
- `eth_getLogs` is cut at the finalized block. A filter by block hash for a block that is not final answers an empty list.
- A block, a transaction and a receipt are read after the finalized number, and are shown only when the block is the one reth has at that height. A block that was refused and replaced by another at the same height is never shown.
- A block hash given as a plain 0x string works as a block argument, as it does on reth, and a block that is not final is answered like a number above the finalized one.
- `eth_sendRawTransaction` reads the transaction first: it takes the hash, the sender, the nonce and the chain id, and refuses a transaction signed for another chain. It asks the tracker whether it can follow the transaction, and refuses with -32005 when it cannot (see the limits below). Then it forwards the transaction and returns reth's answer as it is. Every transaction reth accepts is handed to the tracker, and so is one that reth answered "already known" to, or one whose answer did not come in time. If the tracker fails, the send still returns reth's answer.

The methods are `eth_chainId`, `net_version`, `web3_clientVersion`, `eth_syncing`, `eth_blockNumber`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`, `eth_call`, `eth_estimateGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_feeHistory`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getLogs` and `eth_sendRawTransaction`. Any other method answers -32601.

Limits: a body of at most 256 KiB (413 above it), a batch of at most 20 calls, and a token bucket for each client that holds `RPC_RATE_PER_MINUTE` calls and refills steadily (429 with `Retry-After` when it is empty). An IPv6 client is one client for its whole /64, so changing the last half of an address gives no new bucket. All clients together may have 64 requests being answered at one time, and a request past that gets 503 with `Retry-After: 1`, so that many addresses cannot saturate reth. The client address is the connection's address, or, when `TRUSTED_IP_HEADER` names a header, the last address in that header. Use `TRUSTED_IP_HEADER` only when the port can be reached only through a proxy that you run and that writes the header. If clients can reach the port directly, they can write the header themselves and choose their own bucket. An unexpected error inside `/rpc` is answered as a JSON-RPC error with the CORS headers, so a browser page can read it. A call to reth that takes longer than `RPC_TIMEOUT_MS` is answered with an error, and the detail goes to the log. The pages show an "Add Ostia to your wallet" button and the RPC address on the home page and the faucet page when the RPC is on (`publicRpc` in `/api/status`).

## The transaction tracker

The tracker is what stops a transaction that Ostia accepted from being lost without a word. It keeps every accepted transaction with its signed bytes until the transaction is settled, and looks at the open ones every `POLL_MS`.

| State | Meaning |
|---|---|
| `pending` | In reth's pool, in no block |
| `proving` | In a block that Canton has not committed yet |
| `final` | In a block that is final on Canton. The tracker keeps the block and, when the index holds it, the Canton update id |
| `replaced` | Not in the chain, and the finalized nonce of the sender is past it: another transaction took its place |
| `dropped` | It went missing and was sent again `10` times, reth refused it `5` times in a row when it was sent again, or the tracker was full and stopped following it (the reason says which) |

A transaction that is in no block and not in the pool (a block was unwound, or reth forgot it) is sent again from the saved bytes, at most once every five seconds, and the tracker counts the sends. The transaction page says it was sent again.

A wallet's speed-up or cancel puts a new transaction on the same nonce. While that one is in the pool or being proven, reth refuses to take the old one again ("nonce too low" or "replacement transaction underpriced"). The tracker does not count that as a failure. It keeps the old transaction open, and calls it `replaced` when the sender's finalized count passes its nonce. If the other transaction goes away first, the old one is sent again.

The tracker is bounded by count and by size. `TRACKER_MAX_BYTES` limits the signed bytes it holds for open entries, and `TRACKER_PER_SENDER` limits the open entries of one sender, so a few funded accounts cannot fill it with transactions that cannot be mined. `eth_sendRawTransaction` asks the tracker before it forwards a transaction, and refuses it when the tracker is full, so a transaction is never accepted and then not followed. `TRACKER_MAX` limits all entries. When it is reached, settled entries go first, oldest first. If the list is still too long, the oldest open entry is marked `dropped`, with the reason, and the server's log names it. It is never forgotten without a word, and the chain may still mine it.

With `TRACKER_FILE` set, the list is written to a temporary file that is then renamed over the real one, so a crash never leaves half a file. A burst of sends is one write, a second or so after the last change, and nothing is written when nothing changed. On SIGTERM or SIGINT the server stops, writes the list and then exits, so the transactions accepted just before a restart are in the file. `run.sh` mounts `<state>/explorer` as the only writable folder of the read-only container, and the list lives there.

The Canton update id of a final transaction is filled in when the index holds the block, which can be a poll after reth's finalized number passes it.

## The pages

The pages are a small React app in `src/`, built by Vite into `dist/`, which the server serves. `npm run build` makes the build, and `npm run dev` serves the pages while you work on them, with `/api` passed on to a server on the default port.

Every page has the same header (the chain's name and id, which link home, a search box and a link to the Faucet) and ends with the same line about how the explorer reads Canton. The name and the id come from `/api/status`; until it has answered, the header says Ostia. Search sends what was typed to `/search?q=`, which asks the server what it is and opens that page, so a search is also a link. Nothing found says so, in the server's own words, and so does a block, transaction or address that does not exist.

- **Home** shows the status strip, the newest ten final blocks and a box saying what the explorer can and cannot show. It asks for `/api/status` again every two seconds. The strip and the server's health check read the same answer, so they cannot disagree. The time to commit shown is Canton's record time minus the block's timestamp, rounded to whole seconds. The timestamp comes from the builder's clock, in whole seconds.
- **Block** (`/block/:number-or-hash`) shows the block's EVM side from reth next to its Canton side: the update id, the commit time, the record and the two parties that signed it, whether reth's hash, the record's hash and the hash of the record's header agree, and the three facts read from the proof (program key, ZisK release, block hash) next to this explorer's pins. A fact that does not match is shown in red with the value that was read; a proof that is not 1,344 bytes gets one red line instead. Under the two sides come the line saying Daml legs are not shown (with no count), the same five steps for every block with only the two measured times, the block's transactions, and the record's data (proof, header and transactions, with their sizes and a copy button each). A block that is still being proven shows its EVM side and says it is not on Canton yet; block 0 is shown as Genesis and checked against block 1's record. The page looks again every two seconds until the block is final, and says Not found when Canton refuses a block that was being proven. The Verify panel sits between the transactions and the record's data, and is greyed out while the block is being proven.
- **Transaction** (`/tx/:hash`) shows the result, the block and its Canton update, who sent it and to whom, the decoded ERC-20 transfer, the value, the fee at its price, the gas, the nonce, the type, the input and the logs. A transaction that is not final says so and where it is on the way (Waiting, Being proven, Final, or Replaced or Dropped, with the reason in plain words), and the page looks again every two seconds until it is settled. Only a page reached by the transaction's hash can say Waiting.
- **Address** (`/address/:address` and `/token/:address`, the same page) shows the balance in the chain's coin from reth's newest block and, for an account, the number of transactions it has sent. A token is named by its own name and symbol, and shows its decimals; a contract or token that a block the index holds created names the transaction and the block.
- **Faucet** (`/faucet`) is the faucet page. See [The faucet page](#the-faucet-page).
- A route that no page owns answers "Not found".

Colours are variables in `src/styles.css`, light by default and dark when the system asks for it. There is no switch and nothing is stored. Times are UTC. Every hash is shown shortened, with a button to copy the whole value and one to read it in full.

The fonts are IBM Plex Sans and IBM Plex Mono, served by the explorer from `public/fonts` (SIL Open Font License; the licence texts sit next to the files). The pages load nothing from another host, and a test holds them to that.

## The faucet

It gives the chain's own test coin, and nothing else: 1 tROME per request (`FAUCET_AMOUNT`). There is no login and no captcha, because the coin has no value. Two limits keep it from being drained, and both live in memory, so a restart forgets them:

- one request per address per 24 hours (`FAUCET_PER_ADDRESS_SECONDS`);
- one send at a time, at least 2 seconds apart (`FAUCET_MIN_INTERVAL_MS`).

At those settings the faucet can give away about 43,000 coins a day, out of the million it starts with. A limit per IP address waits until the explorer has a public address.

| Answer | When |
|---|---|
| 200 | The coin was sent. The body has the transaction's `hash`, the address (`to`) and the `amount` in the coin's smallest unit |
| 400 | The body is not JSON, or has no address, or the address is not 0x and 40 hex digits |
| 429, with `Retry-After` in seconds | The address was served in the last 24 hours (`reason` is `address`), or another send is under way or finished less than 2 seconds ago (`reason` is `busy`) |
| 503 | The faucet is off (no key), empty, or cannot reach reth, or reth refused the transfer |
| 413 | The request body is bigger than 1 KB |

Each payout is a plain transfer of 21,000 gas, an EIP-1559 transaction signed with viem. Its nonce is reth's pending count, so if Canton refuses a block and the payout disappears, the next send takes the same nonce. The coin arrives with the next proven block: blocks are made only while the chain's builder runs.

**The key.** `faucet-setup.sh` makes a fresh key for each run in `<state>/faucet/key` (readable by its owner only, never printed, never committed) and writes a copy of the run's genesis that also funds it with 1,000,000 coins (`FAUCET_FUND` sets the amount). The genesis it copies is the one `CZE_GENESIS_FILE` names when that is set, and `network/genesis.json` otherwise. Run it before the network starts, because reth starts from the file `CZE_GENESIS_FILE` names; `network/make-state.sh` still refuses a genesis whose chain settings differ, so funding an account cannot change the rules the proof pins.

To run the server directly, use Node 22.18 or newer and the Rust toolchain in `rust-toolchain.toml`. From the repository root:

```sh
(cd explorer && npm ci)
explorer/faucet-setup.sh
CZE_GENESIS_FILE=state/faucet/genesis.json network/up.sh
cd explorer
rustup target add wasm32-unknown-unknown
npm run build:verify
npm run build
READER_PARTY=$(sed -n 's/^READER_PARTY=//p' ../state/canton/parties.env) \
  PINS_FILE=../state/net/guest.txt \
  FAUCET_KEY_FILE=../state/faucet/key npm start
```

The example uses the default `state/` folder. Set the three file paths to the run's state folder if it differs.

The server reads the key only when `FAUCET_KEY_FILE` is set; without it the faucet is off. A key file that is missing or does not hold 64 hex digits stops the server at start, and the message does not quote the file. Nothing mints and nothing tops the faucet up: the next run makes a new key. The key never appears in an answer or in the log, and the tests check that.

## Tests

From the repository root:

```sh
cd explorer
npm ci
npm run typecheck
npm test
npm run build
```

The page tests (`src/**/*.test.tsx`) render the pages with Testing Library against a fetch that answers as the server's API does; their status answer is held to the fields the server serves. The tests run against a small fake reth (`test/fake-reth.ts`) and a small fake Ledger API (`test/fake-ledger.ts`), so they need no chain and no GPU. The proof tests read the recorded proof in `demo/results/run1-proof.hex` and check it against the pins in `prover/fixtures/session.txt`.

One more check runs in CI only. `check-ledger-api.sh` starts the participants of the pinned Canton, saves the OpenAPI document that Canton writes about its own Ledger API, and `server/ledger.openapi.test.ts` checks the explorer's requests against it, field for field, and the fake's answers for their shape. Set `CANTON_OPENAPI` to a JSON copy of such a document to run it yourself; without it, those tests are skipped. CI runs them in the Node image that `PINS` names (`EXPLORER_NODE_IMAGE`). The packages are pinned to exact versions in `package.json` and `package-lock.json`.

## Verify

`verify/` is a small Rust crate that builds the sidecar's own block check for WebAssembly, and `src/verify/verifier.ts` loads it and runs it on a block's `proofHex`, `headerHex` and `txsHex` and the two pins from `/api/status`. `src/verify/VerifyPanel.tsx` is the card the block page shows: "Verify this block in your browser". It is a component of its own and takes everything as props (the record's three fields, the block's hash from reth, the pins with their file, whether the block is still being proven, and where the `.wasm` is served from), so the page only has to hand it what `/api/block` and `/api/status` give. The block page hands it the record, the block's hash, the pins from `/api/status` and the file's size. It downloads the module when the visitor presses Verify, and not before, once per panel.

The panel has five looks: not run; running; passed, with what was checked; failed, with the check's own reason; and greyed, with its button off, while the block is being proven (there is no record to check yet). A pass counts only if the block hash the proof commits to is the hash reth gives for this block. Passed and failed both show how long the check took in the visitor's browser (the check alone, not the download) and the size of the file that was downloaded. `moduleSize` is optional: give it to say how big the download is before the button is pressed. The block page reads it from the length in the server's answer to a HEAD request for the file, so nothing is downloaded to learn it, and leaves it out when the server does not say. The panel's styles are in `VerifyPanel.css`, scoped to `.verify`, and take their colours from the page's theme variables.

The check holds the page while it runs. In Node on GitHub's CI runners, one check took 8 to 32 ms. The timed check verifies the recorded proof, then refuses a header that does not match it. That is not a successful full-block check or a browser measurement. See [verify/README.md](verify/README.md). The explorer serves the module from `/verify/zk_explorer_verify.wasm`. `npm run build:verify` builds it (it needs Rust's `wasm32-unknown-unknown` target) and puts it in `public/verify/`, which git leaves out; `npm run build` then copies it into `dist/verify/` with the rest of the pages. Without it the Verify button says the check could not be downloaded. The `verify-wasm` job in `.github/workflows/explorer.yml` builds the module, checks that the pages' build serves it, and runs when the sidecar, the verifier or the trie checker change.

## The faucet page

`src/faucet/FaucetPage.tsx` is the page's content: the form, and each way a request can end. It sends the address typed, then shows one of these:

- sent: the transaction's link and the word Waiting, which the transaction's page moves on to Being proven and Final;
- the address has had its coin in the last 24 hours, with the wait from `Retry-After`;
- another request is being sent, with the wait, and the button stays off until it is over;
- not an address, or the faucet is empty or cannot reach the chain, in the server's own words.

It also says whether the faucet is on. With no key it shows that the faucet is off and no form. It shows the faucet's address and balance from `GET /api/faucet`, and reads the balance again after a send. The page takes the coin's name and decimals as a prop (the status answer has them), and a client for the two routes (`src/faucet/faucet-client.ts`) as another, so a test can give its own.

The Faucet route renders it with the coin from `/api/status`. The page is a component, rendered inside the explorer's router and shell: it draws no header or footer. Its styles are in `src/faucet/faucet.css`, all under `.faucet-page`. Its colours are the explorer's own names and values, set at the lowest weight, so the shell's set wins where it has one.
