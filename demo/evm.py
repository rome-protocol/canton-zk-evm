#!/usr/bin/env python3
"""The EVM side of the demo: the keys, the funded genesis, and the transactions V sends. See demo/README.md.

  evm.py keys                      make V's key (kept in $CZE_STATE_DIR/demo/v.key, mode 0600, never printed) and U's
                                   address (U's key is thrown away: U never sends anything); print both addresses
  evm.py genesis                   write $CZE_STATE_DIR/demo/genesis.json: network/genesis.json plus 10 ether for V
  evm.py deploy                    V deploys TKA, which gives its whole supply (1,000 TKA) to V; print the transaction hash
  evm.py transfer <token> <amount> V sends U <amount> TKA (a whole number) from the token at that address; print the transaction hash
  evm.py receipt <tx hash>         print the transaction's block number, block hash, gas used, and the contract it made
  evm.py balance <token> <holder>  print the holder's TKA balance in whole tokens (eth_call balanceOf)

The transactions go to reth's HTTP port (RETH_HTTP_PORT, default 8545) and wait in its pool until the builder takes them
into a block. Needs the packages in demo/requirements.txt. Prints one JSON object per command.
"""
import json, os, sys, urllib.request
from pathlib import Path

from eth_account import Account
from eth_utils import to_checksum_address

ROOT = Path(__file__).resolve().parent.parent
ONE = 10**18
SUPPLY = 1000 * ONE
DEPLOY_GAS = 1_200_000
TRANSFER_GAS = 100_000
MAX_FEE = 10 * 10**9
PRIORITY_FEE = 10**9
V_ETHER = 10 * ONE
SELECTOR_TRANSFER = "a9059cbb"
SELECTOR_BALANCE_OF = "70a08231"


def state_dir() -> Path:
    return Path(os.environ.get("CZE_STATE_DIR", ROOT / "state")) / "demo"


def pad32(address: str) -> str:
    return address.lower().removeprefix("0x").rjust(64, "0")


def make_keys(folder: Path) -> dict:
    """V's key goes to v.key (created exclusively, mode 0600) and is never returned or printed. U's address comes from a
    key that is dropped. Re-running keeps V's key."""
    folder.mkdir(parents=True, exist_ok=True)
    key_file, addresses = folder / "v.key", folder / "addresses.json"
    if key_file.exists() != addresses.exists():
        raise SystemExit(f"{folder} has only one of v.key and addresses.json: remove both to start again")
    if not key_file.exists():
        v = Account.create()
        fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(v.key.hex().removeprefix("0x"))
        addresses.write_text(json.dumps({"v": v.address, "u": Account.create().address}))
    return json.loads(addresses.read_text())


def funded_genesis(base: dict, v_address: str) -> dict:
    genesis = json.loads(json.dumps(base))
    genesis["alloc"][v_address.lower().removeprefix("0x")] = {"balance": hex(V_ETHER)}
    return genesis


def load_key(folder: Path) -> str:
    return "0x" + (folder / "v.key").read_text().strip()


def rpc(method: str, params: list):
    url = f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', 8545)}"
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    with urllib.request.urlopen(urllib.request.Request(url, body, {"content-type": "application/json"}), timeout=60) as r:
        reply = json.load(r)
    if "error" in reply:
        raise SystemExit(f"{method} failed: {reply['error']}")
    return reply["result"]


def send(folder: Path, to: str | None, data: str, gas: int) -> str:
    """V signs a type-2 transaction and sends it to reth's pool. The key is read from its file and used here only."""
    account = Account.from_key(load_key(folder))
    tx = {"type": 2, "chainId": int(rpc("eth_chainId", []), 16), "nonce": int(rpc("eth_getTransactionCount", [account.address, "pending"]), 16),
          "value": 0, "gas": gas, "maxFeePerGas": MAX_FEE, "maxPriorityFeePerGas": PRIORITY_FEE, "data": "0x" + data}
    if to:
        tx["to"] = to_checksum_address(to)
    raw = account.sign_transaction(tx).raw_transaction.hex().removeprefix("0x")
    return rpc("eth_sendRawTransaction", ["0x" + raw])


def deploy_data(v_address: str) -> str:
    code = (ROOT / "demo" / "TKA.bin").read_text().strip()
    return code + pad32(v_address) + f"{SUPPLY:064x}"


def transfer_data(to: str, whole_tokens: int) -> str:
    return SELECTOR_TRANSFER + pad32(to) + f"{whole_tokens * ONE:064x}"


def balance(token: str, holder: str) -> int:
    return int(rpc("eth_call", [{"to": token, "data": "0x" + SELECTOR_BALANCE_OF + pad32(holder)}, "latest"]), 16) // ONE


def main(argv: list) -> dict:
    folder = state_dir()
    if argv[:1] == ["keys"] and len(argv) == 1:
        return make_keys(folder)
    if argv[:1] == ["genesis"] and len(argv) == 1:
        addresses = make_keys(folder)
        out = folder / "genesis.json"
        out.write_text(json.dumps(funded_genesis(json.loads((ROOT / "network" / "genesis.json").read_text()), addresses["v"]), indent=2))
        os.chmod(out, 0o644)   # reth's container user has to read it
        return {"genesis": str(out), "funded": addresses["v"]}
    if argv[:1] == ["deploy"] and len(argv) == 1:
        v = make_keys(folder)["v"]
        return {"tx": send(folder, None, deploy_data(v), DEPLOY_GAS), "supplyTo": v, "supply": 1000}
    if argv[:1] == ["transfer"] and len(argv) == 3 and argv[2].isdigit() and int(argv[2]) > 0:
        return {"tx": send(folder, argv[1], transfer_data(make_keys(folder)["u"], int(argv[2])), TRANSFER_GAS)}
    if argv[:1] == ["receipt"] and len(argv) == 2:
        r = rpc("eth_getTransactionReceipt", [argv[1]])
        if r is None:
            raise SystemExit(f"no receipt for {argv[1]}: the transaction is not in a block yet")
        return {"block": int(r["blockNumber"], 16), "blockHash": r["blockHash"], "gasUsed": int(r["gasUsed"], 16),
                "status": int(r["status"], 16), "contract": r.get("contractAddress")}
    if argv[:1] == ["balance"] and len(argv) == 3:
        return {"tka": balance(argv[1], argv[2])}
    raise SystemExit(__doc__)


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1:])))
