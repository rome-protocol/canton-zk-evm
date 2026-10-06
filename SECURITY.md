# Security

## Report a problem privately

Please do not open a public issue for a security problem. Report it through GitHub's private vulnerability reporting: open the Security tab of this repository and choose "Report a vulnerability". Only the maintainers can see what you send there.

Give us what we need to reproduce it: which part (verifier, sidecar, guest rules, gateway, Daml package, builder, explorer, network scripts), which commit, what you did and what happened. If you found it with a proof or a block, attach it.

We will acknowledge a report within a few working days and tell you what we plan to do. Please give us a reasonable time to fix a problem before you write about it in public. We are glad to credit you in the fix if you want that.

## This is an early release

Ostia is early code. Please read the Status section of the [README](README.md) first:

- the code, and ZisK 1.3.1-alpha that it builds on, have not been audited;
- it runs on a local test network that keeps no state between runs, and tROME is a test coin with no value;
- the gateway party, which holds the Canton tokens locked for their wrapped forms, is hosted on the operator's participant, so whoever runs that participant can move the locked tokens;
- there is no bug bounty, and nothing here should be used for anything of value.

Because of this, some weaknesses are known and written down in the READMEs and in `docs/DESIGN.md`. A report that repeats one of them is still welcome, but it is not a new finding.

## What is in scope

Problems in the code of this repository that could let a block, a proof or a leg be accepted when it should be refused, or let funds or state move that should not. For example:

- `verifier/`: a wrapped proof that verifies when it should not, or a valid one that is refused;
- `mpt/` and `sidecar/`: a state or storage proof, a block or a list of legs that is accepted when it is wrong;
- `guest/rules/` and the changes we made to the guest: a way to prove a block that does not follow this chain's rules;
- `gateway/Gateway.sol`: a way to mint, release or pay without the matching leg, or to change the leg hash;
- `daml/`: a way to commit a block without its proof, to skip a leg, or to settle a leg twice;
- `builder/`, `explorer/`, `network/` and `demo/`: a way to leak a key or secret, to reach beyond the local network, or to turn peer discovery on.

## What is out of scope

- Weaknesses in third-party code we use (ZisK, reth, Canton, the Daml SDK, npm packages and Rust crates). Please report those to their own projects. If our use of them is the problem, report it to us.
- The copy of zisk-eth-client in `guest/`, apart from the two changes marked `canton-zk-evm change` in the code (see `guest/README.md`).
- Attacks that need the operator's machine, keys or participant, which the Status section already says are trusted in this release.
- Denial of service against a local test network, and findings that need a change to the pinned versions or a modified `PINS` file.
- Reports with no way to reproduce them, or from automated scanners without a demonstrated effect.
