#!/usr/bin/env python3
"""The transactions of the explorer's real-reth tests, sent as V through demo/evm.py's own sender (so the rehearsal's builder takes them into blocks).

  demo_w1.py deploy <creation code file> [gas]
                                           V deploys the contract (the gas limit defaults to 1,500,000); print the transaction hash
  demo_w1.py lab <address> <function>      V calls Lab.build(), Lab.undone() or Lab.kill() (explorer/test/fixtures/Lab.sol); print the transaction hash
  demo_w1.py reverts <address>             three transactions that fail, in this order: Reverts.reason() (Error(string)), overflow() (Panic(uint256))
                                           and custom() (a custom error); print their hashes, one a line
  demo_w1.py stress <address> <count>      <count> calls of Stress.run(depth, logs, creates), each as heavy as the gas below allows; print the hashes
  demo_w1.py flood <address> <kind> <count>  <count> calls of explorer/test/fixtures/Flood.sol, each as heavy as the gas below allows; print the hashes.
                                           kind: transfers (Flood: ERC-20 transfers to new holders), batches (Multi: ERC-1155 batches to new holders)
                                           or spawn (Flood: new tokens that need their metadata read)

The transactions wait in reth's pool until the builder cuts a block. The failed calls carry a gas limit of their own, so that reth takes them.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "demo"))
import evm  # noqa: E402
from eth_abi import encode  # noqa: E402
from eth_utils import keccak  # noqa: E402

DEPLOY_GAS = 1_500_000
FAILING_GAS = 150_000
STRESS_GAS = 2_000_000
LAB_GAS = 4_000_000
LAB_FUNCTIONS = ("build()", "undone()", "kill()")
DEPTH, LOGS, CREATES = 14, 10, 1
# Per call, sized for STRESS_GAS: a Transfer log costs about 2.4k gas with the holder worked out, a batch about 7k, a token made with its mint about 300k.
FLOOD = {"transfers": ("transfers(uint256,uint256)", 700), "batches": ("batches(uint256,uint256)", 250), "spawn": ("spawn(uint256)", 6)}


def selector(signature: str) -> str:
    return keccak(text=signature)[:4].hex()


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
        signature, n = FLOOD[argv[2]]
        for seed in range(int(argv[3])):
            # Every call has a seed of its own, so its holders are new.
            args = [n] if argv[2] == "spawn" else [n, seed + 1]
            data = selector(signature) + encode(["uint256"] * len(args), args).hex()
            print(evm.send(folder, "v", argv[1], data, STRESS_GAS))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
