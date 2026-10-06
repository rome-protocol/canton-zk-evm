# Contributing to Ostia

Thank you for looking at Ostia. This is an early release (see the Status section of the [README](README.md)), so the code changes quickly and some parts are rough. Issues, questions and pull requests are welcome.

The code is under the [Apache License 2.0](LICENSE). By sending a contribution you agree that it is licensed the same way, and you confirm it with a sign-off (see "Sign your commits" below). Please also read our [Code of Conduct](CODE_OF_CONDUCT.md). For a security problem, do not open an issue: follow [SECURITY.md](SECURITY.md).

## Building and testing

The [README](README.md) lists every test and what it needs. In short, you need Docker, `bash`, `curl`, `jq`, `openssl` and Python 3. The Rust crates use the toolchain in `rust-toolchain.toml`. The Canton integration tests need Linux x86-64 and Java 21. The explorer needs Node 22.18 or newer. `PINS` holds the exact versions and image digests everything is built against; please change it only when the change is about a pin.

Start with the quick checks, which need no GPU:

```sh
tests/static.sh                  # pins, genesis and licence lines agree
tests/refuses_missing_flag.sh    # the reth launch refuses a missing or wrong flag
tests/fixtures.sh                # the recorded proof is consistent
gateway/build.sh --check         # the checked-in gateway code is what Gateway.sol compiles to (Docker)
```

Then run the tests of the part you changed. Each folder's README has the details.

| Part | How to test it |
|---|---|
| `verifier/`, `mpt/`, `sidecar/`, `explorer/verify/` | `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings` and `cargo test --locked`, from the crate's folder |
| `guest/rules/` | `cargo test --locked` from that folder |
| `gateway/` | `gateway/build.sh --check`, then `gateway/tests/run.sh` (Docker, `curl`, `jq` and the Python packages in `demo/requirements.txt`) |
| `builder/` | `python3 -m unittest discover -s builder/tests -v`, with the packages in `builder/requirements.txt` |
| `daml/` | `daml/test.sh` (see [daml/README.md](daml/README.md)) |
| `explorer/` | `cd explorer && npm ci && npm run typecheck && npm test` |
| `network/`, `demo/` | the scripts named in the README; the demo rehearsal runs without a GPU |

If you change `gateway/Gateway.sol` or `demo/TKA.sol`, rebuild the checked-in bytecode with `gateway/build.sh` or `demo/build-token.sh` and commit the result. CI runs both with `--check`.

The workflows in `.github/workflows/` run these same checks. A pull request should leave them green.

## Running reth

reth is always started through `network/reth/launch.sh`, and never by hand or by a script of your own. The launch script turns peer discovery off, allows no peers, binds p2p to localhost and publishes no p2p port, and it refuses a command line that would change that. Peer discovery on a public network is the one thing we never do, so a change that starts a node must go through that script, and a test that starts one must check the flags with `network/reth/check.sh` and stop it with `network/reth/stop.sh`.

## No secrets

Do not put keys, tokens, passwords or seed phrases in the repository, not even for a local or test setup. Generate them per run into the state folder (which git ignores) with permissions 0600, the way `network/` and `explorer/` do. CI scans the whole history with gitleaks, and GitHub's secret scanning is on. If you find a secret that is already in the history, report it through [SECURITY.md](SECURITY.md).

## Sign your commits

We use the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) instead of a contributor licence agreement. By signing off, you say that you wrote the change or have the right to send it under this repository's licence. Add a `Signed-off-by` line to each commit with `git commit -s`:

```
Signed-off-by: Your Name <you@example.com>
```

Use your real name and an email address you can be reached at. A pull request with a commit that has no sign-off will be asked to add one (`git rebase --signoff` fixes a branch).

## Sending a change

1. For anything bigger than a small fix, open an issue first, so we can say whether it fits before you spend time on it.
2. Make a branch from `main`, keep the change to one purpose, and keep it small enough to review.
3. Say in the pull request what changed and why, and how you tested it. If you could not run a test (the GPU runs, for example), say so.
4. Write for people, in plain language: commit messages, comments and documents should be clear to someone who has not seen the rest of the project.
5. Do not use the repository to publish anything that is not yours to publish.

## How pull requests are reviewed

A maintainer reads each pull request and may ask for changes. We check that the tests pass, that the change does what it says and no more, and that it keeps the properties the design depends on: no owner or upgrade path in the gateway, peer discovery off, pinned versions, and no secrets. Workflows from outside contributors need a maintainer's approval before they run. We merge when a maintainer has approved and the checks are green. We do not promise a fixed response time, but we try to answer within a few working days.

## Questions

Open a GitHub issue with the question. For anything about the code of conduct, write to rome@romeprotocol.com.
