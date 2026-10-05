# gateway

The gateway is the one EVM contract that tells Canton what a block needs. During a block, every transaction that has a Canton side calls the gateway, and the gateway writes down that Canton leg in its own storage. The block's proof fixes the chain's state, so it fixes what the gateway wrote. This folder holds the contract and its tests. The checks on the Canton side that read what the gateway wrote are not part of it.

There are three kinds of leg:

| Kind | Who calls what | What happens on the EVM | What the leg asks of Canton |
|---|---|---|---|
| 1, deposit | the recipient: `claim(id, token, amount)` | the wrapped token is minted to the caller | the depositor's Canton token is locked |
| 2, withdrawal | the holder: `withdraw(token, amount, party)` | the caller's wrapped tokens are burnt | the Canton token is released to `party` |
| 3, payment | the payer: `pay(id, token, to, amount)` | `amount` of an ERC-20 moves from the payer to `to` | the Canton payment with that `id` is made |

`register(name, symbol)` makes a new wrapped token. It is not a leg. Anyone can call it, because a wrapped token can only be minted in a block whose Canton side has settled.

## The contract

`Gateway.sol` holds two contracts. `Gateway` is the gateway. `Wrapped` is the wrapped token: a plain ERC-20 with 10 decimals, the same as a Canton amount, so an amount converts exactly in both directions. Only the gateway that made a wrapped token can mint or burn it.

The gateway has no owner, no admin key, no upgrade and no pause. Its code sits at a fixed address, `GATEWAY_ADDRESS` in `PINS`, in the genesis of every run: `network/make-state.sh` adds it to the copy of the genesis that reth reads, with nonce 1 and no storage. It is not written into `network/genesis.json`, because the proven program includes that file whole.

### Storage

The order is fixed. `tests/static.sh` checks it, and the real-reth test reads each slot.

| Slot | Variable | What it holds |
|---|---|---|
| 0 | `mapping(uint256 => bytes32) legs` | for each block number, the running hash of the legs recorded in that block; zero if there are none |
| 1 | `mapping(bytes32 => bool) used` | the deposit and payment ids already used |
| 2 | `mapping(address => bool) wrapped` | the tokens this gateway made |
| 3 | `uint256 withdrawals` | how many withdrawals there have been; it gives each withdrawal its id |

### Functions

- `claim(id, token, amount)` needs a wrapped token, a new `id` and an amount above zero. It uses up `id`, mints to the caller, and records a deposit leg for the caller.
- `withdraw(token, amount, party)` needs a wrapped token and an amount above zero. It burns the caller's tokens and records a withdrawal leg. Its id is made by the gateway: `keccak256(abi.encode(block.chainid, address(this), ++withdrawals))`, so it is new every time. `party` is the full Canton party id of the receiver.
- `pay(id, token, to, amount)` needs a new `id` and an amount above zero. It uses up `id` and records a payment leg for `to`, and only then calls `token.transferFrom(msg.sender, to, amount)`, which must return `true`. The token is not ours, so the id is used up and the leg is written first: a token that calls back into the gateway finds the id used and the leg already there.

A transaction that reverts leaves no leg. The hash and the event are written together, so the events of a block, in log order, are its legs in the order of the hash.

### The leg hash

Each leg is written as `Leg(kind, id, token, account, amount, party)`. `account` is the recipient of a deposit, the holder who burnt in a withdrawal, or the payee of a payment. `amount` is in base units. `party` is empty except in a withdrawal.

The first leg of a block starts from 32 zero bytes. Every leg replaces the running value with

```
keccak256(abi.encode(previous, kind, id, token, account, amount, keccak256(bytes(party))))
```

that is, the Keccak-256 of seven 32-byte words: the previous value, the kind, the id, the token, the account, the amount, and the hash of the party's bytes. The hash of an empty party is `0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`. The result is stored in `legs[block.number]`, at the storage key `keccak256(abi.encode(blockNumber, 0))`. A block with no legs has nothing there, and reads as zero.

## Files

| File | What it is |
|---|---|
| `Gateway.sol` | The gateway and the wrapped token |
| `build.sh` | Compiles `Gateway.sol` with the solc image in `PINS` and writes the runtime code to `Gateway.bin-runtime`. `build.sh --check` fails unless the checked-in file is what the source compiles to; CI runs it |
| `Gateway.bin-runtime` | The gateway's runtime code in hex, without `0x`. This is what goes into the genesis |
| `tests/run.sh` | Starts reth through `network/reth/launch.sh` (peer discovery off), checks it with `network/reth/check.sh`, runs `tests/check.py`, and stops reth |
| `tests/check.py` | Builds blocks on that reth and checks every function and every refusal. For each block it works out the leg hash in Python and compares it with `legs[n]` as `eth_getProof` reports it |
| `tests/Mocks.sol` | Three badly behaved tokens for the tests: one whose `transferFrom` returns false, one that returns nothing, and one that calls back into the gateway |

## What is tested

On a real reth, with a funded genesis whose keys are made for the run:

- the genesis holds the gateway: its code, nonce 1, no balance, no storage;
- `register`, `claim`, `withdraw` and `pay`, alone and together in one block, and the events, balances, supplies and counters they leave;
- for every block, `legs[n]` from the storage proof equals the hash worked out in Python from the legs the test meant to make: no legs, one leg, three legs of three kinds, a block with a reverted transaction between two good ones, and a second block that starts again from zero;
- every refusal: an amount of zero, a token that is not wrapped, an id that is used, a burn of more than the balance, a payment without an allowance, a token whose `transferFrom` returns false or returns nothing, an address with no code, and a mint or burn by anyone but the gateway. Each one reverts, leaves no leg and uses up no id;
- a token that calls back into the gateway while `pay` runs: with the same id the callback fails; with another id it goes through, and the outer leg comes first in the events and in the hash.

Run it with `gateway/tests/run.sh`. It needs Docker, `curl`, `jq` and Python 3 with the packages in `demo/requirements.txt`.

## In the demo

The demo ([demo/README.md](../demo/README.md#results)) proved blocks that held gateway calls on a GPU on 2026-10-05, from commit `6b445073163832e9023850f53678617d90dfc808` of this repository (6b44507). Its code hash in the results files is `0xaba3bb1e3a76203fc9a546f93ff08985734ff78ea3c6f79b541acb91d0c08643`, which `network/up.sh` checks against block 0 of reth before it starts the chain. The runs used all three kinds of leg: `claim` (10 TKB deposited on Canton, 10 wTKB minted on the EVM), `pay` (a payment of 10 TKA, in a block that also held a plain transfer of 1 TKA, which made no leg) and `withdraw` (4 wTKB). In runs 1 to 3, each block committed together with the Canton side of its leg. Runs 4 and 5 tested refusals.

The Canton tokens that are locked for a wrapped token are held by the gateway party on Canton, not by this contract. That party is hosted on the operator's participant, so whoever runs that participant can move the locked tokens. See [docs/DESIGN.md](../docs/DESIGN.md#why-it-holds).

## Not covered

Tokens sent straight to the gateway's address are lost: the gateway has no way to give them back. A token that takes a fee on transfer, or that otherwise does not move exactly what it was asked to, is not a plain ERC-20, and the leg records what `pay` was asked for, not what moved.
