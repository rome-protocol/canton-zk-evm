# network

Runs Ostia, a Canton zkEVM (chain id 770101), on one machine: reth, two sidecars, the prover and a local Canton network. `up.sh` starts the services, `smoke.sh` runs the end-to-end check, and `down.sh` stops them. See [docs/DESIGN.md](../docs/DESIGN.md) for the design.

| File | What it is |
|---|---|
| `genesis.json`, `make-state.sh` | The chain's genesis, and the per-run state (the Engine secret, and the genesis that reth reads: the chain's genesis, or the one `CZE_GENESIS_FILE` names, plus the gateway contract from `gateway/` at `GATEWAY_ADDRESS`) |
| `reth/` | `launch.sh` is the only way reth is started. Peer discovery is always off. `check.sh` proves it is off, `stop.sh` stops it |
| `canton/canton.conf` | One synchronizer and three participants, all in memory, all on localhost |
| `explorer-db.sh` | The explorer's own PostgreSQL, beside Canton's (see [The explorer's database](#the-explorers-database)) |
| `canton/canton-persistent.conf`, `postgres.sh` | The persistent mode: the same nodes in PostgreSQL, and the database that holds them (see [Keeping the chain across restarts](#keeping-the-chain-across-restarts)) |
| `canton/bootstrap.canton` | Starts the nodes, connects the participants, creates the parties (the gateway party among them) and Ledger API users, uploads and vets the Daml package |
| `canton/run.sh`, `canton/resume.canton` | Start Canton and wait until it is ready: `run.sh bootstrap` runs `bootstrap.canton`, and `run.sh resume` (persistent mode only) starts the nodes on the databases they kept and runs `resume.canton`, which creates nothing |
| `canton/propose.py` | The operator and the gateway propose the chain and the confirmer accepts it. `propose.py token` does the same for a token: it registers a Canton instrument against the wrapped token on the EVM |
| `canton/fetch.sh`, `canton/fetch-jar.sh`, `canton/check-damlc.sh`, `canton/build-dar.sh`, `canton/dar-id.sh` | Install the pinned Canton and Daml tools and check them, build the real form of the Daml package with them, and print the DAR's SHA-256 and package id |
| `external/setup.py`, `external/sidecar.sh`, `external/participant-config.sh`, `external/check-env.sh` | Ostia on a participant that exists already (see [Running on an existing participant](#running-on-an-existing-participant-the-canton-network)): the setup, the lone sidecar, the participant's configuration line, and the check of the settings |
| `check-program-vk.sh` | Stops `up.sh` when the guest it built has a programVK other than the recorded one |
| `up.sh`, `down.sh`, `persist-settings.sh` | Start and stop everything. `down.sh` keeps a persistent chain's data, and `down.sh --wipe` removes it, says "wiped" only when the database and reth's data are really gone, and otherwise says what is left and exits with an error (`persist.env` stays, so it can be run again) |
| `restart.sh`, `sync_reth.py` | Bring a persistent chain back after a restart, and make reth's head Canton's head |
| `smoke.sh`, `prove-timed.sh` | The smoke test, and the prover command it hands the builder (it keeps the prover's output so the proof time can be read) |

## The Canton network

One synchronizer (a sequencer and a mediator) and three participants:

| Participant | Hosts | Sidecar |
|---|---|---|
| `operator` | the operator, the builder and the gateway | yes, on 8085 |
| `confirmer` | the confirmer | yes, on 8086 |
| `users` | U, V, the test token's registry and the reader | none |

The Daml package calls the extension `canton-zk-evm` (`DA.ExternalCall`). Each confirming participant sends that extension to its own sidecar: the operator's to 8085, the confirmer's to 8086. The users participant has no extension, because it is never asked to run the call: it only receives the block record, as an observer. By default everything is in memory, so a restart is a new network (with `CZE_PERSIST=1` it is not: see below), and everything listens on 127.0.0.1. The network runs without Ledger API authentication; it is for one machine and one run.

The gateway is the party that holds the Canton tokens that are locked for their wrapped forms on the EVM. It lives on the operator's participant, and the operator's Ledger API user acts as both the operator and the gateway, because the two sign the chain and each token's registration together. The builder reads as the operator and the gateway and acts as neither. The custody is therefore only as safe as that participant: whoever runs it can move what the gateway holds. That is acceptable for a local network where we run every party, and it is not for anything of value.

The chain record names the gateway party and the address of the gateway contract (`GATEWAY_ADDRESS` in `PINS`, given to `propose.py` by `up.sh`). Before it proposes the chain, `up.sh` checks that block 0 of the reth it started holds exactly the code in `gateway/Gateway.bin-runtime` at that address, because the genesis state root in the chain record fixes that code for the life of the chain.

To register a token, the operator and the gateway propose that the wrapped token at an EVM address stands for a Canton instrument (its admin and id), whose registry's transfer factory is a given contract, and the confirmer accepts:

```sh
python3 network/canton/propose.py token --evm-token <address> --instrument-admin <party> --instrument-id <id> --factory <contract id>
```

Registering a token is a trust decision, because the gateway runs that registry's Daml code with its own authority. `propose.py` makes the check a confirmer should make: it asks reth, at the finalized block (the one Canton has committed), whether the gateway contract made that token, and stops if it did not. Then it accepts at once, as it does for the chain.

The JSON Ledger API of each participant is on 7575 (operator, the one the builder uses), 7576 (confirmer) and 7577 (users).

### Which Canton

The external call requires Canton 3.6 and Daml-LF 2.4. Both are released: open-source Canton 3.6.3 (2026-10-20, the version the Canton Network's DevNet runs; the external call first came in 3.6.1) and the Daml 3.6 SDK, whose compiler is damlc 3.6.2 (the registry also has a Daml SDK 3.6.2, released 2026-10-20, with the same damlc 3.6.2; moving the SDK pin would change nothing the network uses, so the SDK and compiler pins stay). `PINS` records the exact versions and SHA-256 hashes of the Canton release tarball and its jar, the `dpm` program and the SDK manifest. The jar is taken out of the release tarball by `canton/fetch-jar.sh`, which checks the tarball before it opens it and the jar after, and refuses either one if it has changed. The SDK manifest names every other component, including the compiler, by exact version; its own Canton (3.6.1) is not the one the network runs. A registry tag can be replaced with different contents, so `PINS` also records the compiler's registry manifest SHA-256 (`DAMLC_LINUX_AMD64_MANIFEST_SHA256`). That manifest lists every compiler file by SHA-256, which `dpm` checks on download. `canton/fetch.sh` checks all these pins and uses `canton/check-damlc.sh` to check the compiler before and after installation. `smoke.txt` records the built DAR's SHA-256 and main package id.

The network uses the open-source Canton jar. The compiler builds the Daml package to LF 2.4 (`daml/build.sh external` defaults to that target) with the real external call. Canton 3.6.3 supports protocol versions 34, 35 and 36, and `canton.conf` sets none of them, so the network runs on the release's default and needs no development flags. `bootstrap.canton` reads the synchronizer's protocol version and stops unless it is 36, the one the Canton Network adopts with Canton 3.6, and `tests/canton_network.sh` checks that the log says so. The recorded runs in `demo/results/` were made before this move, on 3.6 snapshots of Canton and the compiler; their files name the snapshot versions and are left as they were.

## Running it

You need a Linux x86-64 machine with an NVIDIA GPU and its driver installed, Docker, Rust, Python 3.12 or newer, `jq`, `curl` and `openssl`. The builder needs Python 3.12 or newer to read Canton's times. Install ZisK with `prover/install.sh`. That installer needs `sudo`, `apt` (Debian or Ubuntu) and about 100 GB of free disk. It installs system packages and changes the memory-lock limits. `canton/fetch.sh` installs Java 21 if it is missing.

The recorded runs used one NVIDIA RTX PRO 6000. The benchmark recorded about 28 GiB of GPU memory for the PLONK wrap alone and 22.9 GiB of shared memory for the emulator. The minimum GPU memory for the whole prover is not established here. See [docs/METRICS.md](../docs/METRICS.md#the-machine) for the tested hardware and memory measurements.

```sh
network/up.sh       # tools, guest build, reth, sidecars, prover, Canton, the chain
CZE_SOURCE_COMMIT=$(git rev-parse HEAD) network/smoke.sh    # one empty block, proven and committed
network/down.sh
```

For a source export without `.git`, set `CZE_SOURCE_COMMIT` to the full hash of the commit it was built from. State, logs and pid files go to `state/` (or `$CZE_STATE_DIR`), which git ignores. The Engine secret and the party ids are made per run.

`up.sh` also builds the guest. ZisK's root key, the chain rules' hash and the program key (`programVK`) must all be the ones recorded in `prover/fixtures/session.txt`, or it stops before it starts anything, and says which key it built and which is recorded. The sidecars and the chain are pinned to that key. The program key is that of the ELF. The guest build does not depend on the folder it is run from (`prover/build-guest.sh`; two fresh checkouts gave the same key on real ZisK on 2026-10-04, see `guest/README.md`), but that was shown for one machine and one user, so a build that gives another key is refused rather than run. The chain is proposed with genesis = reth's block 0: its hash and its state root, which is the parent state of the first block.

## Keeping the chain across restarts

A chain that people use must come back with its history after a process crash, a reboot, or a machine that was stopped and started. By default `up.sh` makes a new chain on every run, so nothing survives. With `CZE_PERSIST=1` the chain is kept:

```sh
CZE_PERSIST=1 network/up.sh          # the first start: a new chain, kept
network/down.sh                      # stops everything and keeps the data
network/restart.sh                   # after a reboot: the same chain comes back
network/down.sh --wipe               # stops everything and removes the chain for good
```

What persistent mode changes, and what it does not:

- **Canton** keeps the synchronizer, the sequencer, the mediator and the three participants in PostgreSQL, one database each (`canton/canton-persistent.conf`, added as a second `-c`). The ZkChain contract, every block record and every Canton holding are in those databases. The Daml package, the parties and the Ledger API users are too.
- **The database** is one PostgreSQL, started by `postgres.sh`. Its image is pinned by digest in `PINS` (`POSTGRES_IMAGE`). It listens on 127.0.0.1 only (port 5432, or `CZE_PG_PORT`), and its data is in the Docker volume `cze-postgres-data`. Its password is made on the machine, once, into `$CZE_STATE_DIR/postgres.env` (mode 0600). It is never printed and never committed. Docker reads it from that file, and Canton gets it through its environment.
- **The explorer's database** is a second PostgreSQL, started by `explorer-db.sh` (by `up.sh` and `restart.sh`, and stopped by `down.sh`), in its own container with its own volume and password. This database stores explorer data; Canton keeps its own. See [The explorer's database](#the-explorers-database).
- **reth** keeps its data in `$CZE_STATE_DIR/reth-data` instead of the Docker volume that a normal stop removes. It also writes every block to disk as soon as it imports it (`--engine.persistence-threshold 0` and `--engine.memory-block-buffer-target 0`, which `launch.sh` requires in this mode). reth's default keeps the newest seven blocks in memory, and a hard kill, an out-of-memory kill or a power loss would then leave it behind Canton, which has already committed those blocks. The builder imports a block about 7 s before Canton commits it, so this costs no block time. `reth/launch.sh` is still the only way reth is started: peer discovery is off, there are no peers and no published p2p port, and every check in `launch.sh` and `check.sh` runs on a restart as on the first start.
- **The Engine secret and the genesis** stay in `$CZE_STATE_DIR` (`jwt.hex`, `genesis.json`), and a restart reuses them. `persist.env` there records the Canton version, the chain id, and the names and ports of the database container and of reth's container (`persist-settings.sh`). `restart.sh` and `down.sh` use those, so they act on the same containers as the run that made the chain, and refuse an environment variable that names another. It marks the folder as a persistent chain: `up.sh` will not start a new chain over it, with or without `CZE_PERSIST`.

`restart.sh` starts, in this order: the database, reth on its data, both sidecars (Canton asks them when it starts), the prover, and Canton (`run.sh resume`). It proposes no chain, makes no secret, builds no guest and does not run `bootstrap.canton` again. It stops if there is no persistent state (it says what is missing and how to start a chain), if the databases were made by another Canton version than the one in `PINS`, or if a service is still running. A persistent chain made on an earlier Canton pin is therefore refused after the pin moves: keep the old `PINS` on that machine until it is rebuilt, or wipe it (`network/down.sh --wipe`) and start a new chain with `CZE_PERSIST=1 network/up.sh`. When Canton is back it checks that the DAR's package is on the operator's participant, and then makes reth's head, safe and finalized block Canton's head, which is what the builder does before it builds (`sync_reth.py`), and prints the head. If the builder was stopped with an Advance that had no answer, its in-doubt record (`unresolved.json` in the builder's work folder) is settled first, the builder's own way (the command's completion, or Canton's head once Canton's own time, from the checkpoints of the completions stream, is past its window; this can wait about `CZE_RESOLVE_SECONDS`), because that command may still commit and Canton's head says nothing until then. `sync_reth.py` holds the work folder's lock meanwhile, and refuses to run while a producer holds it (it prints `in_doubt_command`, `in_doubt_committed` and `in_doubt_resolved` when it settled one). Then:

| reth after the restart | What happens |
|---|---|
| on Canton's head | nothing moves |
| ahead of Canton, with an in-doubt record (the stop came after the block was submitted) | the record is settled first: if the command committed, reth keeps the block and it is Canton's head; if it failed or never committed, reth goes back as in the next row |
| ahead of Canton, and no in-doubt record (it built a block that Canton never committed, usually because the stop came while a block was being proved) | reth is moved back to Canton's head and the block is dropped, but its transactions are not: they are read first and sent to reth again afterwards, and `restart.sh` prints how many (`dropped_transactions`, `resent_transactions`). One that reth refuses, because its nonce is used already, is skipped |
| behind Canton (Canton committed a block that reth lost) | an error. reth cannot build the next block from data that lacks Canton's head, so this stops with both heads named. A graceful stop writes everything out, and so does a crash of reth in this mode, so this means reth's folder is older than the chain's (a restored backup of the folder, say) |

**The first block of a persistent chain.** In this mode reth writes every block to disk at once, and then it cannot move its head back to the genesis block: `engine_forkchoiceUpdatedV3` to block 0 fails with "no state found for block 0x00...00" (reth looks for the state of genesis's parent). Moving back to any later block works. So if the first block of a new chain failed (the prover not ready, a wrong prover setting), every later attempt would fail at its first forkchoice and the producer would be stuck at genesis for good. The rule: a new persistent chain never rests at head 0 with anything built on it. When `CZE_PERSIST=1 network/up.sh` has proposed the chain, it commits an empty block 1 (the builder's `once`, as `smoke.sh` does) before anything else may build, and it stops with an error, telling you to wipe and start again, if that block does not commit. The report is kept in `$CZE_STATE_DIR/net/block1.json`. `restart.sh` does not do this: the chain it brings back is past genesis already. Because of it, `smoke.sh`, which needs a chain at head 0, is for a network started without `CZE_PERSIST`. The in-memory mode is as it was.

When the builder fails and then cannot move reth back either, its report keeps the first error in `error` and puts the failed move in `rewindError`, so the cause is never hidden by the clean-up (see `builder/README.md`).

The chain's history is as safe as the machine's disk. Back up the databases (`pg_dump` of the five) and `$CZE_STATE_DIR/reth-data` together, taken while the network is stopped, if you need a copy.

`tests/canton_persist.sh` runs this on the real Canton: one Advance, then Canton killed (`kill -9`) and the database stopped, both started again the way `restart.sh` does, and the chain must be the same contract at the same head with the same block hash, with the block record still visible to the reader, the party list unchanged, and no second bootstrap.

### The explorer's database

The explorer and its indexer keep their data in a PostgreSQL of their own. It is not Canton's database. The explorer's heavy queries (long lists, stats rollups, a rebuild of the index) run on a server of their own, so they do not share Canton's connections, locks or cache. Both servers run on the same host and share its CPU, memory and disk: `explorer-db.sh` sets no limits, and no test measures how one affects the other. `explorer-db.sh` runs it, with one database (`explorer`) and one user (`explorer`).

| What | Value |
|---|---|
| Image | The one `PINS` names as `POSTGRES_IMAGE`, the same digest as Canton's database |
| Container and volume | `cze-explorer-db` (or `CZE_EXPLORER_DB_CONTAINER`), with the Docker volume `<container>-data`, so the data outlives the container |
| Address | `127.0.0.1:5433` (or `CZE_EXPLORER_DB_PORT`), never a public address. The explorer containers run with `--network host` and reach it there |
| Password | Made once on the machine with `openssl rand -hex 24`, into `$CZE_STATE_DIR/explorer-db.env` (mode 0600, as the line `POSTGRES_PASSWORD=...`). It is never printed and never committed. Docker reads it from the file (`--env-file`), and the explorer reads it through `EXPLORER_DB_PASSWORD_FILE` |
| Settings | `fsync` stays on, so a crash cannot lose a committed block. `max_connections=100`. The container runs with `no-new-privileges` |
| Schema | Not made here. The explorer applies its own migrations (`node server/db/cli.ts migrate`), which `explorer/run.sh start` runs first |

```sh
network/explorer-db.sh start   # starts it, or starts the stopped one, waits for three answers in a row, makes the database if the volume lacks it
network/explorer-db.sh stop    # stops it and keeps the data
network/explorer-db.sh wipe    # removes the container, the volume and the password file; fails, and says what is left, if any of them stays
```

`up.sh` (with `CZE_PERSIST=1`) and `restart.sh` call `start`, and `down.sh` calls `stop`. If it does not start, they print a warning and go on: the chain does not depend on the explorer. `down.sh --wipe` calls `wipe` and keeps `persist.env` if it fails, so the next run still knows there is something to remove. For a network that is not persistent, `explorer/run.sh start` starts the same database, and `down.sh` and `explorer/run.sh stop` wipe it with the chain. A database that the caller names (`EXPLORER_DATABASE_URL` or `EXPLORER_DB_PASSWORD_FILE`) is never started or wiped by these scripts.

A wipe loses everything in it, including what exists nowhere else: the transaction tracker's rows, the faucet's requests and the verified contract sources. A new chain started from the same genesis needs an empty database, because the indexer stops on the old chain's rows (see "A new chain, and a moved reader" in [explorer/README.md](../explorer/README.md)).

## Running on an existing participant (the Canton Network)

Ostia can run on a participant that is there already, such as a Splice validator's on the Canton Network's DevNet (Canton 3.6.3, protocol version 36), instead of on the local Canton network. `up.sh` then starts reth, the prover and, if you ask, one sidecar, and sets the chain up on that participant. It starts no Canton and bootstraps nothing.

**One confirmer.** One participant hosts every Ostia party, so the one sidecar beside it is the only confirmer. That is weaker than the local network, where two participants confirm each block with a sidecar each. It is fine for DevNet. Do not use it for anything of value.

**What you need.**

- The participant's JSON Ledger API (v2), as an `https` URL or an `http` URL on the same machine. It must never be reachable from outside the machine it runs on: it can act as every party the participant hosts. Put it on the machine's own address or behind a proxy that checks who calls it.
- A token file for each of four Ledger API users, made by whoever runs the participant: `ADMIN` (the participant's admin user; it uploads the package and allocates the parties and users, so only `up.sh` and `setup.py` need it), and `OPERATOR`, `CONFIRMER` and `BUILDER` (the users that `setup.py` creates; their ids are `ostia-operator`, `ostia-confirmer` and `ostia-builder`). A token is HS256, with the audience `https://canton.network.global` and the user's id as `sub`. A token can be made before its user exists. Each file holds one token, has mode 0600, and is read when it is used. Ostia never makes a token, prints one, or writes one into its state.
- **Tokens are short-lived.** A participant refuses a token whose lifetime is long (the pinned Canton did so for one hour in this repository's own test), so expect tokens of minutes and refresh them by writing the new token into the same 0600 file, in place. The builder reads its file again on every call and picks the new one up. `setup.py` and `propose.py` read each token once, when they start, so each needs one that is valid for the whole run: start them with fresh tokens, and run them again (they are idempotent) if one ran out. `restart.sh` needs no admin token: it lists the package with the builder's.
- The sidecar, reachable from the participant and from nobody else. It has no login: whoever reaches its port can ask it to check a proof.

**Steps.**

```sh
# 1. Give the participant the line it needs, as one more ADDITIONAL_CONFIG variable of its container, and restart it:
network/external/participant-config.sh <sidecar address> 8085
#    ADDITIONAL_CONFIG_ZK_EVM=canton.participants.participant.parameters.engine.extensions.canton-zk-evm { address = "...", port = 8085, validate-on-startup = false }
#    validate-on-startup is false so that the participant still starts when the sidecar is down. Then a block's check fails, and no block commits.

# 2. Start the chain on it:
export CZE_CANTON=external CZE_LEDGER_URL=https://<participant's Ledger API>
export CZE_TOKEN_FILE_ADMIN=... CZE_TOKEN_FILE_OPERATOR=... CZE_TOKEN_FILE_CONFIRMER=... CZE_TOKEN_FILE_BUILDER=...
```

Then, where the sidecar runs, one of two ways:

```sh
# (a) The sidecar runs on this machine: up.sh starts it, on the address the participant reaches it on (not a public one).
CZE_PERSIST=1 CZE_SIDECAR_LISTEN=<sidecar address>:8085 network/up.sh

# (b) The sidecar runs on another machine: start it there first (it is reached from the participant and from nobody else) ...
CZE_SIDECAR_LISTEN=<sidecar address>:8085 network/external/sidecar.sh start     # on that machine
#     ... and run up.sh here without CZE_SIDECAR_LISTEN: it starts no sidecar.
CZE_PERSIST=1 network/up.sh
```

In (a), do not start the sidecar yourself first; if you did, `up.sh` finds it running with the same keys on the same address and goes on, and stops with a message if it is another one (`network/external/sidecar.sh stop <address:port>` first).

`up.sh` builds the guest, starts reth and the prover, and runs `external/setup.py`. The setup uploads the DAR (`POST /v2/packages`) unless its package is listed, checks that the package is vetted on the synchronizer the participant is connected to, allocates the parties `ostia-operator`, `ostia-confirmer`, `ostia-gateway`, `ostia-builder` and `ostia-reader` (and the demo's `ostia-u`, `ostia-v`, `ostia-registry` with `setup.py --demo`; it finds each by one lookup of its id, the hint and the participant's own namespace, `GET /v2/parties/{id}`, and never lists the parties the participant knows, which on the Canton Network are hundreds of thousands), writes their ids to `$CZE_STATE_DIR/canton/parties.env`, creates the users with exactly the rights of their roles (the same as `canton/bootstrap.canton`: the operator's user acts as the operator and the gateway, the builder's user acts as the builder and reads as the operator and the gateway, the confirmer's acts as the confirmer, the reader's only reads), and proposes the chain and accepts it with `canton/propose.py`. It is idempotent: a second run finds what exists and does nothing, accepts a proposal that an earlier run left, and stops if a user has more rights than its role needs or if the chain on the participant is not this chain. `CZE_USER_PREFIX` and `CZE_PARTY_PREFIX` (default `ostia-`) change the names.

`CZE_PERSIST=1` is required: `up.sh` refuses `CZE_CANTON=external` without it. The chain stays on the participant, so reth must keep its blocks too. `restart.sh` then brings the same chain back (it starts the sidecar again if `up.sh` started it, checks the package on the participant with the builder's token, and moves reth to the chain's head; it needs only the builder's token file, not the admin's, the operator's or the confirmer's, and it uses the `CZE_USER_PREFIX` that `up.sh` recorded in `persist.env`, refusing a different one), and `down.sh` stops reth, the prover and the sidecar. `down.sh --wipe` does not touch the participant: the chain's contracts stay there until its operator removes them. `up.sh` refuses a participant whose chain has moved past genesis, because reth starts at genesis; `restart.sh` is what brings such a chain back.

**A new version of the package on a chain that runs.** `setup.py` uploads with vetting on, which is right for a first install and wrong for an upgrade: a participant that vets a new version of the package is free to choose it for any submitter that names the package by name. For an upgrade, `external/setup.py --package-step` does the three parts one at a time, with the admin token alone, each printing one JSON line (nothing else is done: no parties, users or chain). Run it with `--ledger-url`, `--dar` (the new version's DAR) and:

```sh
python3 network/external/setup.py --ledger-url "$CZE_LEDGER_URL" --dar new.dar --package-step check            # POST /v2/dars/validate on each synchronizer; keeps nothing
python3 network/external/setup.py --ledger-url "$CZE_LEDGER_URL" --dar new.dar --package-step upload           # POST /v2/packages?vetAllPackages=false; vets nothing
python3 network/external/setup.py --ledger-url "$CZE_LEDGER_URL" --dar new.dar --package-step vet --dry-run    # the participant prepares the vetting, applies nothing
python3 network/external/setup.py --ledger-url "$CZE_LEDGER_URL" --dar new.dar --package-step vet              # POST /v2/package-vetting/update
```

`check` and `vet` run on each synchronizer the participant is connected to; `upload` and `vet` do nothing that is done already. `upload` stops, naming the package, if the participant lists it as vetted afterwards (a participant that ignores `vetAllPackages=false`). `vet` vets, in one change, every package of the DAR that this participant has not vetted on that synchronizer (the main package and the dependencies the DAR carries, read from its `.dalf` files), because the participant refuses a package whose dependencies are not vetted; an upgrade that brings a new dependency therefore needs no extra step. The block producer says which version it runs under with `--package-id` (the new package's id from `network/canton/dar-id.sh`), so uploading and vetting never switch the chain to the new version: the pin does, and pinning back to the old id is the rollback. The endpoints and fields are those of Canton 3.6.3's JSON Ledger API (`vetAllPackages` and `synchronizerId` are query parameters of the upload and of the check; the vetting change is `{"changes": [{"operation": {"Vet": {"value": {"packages": [{"packageId": ...}]}}}}], "dryRun": ..., "synchronizerId": ...}`).

**Upgrading a running chain's package, step by step.** The order below is the one CI rehearses on every change (the `package-upgrade` job of the demo workflow, `tests/demo_package_upgrade.sh`: Canton 3.6.3 with three participants, the real reth started by `network/reth/launch.sh`, the real builder and the real sidecar for the legs; the proof is a stand-in).

1. Pin the block producer to the version the chain runs now: `builder.py run --package-id <old id>`. Nothing changes; from here, vetting a new version cannot switch the chain.
2. On every participant that hosts a party of the chain, with the admin token: `--package-step check`, then `--package-step upload`, then `--package-step vet --dry-run`, then `--package-step vet`. After the upload the package is listed and not vetted; after the dry run it still is not.
3. Pin the block producer to the new id and restart it. The first block commits under the new version, and its legs settle contracts that were made under the old one. The chain contract and the block's record are made under the new version.
4. To go back, pin the old id and restart. This is a downgrade: the old code consumes contracts that the new version made (the chain contract, deposit requests), and the scenario shows that it commits. The old version stays vetted for this.

The scenario's order is: blocks on 0.1.0 (the DAR built from the tag `v0.1.0`), a deposit made under 0.1.0, check, upload, dry run, vet on all three participants, a block pinned to 0.3.0 (it settles the deposits made under 0.1.0), a deposit made under 0.3.0, a block pinned back to 0.1.0, a deposit, and a block pinned to 0.3.0 again. At each block it reads the package id of the chain contract and of that block's record from the ledger, prints them, and compares both with the pin. After the vetting it waits (up to 30 s) until all three participants list the new package as vetted before the first block pinned to it.

**Raising the gas cap of a chain that runs.** The gas cap is a field of the chain contract, and it can be raised (never lowered) in two steps by two different users, each printing one JSON line and each needing only its own token and the parties in `$CZE_STATE_DIR/canton/parties.env`. The operator proposes and the confirmer accepts:

```sh
python3 network/external/setup.py --ledger-url "$CZE_LEDGER_URL" --gas-cap-step propose --new-gas-cap 60000000 --dry-run   # operator's token; shows what it would do, submits nothing
python3 network/external/setup.py --ledger-url "$CZE_LEDGER_URL" --gas-cap-step propose --new-gas-cap 60000000             # operator's token; creates the proposal
python3 network/external/setup.py --ledger-url "$CZE_LEDGER_URL" --gas-cap-step accept  --new-gas-cap 60000000 --dry-run   # confirmer's token; checks the proposal, submits nothing
python3 network/external/setup.py --ledger-url "$CZE_LEDGER_URL" --gas-cap-step accept  --new-gas-cap 60000000             # confirmer's token; raises the cap
```

The new cap must be above the chain's current one, at most double it, and at most 300,000,000. Both steps refuse any other value before they send anything, which is what the Daml would do too. `propose` does nothing if the same proposal is on the participant already, and stops if a proposal for another value is: the confirmer accepts it only if that value is wanted (a raise cannot be undone), otherwise the operator archives its own proposal (the `Archive` choice of the `GasCapProposal`, with the operator's token) and proposes again. `accept` takes exactly the value given, so the confirmer sees what is accepted, stops if no proposal for it exists, and prints `alreadyAccepted` when the chain has that cap already (a re-run). Stop the block producer before the accept and start it again after: every block replaces the chain contract, and an accept given a replaced contract is refused with the participant's reason (nothing changes, and it is safe to run again). The setup's chain check on a later run accepts a chain whose cap is the one in `PINS` or higher.

**Privacy.** The operator of the participant sees every contract of every Ostia party, because all of them are hosted there, and holds what it takes to act as them. Nothing about Ostia keeps a chain's data from the validator's operator. Use a participant whose operator you trust with the chain, and keep the token files off shared machines.

**The explorer.** It and its indexer read Canton as the reader party, with the reader user's token: make a 0600 token file for `ostia-reader` (HS256, audience `https://canton.network.global`, `sub` `ostia-reader`, or your `CZE_USER_PREFIX`'s reader) and give it to `explorer/run.sh` as `LEDGER_TOKEN_FILE` (or `CZE_TOKEN_FILE_READER`), with `LEDGER_URL` and `READER_PARTY` for this participant. The file is read again on every call, so refresh it in place. See `explorer/README.md`.

**The demo's helpers on this participant.** `demo/canton.py` and `demo/evm.py` run against it, and `demo/live.sh` runs the deposit, the payment (in WtROME) and the withdrawal on the running chain. They need the demo's parties and user as well: run `network/external/setup.py --demo` once more, with no chain arguments (it adds `u`, `v`, `registry` and the user `ostia-demo`, and changes nothing else). Then:

```sh
export CZE_CANTON=external CZE_LEDGER_URL=https://<participant's Ledger API> CZE_RPC_URL=<the chain's RPC> CZE_USER_PREFIX=<the prefix of setup.py's users, ostia- unless you changed it>
export CZE_TOKEN_FILE_DEMO=... CZE_TOKEN_FILE_OPERATOR=... CZE_TOKEN_FILE_CONFIRMER=... CZE_TOKEN_FILE_READER=... CZE_TOKEN_FILE_ADMIN=...   # 0600 files, one token each
python3 demo/canton.py upload-dars   # only the test token's DAR; the participant already has the token standard's packages; then checks it is vetted
demo/live.sh setup                   # the token rules and U's 100 TKB, wTKB made and registered, U's acceptance; writes $CZE_STATE_DIR/demo/disclosed.json
# Restart the block producer with --disclosed $CZE_STATE_DIR/demo/disclosed.json: it needs the rules to build a block that settles a payment.
CZE_WTROME=0x<WtROME on the chain> CZE_SOURCE_COMMIT=<the full hash of the source that runs> demo/live.sh legs   # the three legs, each waited for at the finalized block
CZE_WTROME=0x<WtROME on the chain> CZE_SOURCE_COMMIT=<the full hash of the source that runs> CZE_LIVE_CYCLE_MINUTES=10 nohup demo/live.sh cycle &   # a balanced cycle every 10 minutes; stop: touch $CZE_STATE_DIR/demo/cycle.stop
```

U needs at least 20 TKB when `live.sh cycle` starts (each earlier `legs` run took 16 TKB from U, and the cycle cannot top U up); remove an old stop file before starting. `CZE_LIVE_CYCLES` limits the number of cycles (default 0, no limit). See `demo/README.md`.

`CZE_USER_PREFIX` goes before the user ids as for the rest (`canton.py` and `propose.py` use no prefix on an existing participant unless it is set, so without it they send the user `demo`, not `ostia-demo`, and Canton refuses). A token is read again from its file at every call, so a short-lived one can be rewritten in place. U's and V's EVM addresses (`python3 demo/evm.py keys`) need the chain's coin. The commands and settings are in `demo/README.md` and the header of `demo/live.sh`. `tests/canton_external.sh` runs `upload-dars`, `setup` and `register-token` against the pinned Canton with a login.

## The smoke test

`smoke.sh` runs the builder once, with no transactions in the pool. It checks that

- the builder commits block 1, empty;
- Canton's `ZkChain`, read by the operator, is at head 1 with that block's hash;
- the `BlockRecord` for block 1 is visible to the reader, on the participant that has no sidecar;
- reth's finalized block is that block.

It writes the block hash, proof time and Advance time to `demo/results/smoke.txt`, along with versions and source details. `source_commit` is the full source commit hash, passed as `CZE_SOURCE_COMMIT=$(git rev-parse HEAD)` because the machine's checkout may have no `.git`. `dar_sha256` and `package_id` identify the DAR Canton loaded. The file uses `format=2`. The recorded result is from 2026-10-05, on one machine with one RTX PRO 6000, from commit `6b445073163832e9023850f53678617d90dfc808` of this repository (6b44507). In `network/`, `make-state.sh` accepts another genesis through `CZE_GENESIS_FILE` and rejects chain settings that differ from `network/genesis.json`. `bootstrap.canton` creates a Canton user for the demo. The recorded smoke test used the demo's genesis, which also funds the two per-run test accounts, U and V. It committed empty block 1, `0x773262a6...1747`. `Advance` checks the legs of every block, so committing it also shows that the block recorded none. Proving took 6.31 s with the prover already running, and the time from the finished proof file to the end of the builder's run was 0.49 s. The builder's full run took 155.20 s. It includes the witness, the input and the prover's one-time program setup, and, if the machine had not built the input tool before, that build as well. The built guest matched the recorded programVK, `0xdb79251d...6d3f`. The 0.49 s (`advance_seconds` in the file) includes fetching the gateway's proofs from reth, `Advance`, its commit on both confirmers, and reth marking the block final, so it is more than Canton's commit alone.

## Tests

The Canton side is tested without a GPU:

```sh
tests/network_static.sh      # reth only through launch.sh; the extension only on the two confirming participants; the recorded smoke result
tests/network_checks.sh      # the damlc pin check, the DAR's id, and the stop on a programVK that is not the recorded one
python3 -m unittest discover -s tests -p 'test_propose.py'   # the proposal scripts, against a fake Ledger API and a fake reth
tests/persist_scripts.sh     # down.sh and restart.sh act on the containers persist.env names; a failed --wipe is reported, against a fake Docker
python3 -m unittest discover -s tests -p 'test_external_setup.py'   # the setup on an existing participant, against a fake participant: idempotent, tokens, rights
tests/canton_external.sh     # the pinned Canton with a login on its Ledger API, started without Ostia's bootstrap: the setup twice, the rights and one Advance
tests/canton_persist.sh      # the chain survives a crash of Canton and a stop of the database (needs Docker)
tests/canton_network.sh      # the pinned Canton, the real Daml package, a registered token and one Advance, against stand-ins for the sidecars and reth
```

`canton_network.sh` needs Linux x86-64, Java 21, Python 3 and network access. It checks that the bootstrap, the upload and the vetting work; that the chain names the gateway party and address, and the Ledger API's user rights are right (the builder's user may read as the gateway and may not act as it; the operator's user may act as it); that a token is registered once and not twice; that a block is refused and changes nothing when the sidecar's answer to the block check (`verify2`; `verify` under 0.1.0 and 0.2.0) is `no`, when its `legs` answer is `no` or is not the line Daml expects, and when only the confirmer's sidecar says `no`; that a good one commits; and that Canton asks the operator's sidecar for both the block check (`verify2`; `verify` under 0.1.0 and 0.2.0) and `legs` when it receives the block and both sidecars when it validates it.

## Not here

- Blocks with transactions and legs (a deposit, a payment and a withdrawal), a refused submission and a tampered proof are covered by [demo/](../demo/README.md), which runs on this network. The smoke test here is one empty block.
- Persistence is optional (`CZE_PERSIST=1`, above); without it everything restarts from nothing. There is no replication: one machine, one copy of the data.
- Authentication and TLS on the local network, and more than one machine. (On an existing participant the Ledger API has a login: see [Running on an existing participant](#running-on-an-existing-participant-the-canton-network).)
