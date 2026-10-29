#!/usr/bin/env python3
"""The Canton twins of ERC-20 tokens, for the demo: the vault that holds the tokens, and the twin's rules and balances. See apps/twin/README.md and gateway/README.md ("The vault").

  twin.py deploy-vault                  U creates a vault on Ostia: the creation code is a short fixed prefix that copies gateway/Vault.bin-runtime into memory and returns it,
                                        followed by those bytes. Waits for the receipt, and stops unless the code at the new address is exactly Vault.bin-runtime. Prints the
                                        address, the block, the gas used and the code hash. It does not register the vault: that is network/external/setup.py --contract-step

All Ostia calls go through demo/evm.py (CZE_RPC_URL, CZE_STATE_DIR and the key U). Every command prints one JSON object; `FAIL: <why>` and exit status 1 when it cannot.
"""
import json, os, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import canton, evm

ROOT = canton.ROOT
VAULT_CODE = ROOT / "gateway" / "Vault.bin-runtime"
# The creation code: PUSH2 <length>, DUP1, PUSH1 <offset>, PUSH1 0, CODECOPY, PUSH1 0, RETURN, then the runtime code. CODECOPY(0, offset, length)
# copies it to memory, RETURN(0, length) hands it to the chain. The prefix is 12 bytes, so the runtime code starts at offset 12.
PREFIX_BYTES = 12
MAX_CODE_BYTES = 0xFFFF   # what PUSH2 can say; a contract is never larger than 24,576
VAULT_GAS = 800_000       # 53,000 + 200 per byte of code is about 360,000 for the vault, and the transaction's own data on top
RECEIPT_SECONDS = 600


def runtime_code(path: Path = None) -> bytes:
    """The vault's runtime code, from gateway/Vault.bin-runtime (hex without 0x)."""
    path = path or VAULT_CODE
    try:
        code = bytes.fromhex(path.read_text().strip())
    except (OSError, ValueError) as e:
        raise canton.Fail(f"cannot read the vault's runtime code {path}: {e}") from None
    if not code or len(code) > MAX_CODE_BYTES:
        raise canton.Fail(f"{path} holds {len(code)} bytes: not a runtime code of 1 to {MAX_CODE_BYTES} bytes")
    return code


def creation_code(code: bytes) -> str:
    """The creation code (hex, no 0x) of a contract with this runtime code and no constructor: the 12-byte prefix, then the code."""
    prefix = bytes([0x61]) + len(code).to_bytes(2, "big") + bytes([0x80, 0x60, PREFIX_BYTES, 0x60, 0x00, 0x39, 0x60, 0x00, 0xF3])
    assert len(prefix) == PREFIX_BYTES
    return (prefix + code).hex()


def wait_receipt(tx: str, seconds: int = RECEIPT_SECONDS) -> dict:
    """The receipt of the transaction once it is in a block (latest, not finalized: the code check that follows reads the latest block too)."""
    deadline = time.time() + seconds
    while evm.rpc("eth_getTransactionReceipt", [tx]) is None:
        if time.time() > deadline:
            raise canton.Fail(f"{tx} is in no block after {seconds} seconds")
        time.sleep(float(os.environ.get("CZE_POLL_SECONDS", "1")))
    return evm.receipt_of(tx)


def deploy_vault() -> dict:
    code = runtime_code()
    tx = evm.send(evm.state_dir(), "u", None, creation_code(code), VAULT_GAS)
    receipt = wait_receipt(tx)
    if receipt["status"] != 1 or not receipt["contract"]:
        raise canton.Fail(f"the vault's creation {tx} in block {receipt['block']} did not make a contract (status {receipt['status']})")
    address = receipt["contract"].lower()
    there = bytes.fromhex(evm.rpc("eth_getCode", [address, "latest"]).removeprefix("0x"))
    if there != code:
        raise canton.Fail(f"the code at {address} is not gateway/Vault.bin-runtime ({len(there)} bytes there, {len(code)} expected)")
    return {"address": address, "tx": tx, "block": receipt["block"], "gasUsed": receipt["gasUsed"], "codeHash": "0x" + evm.keccak(there).hex()}


def main(argv: list) -> dict:
    if argv == ["deploy-vault"]:
        return deploy_vault()
    raise SystemExit(__doc__)


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except canton.Fail as e:
        print(f"FAIL: {e}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result))
