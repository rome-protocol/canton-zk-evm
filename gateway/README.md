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

## The vault

A Canton twin of an ERC-20 is backed one for one by that ERC-20 held in the vault (`Vault.sol`). The vault adds no kind of leg: both ways in and out are payment legs of the gateway.

- **Lock.** The holder pays the token into the vault with the gateway's `pay(id, token, vault, amount)`, after an `approve` for the gateway as for any payment. The vault has no code for this: it is only the payee. The leg asks Canton to mint the twin against that payment.
- **Release.** `release(ref, token, to, amount)` pays `amount` of `token` to `to` out of the vault, through `pay`. The vault makes the payment's id itself: `releaseId(ref)`, the SHA-256 of the text `vault-release,<the vault's address, 40 lowercase hex digits>,<ref>` (the same form as a venue trade's id, `venue-trade,<venue>,<label>`). The vault approves the gateway for exactly `amount`, and `pay` takes it in the same call, so no allowance is left. The leg is a payment with the vault as the payer, and it asks Canton to burn the twin. A release to the vault itself is refused.

Anyone may call `release`, as anyone may call `claim`, but the caller does not choose the id. Canton matches a payment by its id, token, payee and amount, and the gateway's leg does not say who paid, so what keeps the vault's tokens safe is that the vault pays only ids of this form, and no id of another domain (`DvpTerms`, venue trade, lock) has it: the tag `vault-release` is not a party id, a `venue-trade` tag or a lock tag, so no `ref` makes the vault pay another domain's payment, and a call that Canton does not match settles nothing. Anyone else who pays an id of this form pays from their own tokens, so a leg with a release id is not proof that tokens left the vault: the `Released` event is. Package 0.5.0 makes the same id from the vault's address and the ref when it matches a redeem request to a release. The preimage is fixed, because the vault cannot be changed once it is deployed and registered. `release` is refused when `to` is the vault, when the gateway refuses (an amount of zero, an id already used, a transfer that fails), when the token refuses the approval, and when the vault holds less than `amount`. A refused call changes nothing and leaves no leg.

`Released(bytes32 indexed id, address indexed token, address indexed to, uint256 amount, string ref)` is logged by the vault on every release. The gateway's leg has the payee but not the payer, so this event is what says that a payment came out of the vault.

The vault has no owner, no key, no upgrade, no storage, no `delegatecall` and no `selfdestruct`; `tests/static.sh` checks the source and also walks the opcodes of `Vault.bin-runtime` and fails on `SSTORE`, `CALLCODE`, `DELEGATECALL` or `SELFDESTRUCT`. The gateway is the constant `GATEWAY` in `Vault.sol`, and `build.sh --check` fails unless it is `GATEWAY_ADDRESS` in `PINS`. A vault is a contract like any other: it is put in the genesis or created, and the chain's registry names it, so that Daml mints twins only for payments into a registered vault.

Not covered: a token that moves less than it is asked to (a fee on transfer, a rebase) still passes `pay`, so the vault then holds less than the twin's supply. That breaks the twin of that token only. Tokens sent straight to the vault by a plain `transfer`, not through `pay`, belong to nobody: the vault has no way to give them back and Canton sees no leg for them.

## Files

| File | What it is |
|---|---|
| `Gateway.sol` | The gateway and the wrapped token |
| `Vault.sol` | The vault that holds the ERC-20s behind Canton twins |
| `build.sh` | Compiles `Gateway.sol` and `Vault.sol` with the solc image in `PINS` and writes the runtime code to `Gateway.bin-runtime` and `Vault.bin-runtime`. `build.sh --check` fails unless both checked-in files are what the sources compile to, and unless the gateway's address in `Vault.sol` is `GATEWAY_ADDRESS`; CI runs it |
| `Gateway.bin-runtime` | The gateway's runtime code in hex, without `0x`. This is what goes into the genesis |
| `Vault.bin-runtime` | The vault's runtime code in hex, without `0x`. It has no storage and no constructor argument, so the same bytes can sit at any address |
| `tests/run.sh` | Starts reth through `network/reth/launch.sh` (peer discovery off), checks it with `network/reth/check.sh`, runs `tests/check.py`, and stops reth |
| `tests/check.py` | Builds blocks on that reth and checks every function and every refusal. For each block it works out the leg hash in Python and compares it with `legs[n]` as `eth_getProof` reports it |
| `tests/Mocks.sol` | Badly behaved tokens for the tests: one whose `transferFrom` returns false, one that returns nothing, one that calls back into the gateway, one that lets anyone mint and burn, and one whose `approve` returns false |

## What is tested

On a real reth, with a funded genesis whose keys are made for the run:

- the genesis holds the gateway: its code, nonce 1, no balance, no storage;
- `register`, `claim`, `withdraw` and `pay`, alone and together in one block, and the events, balances, supplies and counters they leave;
- for every block, `legs[n]` from the storage proof equals the hash worked out in Python from the legs the test meant to make: no legs, one leg, three legs of three kinds, a block with a reverted transaction between two good ones, and a second block that starts again from zero;
- every refusal: an amount of zero, a token that is not wrapped, an id that is used, a burn of more than the balance, a payment without an allowance, a token whose `transferFrom` returns false or returns nothing, an address with no code, and a mint or burn by anyone but the gateway. Each one reverts, leaves no leg and uses up no id;
- the vault in the genesis (code, nonce 1, no balance, no storage); a lock; a release by someone who is not the payer; the vault's `releaseId`; that no ref, shaped like a `DvpTerms` payment id, a venue trade id or a lock id, makes the vault pay an id of another domain; a release to the vault itself; a lock and two releases in one block, with a refused release between them, and the leg hash of that block; every refusal of `release` (zero, more than the vault holds, a used id, a token that refuses the approval, a token without `approve`, an address with no code, a call with no function); the `Released` event; and that no allowance is left;
- a token that calls back into the gateway while `pay` runs: with the same id the callback fails; with another id it goes through, and the outer leg comes first in the events and in the hash.

Run it with `gateway/tests/run.sh`. It needs Docker, `curl`, `jq` and Python 3 with the packages in `demo/requirements.txt`.

## In the demo

The demo ([demo/README.md](../demo/README.md#results)) proved blocks that held gateway calls on a GPU on 2026-10-05, from commit `6b445073163832e9023850f53678617d90dfc808` of this repository (6b44507). Its code hash in the results files is `0xaba3bb1e3a76203fc9a546f93ff08985734ff78ea3c6f79b541acb91d0c08643`, which `network/up.sh` checks against block 0 of reth before it starts the chain. The runs used all three kinds of leg: `claim` (10 TKB deposited on Canton, 10 wTKB minted on the EVM), `pay` (a payment of 10 TKA, in a block that also held a plain transfer of 1 TKA, which made no leg) and `withdraw` (4 wTKB). In runs 1 to 3, each block committed together with the Canton side of its leg. Runs 4 and 5 tested refusals.

The Canton tokens that are locked for a wrapped token are held by the gateway party on Canton, not by this contract. That party is hosted on the operator's participant, so whoever runs that participant can move the locked tokens. See [docs/DESIGN.md](../docs/DESIGN.md#why-it-holds).

## Not covered

Tokens sent straight to the gateway's address are lost: the gateway has no way to give them back. A token that takes a fee on transfer, or that otherwise does not move exactly what it was asked to, is not a plain ERC-20, and the leg records what `pay` was asked for, not what moved.
