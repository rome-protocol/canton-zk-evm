#!/usr/bin/env python3
"""The transactions of the explorer's real-reth tests, sent as V through demo/evm.py's own sender (so the rehearsal's builder takes them into blocks).

  demo_w1.py deploy <creation code file> [gas]
                                           V deploys the contract (the gas limit defaults to 1,500,000); print the transaction hash
  demo_w1.py lab <address> <function>      V calls Lab.build(), Lab.undone() or Lab.kill() (explorer/test/fixtures/Lab.sol); print the transaction hash
  demo_w1.py reverts <address>             three transactions that fail, in this order: Reverts.reason() (Error(string)), overflow() (Panic(uint256))
                                           and custom() (a custom error); print their hashes, one a line
  demo_w1.py stress <address> <count>      <count> calls of Stress.run(depth, logs, creates), each as heavy as the gas below allows; print the hashes
  demo_w1.py flood <address> <kind> <count>  <count> calls of explorer/test/fixtures/Flood.sol, each as heavy as the gas below allows; print the hashes.
                                           kind: transfers (Flood: ERC-20 transfers to new holders), mint (Multi: 4,096 ERC-1155 ids to the Multi contract, once, in an earlier block),
                                           batches (Multi: 18 ERC-1155 batches of 4,096 ids that share one array, from the holder of the ids to new holders)
                                           or spawn (Flood: new tokens that need their metadata read, a third of them Burners whose reads spend all their gas, and one a FatReturn whose reads answer 170 KB)

  demo_w1.py plain <count> [nonce]         <count> plain transfers of 1 wei from V, each to a new address (21,000 gas each, so 1,428 fit in a block under the cap); print the hashes
                                           (the nightly load test's flood, tests/demo_nightly_l3.py). The nonces start at [nonce], or at V's pending nonce when none is given
  demo_w1.py nonce                         print V's pending nonce
  demo_w1.py osaka                         check that the chain runs Osaka: the pool refuses a transaction of 16,777,217 gas (2^24 + 1), and the CLZ opcode answers 255 for 1
                                           (an eth_call with its own code); print "osaka ok", and send nothing that reth would take

The transactions wait in reth's pool until the builder cuts a block. The failed calls carry a gas limit of their own, so that reth takes them.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "demo"))
import evm  # noqa: E402
from eth_abi import encode  # noqa: E402
from eth_account import Account  # noqa: E402
from eth_utils import keccak, to_checksum_address  # noqa: E402

DEPLOY_GAS = 1_500_000
PLAIN_GAS = 21_000
FAILING_GAS = 150_000
STRESS_GAS = 2_000_000
LAB_GAS = 4_000_000
LAB_FUNCTIONS = ("build()", "undone()", "kill()")
DEPTH, LOGS, CREATES = 14, 10, 1
# Per call: the count in the call and its gas limit. With STRESS_GAS, a Transfer log costs about 2.4k gas with the holder worked out, and a token made with
# its mint about 120k. A batch of 4,096 ids that shares one array for ids and values is a 131,168-byte log, about 1.07M gas each, and every call also pays a fixed
# 0.2M for the 4,096-id array loop, the memory expansion and the intrinsic gas: 9 batches need 9,861,047 gas (measured on anvil, Osaka, solc 0.8.28), so the call
# gets 10M. One transaction may use at most 2^24 (16,777,216) gas under Osaka, so the 18 batches of the W1 block go in two calls (20M of gas limit together): the
# calls' gas limits of the W1 block add up to 28M of the 30 Mgas cap, and the builder packs by gas used.
FLOOD = {"transfers": ("transfers(uint256,uint256)", 700, STRESS_GAS), "batches": ("batches(uint256,uint256)", 9, 10_000_000), "spawn": ("spawn(uint256)", 10, STRESS_GAS),
         "mint": ("mint()", None, 10_000_000)}


def selector(signature: str) -> str:
    return keccak(text=signature)[:4].hex()


def recipient(i: int) -> str:
    """The i-th new address of a flood: made from the counter and the time, so that no two floods share one."""
    return "0x" + keccak(f"nightly-l3:{time.time_ns()}:{i}".encode())[-20:].hex()


def pending_nonce(folder: Path) -> int:
    evm.make_keys(folder)
    return int(evm.rpc("eth_getTransactionCount", [Account.from_key(evm.load_key(folder, "v")).address, "pending"]), 16)


def plain(folder: Path, count: int, first_nonce: int | None = None) -> list:
    """Signs `count` transfers in one process (the key is read once and used here only) and sends them to reth's pool, nonces in order."""
    evm.make_keys(folder)
    account = Account.from_key(evm.load_key(folder, "v"))
    chain_id = int(evm.rpc("eth_chainId", []), 16)
    nonce = pending_nonce(folder) if first_nonce is None else first_nonce
    hashes = []
    for i in range(count):
        tx = {"type": 2, "chainId": chain_id, "nonce": nonce + i, "value": 1, "gas": PLAIN_GAS, "maxFeePerGas": evm.MAX_FEE,
              "maxPriorityFeePerGas": evm.PRIORITY_FEE, "to": to_checksum_address(recipient(i)), "data": "0x"}
        hashes.append(evm.rpc("eth_sendRawTransaction", ["0x" + account.sign_transaction(tx).raw_transaction.hex().removeprefix("0x")]))
    return hashes


