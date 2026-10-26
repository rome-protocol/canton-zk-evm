#!/usr/bin/env python3
"""The inputs for the checks of the Osaka rules in tests/demo_program_switch.sh, and the transactions it sends (the keys are U's, from the demo folder).

  demo_osaka.py modexp <length>         the call data of a modexp (0x05) with a base of that many bytes, an exponent of 1 and a modulus of 7
  demo_osaka.py p256 <valid|invalid>    the call data of P256VERIFY (0x100): a signature that verifies, or the same with the first byte of the hash changed
  demo_osaka.py initcode                the init code of a contract that reverts unless CLZ (0x1e) of 1 is 255 and P256VERIFY accepts the signature
  demo_osaka.py send <state folder> cap <gas>
                                        U sends a transfer of nothing to itself with that gas limit; prints {"sent": <hash>} or {"refused": <reason>}
  demo_osaka.py send <state folder> create
                                        U sends the init code above as a contract creation; prints {"sent": <hash>} or {"refused": <reason>}
"""
import json
import sys
from pathlib import Path

# The signature of the first example of RIP-7212 (hash, r, s, x, y), which verifies.
P256_INPUT = bytes.fromhex(
    "4cee90eb86eaa050036147a12d49004b6b9c72bd725d39d4785011fe190f0b4d"
    "a73bd4903f0ce3b639bbbf6e8e80d16931ff4bcf5993d58468e8fb19086e8cac"
    "36dbcd03009df8c59286b162af3bd7fcc0450c9aa81be5d10d312af6c66b1d60"
    "4aebd3099c618202fcfe16ae7770b0c49ab5eadf74b754204a3bb6060e44eff3"
    "7618b065f9832de4ca6ca971a7a1adc826d0f7c00181a5fb2ddf79ae00b4e10e")


def modexp(length: int) -> bytes:
    word = lambda n: n.to_bytes(32, "big")
    return word(length) + word(1) + word(1) + b"\x03" * length + b"\x01" + b"\x07"


def p256(kind: str) -> bytes:
    return P256_INPUT if kind == "valid" else bytes([P256_INPUT[0] ^ 1]) + P256_INPUT[1:]


def initcode() -> bytes:
    """Copies the signature from its own end to memory 0, calls 0x100 with it (the answer goes to 0xa0), and reverts unless the answer is 1 and CLZ(1) is 255."""
    def body(data_at: int, revert_at: int) -> bytes:
        return (b"\x60\xa0" + b"\x61" + data_at.to_bytes(2, "big") + b"\x5f\x39"      # PUSH1 160, PUSH2 data_at, PUSH0, CODECOPY
                + b"\x60\x20\x60\xa0\x60\xa0\x5f\x61\x01\x00\x5a\xfa"                 # STATICCALL(gas, 0x100, 0, 160, 0xa0, 32)
                + b"\x60\xa0\x51\x60\x01\x14\x16"                                      # AND the call's success with mload(0xa0) == 1
                + b"\x60\x01\x1e\x60\xff\x14\x16"                                      # AND with CLZ(1) == 255
                + b"\x15\x61" + revert_at.to_bytes(2, "big") + b"\x57"                 # ISZERO, PUSH2 revert_at, JUMPI
                + b"\x5f\x5f\xf3"                                                      # PUSH0, PUSH0, RETURN: no code for the contract
                + b"\x5b\x5f\x5f\xfd")                                                 # JUMPDEST, PUSH0, PUSH0, REVERT
    size = len(body(0, 0))
    return body(size, size - 4) + P256_INPUT


def send(folder: Path, what: str, gas: int | None) -> dict:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "demo"))
    import evm   # the demo's own transaction sender (the key is read from the file and used there only)
    me = evm.make_keys(folder)["u"]
    try:
        if what == "cap":
            return {"sent": evm.send(folder, "u", me, "", gas)}
        return {"sent": evm.send(folder, "u", None, initcode().hex(), 500_000)}
    except SystemExit as e:
        return {"refused": str(e.code)}


def main(argv: list) -> None:
    if argv[:1] == ["modexp"]:
        print("0x" + modexp(int(argv[1])).hex())
    elif argv[:1] == ["p256"]:
        print("0x" + p256(argv[1]).hex())
    elif argv[:1] == ["initcode"]:
        print("0x" + initcode().hex())
    elif argv[:1] == ["send"] and len(argv) in (3, 4):
        print(json.dumps(send(Path(argv[1]), argv[2], int(argv[3]) if len(argv) == 4 else None)))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