OSAKA_GAS_CAP = 1 << 24
# PUSH1 1, CLZ, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN: the number of leading zero bits of 1 in 256 bits is 255
CLZ_CODE = "0x6001" + "1e" + "600052" + "60206000f3"


def osaka_checks(folder: Path) -> None:
    """The Osaka rules are in force on the chain reth runs: the pool refuses one transaction above 2^24 gas, and CLZ is an opcode."""
    try:
        evm.send(folder, "v", "0x" + "00" * 19 + "0f", "", OSAKA_GAS_CAP + 1)
    except SystemExit as refusal:
        if "gas limit" not in str(refusal).lower():
            raise SystemExit(f"the pool refused a transaction of {OSAKA_GAS_CAP + 1} gas, but not for its gas limit: {refusal}")
    else:
        raise SystemExit(f"the pool took a transaction of {OSAKA_GAS_CAP + 1} gas: the chain does not run Osaka")
    probe = "0x" + "00" * 19 + "c1"
    answer = int(evm.rpc("eth_call", [{"to": probe}, "latest", {probe: {"code": CLZ_CODE}}]), 16)
    if answer != 255:
        raise SystemExit(f"CLZ of 1 answered {answer}, not 255: the chain does not run Osaka")


def main(argv: list) -> int:
    folder = evm.state_dir()
    cmd = argv[:1]
    if cmd == ["deploy"] and len(argv) in (2, 3) and (len(argv) == 2 or argv[2].isdigit()):
        print(evm.send(folder, "v", None, Path(argv[1]).read_text().strip(), int(argv[2]) if len(argv) == 3 else DEPLOY_GAS))
        return 0
    if cmd == ["lab"] and len(argv) == 3 and argv[2] in LAB_FUNCTIONS:
        print(evm.send(folder, "v", argv[1], selector(argv[2]), LAB_GAS))
        return 0
    if cmd == ["reverts"] and len(argv) == 2:
        for signature in ("reason()", "overflow()", "custom()"):
            print(evm.send(folder, "v", argv[1], selector(signature), FAILING_GAS))
        return 0
    if cmd == ["stress"] and len(argv) == 3 and argv[2].isdigit():
        data = selector("run(uint256,uint256,uint256)") + encode(["uint256", "uint256", "uint256"], [DEPTH, LOGS, CREATES]).hex()
        for _ in range(int(argv[2])):
            print(evm.send(folder, "v", argv[1], data, STRESS_GAS))
        return 0
    if cmd == ["flood"] and len(argv) == 4 and argv[2] in FLOOD and argv[3].isdigit():
        signature, n, gas = FLOOD[argv[2]]
        for seed in range(int(argv[3])):
            # Every call has a seed of its own, so its holders are new.
            args = [] if n is None else [n] if argv[2] == "spawn" else [n, seed + 1]
            data = selector(signature) + encode(["uint256"] * len(args), args).hex()
            print(evm.send(folder, "v", argv[1], data, gas))
        return 0
    if cmd == ["plain"] and len(argv) in (2, 3) and all(a.isdigit() for a in argv[1:]):
        print("\n".join(plain(folder, int(argv[1]), int(argv[2]) if len(argv) == 3 else None)))
        return 0
    if cmd == ["osaka"] and len(argv) == 1:
        osaka_checks(folder)
        print("osaka ok")
        return 0
    if cmd == ["nonce"] and len(argv) == 1:
        print(pending_nonce(folder))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
