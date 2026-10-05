#!/usr/bin/env python3
"""Helper for capture_fixtures.sh.

  genesis <state-folder>   adds a token account to the funded genesis copy: it holds 10 tokens
                           (10 * 10^18) for one holder in the mapping at slot 0.
  capture <out-folder>     asks the running reth for block 1 and for the token's proofs, and writes
                           block.json and balances.json.
"""
import json, os, sys
import urllib.request
from pathlib import Path

from eth_hash.auto import keccak
from websockets.sync.client import connect

HTTP = f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', 8545)}"
WS = f"ws://127.0.0.1:{os.environ.get('RETH_WS_PORT', 8546)}"
TOKEN = "11" * 20
HOLDER = "22" * 20
NOBODY = "33" * 20
TEN_TOKENS = 10 * 10**18


def pad32(hex_no_prefix: str) -> bytes:
    return bytes.fromhex(hex_no_prefix).rjust(32, b"\0")


def balance_key(holder: str, slot: int = 0) -> bytes:
    return keccak(pad32(holder) + slot.to_bytes(32, "big"))


def genesis(state: Path) -> None:
    path = state / "run" / "network" / "genesis.json"
    genesis = json.loads(path.read_text())
    genesis["alloc"]["0x" + TOKEN] = {
        "nonce": "0x1",
        "balance": "0x0",
        "code": "0x00",
        "storage": {"0x" + balance_key(HOLDER).hex(): "0x" + TEN_TOKENS.to_bytes(32, "big").hex()},
    }
    path.write_text(json.dumps(genesis, indent=2))


def rpc_http(method: str, params: list):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    request = urllib.request.Request(HTTP, body, {"content-type": "application/json"})
    with urllib.request.urlopen(request) as r:
        reply = json.load(r)
    if "error" in reply:
        sys.exit(f"{method} failed: {reply['error']}")
    return reply["result"]


def rpc_ws(method: str, params: list):
    with connect(WS, max_size=None) as ws:
        ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
        reply = json.loads(ws.recv())
    if "error" in reply:
        sys.exit(f"{method} failed: {reply['error']}")
    return reply["result"]


def rlp_item(b: bytes, i: int):
    """(start, end) of the item at i, and where its payload starts."""
    p = b[i]
    if p < 0x80:
        return i, i + 1, i
    if p < 0xB8:
        return i, i + 1 + p - 0x80, i + 1
    if p < 0xC0:
        n = p - 0xB7
        return i, i + 1 + n + int.from_bytes(b[i + 1 : i + 1 + n], "big"), i + 1 + n
    if p < 0xF8:
        return i, i + 1 + p - 0xC0, i + 1
    n = p - 0xF7
    return i, i + 1 + n + int.from_bytes(b[i + 1 : i + 1 + n], "big"), i + 1 + n


def strip(h: str) -> str:
    return h.removeprefix("0x")


def capture(out: Path) -> None:
    block = rpc_http("eth_getBlockByNumber", ["0x1", False])
    raw = bytes.fromhex(strip(rpc_ws("debug_getRawBlock", ["0x1"])))
    _, end, at = rlp_item(raw, 0)
    assert end == len(raw), "the raw block is not one list"
    h_start, h_end, at2 = rlp_item(raw, at)  # the header
    t_start, t_end, _ = rlp_item(raw, h_end)  # the transactions
    header, txs = raw[h_start:h_end], raw[t_start:t_end]
    assert keccak(header).hex() == strip(block["hash"]), "the header does not hash to the block's hash"
    (out / "block.json").write_text(json.dumps({
        "hash": strip(block["hash"]),
        "parentHash": strip(block["parentHash"]),
        "number": int(block["number"], 16),
        "stateRoot": strip(block["stateRoot"]),
        "timestamp": int(block["timestamp"], 16),
        "gasLimit": int(block["gasLimit"], 16),
        "gasUsed": int(block["gasUsed"], 16),
        "txCount": len(block["transactions"]),
        "header": header.hex(),
        "txs": txs.hex(),
    }, indent=2) + "\n")

    keys = ["0x" + balance_key(h).hex() for h in (HOLDER, NOBODY)]
    proof = rpc_http("eth_getProof", ["0x" + TOKEN, keys, "0x1"])
    account_nodes = [strip(n) for n in proof["accountProof"]]

    def holder(name: str, entry: dict) -> dict:
        return {
            "holder": name,
            "value": strip(entry["value"]).rjust(64, "0"),
            "accountNodes": account_nodes,
            "storageNodes": [strip(n) for n in entry["proof"]],
        }

    (out / "balances.json").write_text(json.dumps({
        "stateRoot": strip(block["stateRoot"]),
        "token": TOKEN,
        "slot": 0,
        "present": holder(HOLDER, proof["storageProof"][0]),
        "absent": holder(NOBODY, proof["storageProof"][1]),
    }, indent=2) + "\n")
    print(f"wrote {out}/block.json and {out}/balances.json (block {block['number']}, {len(block['transactions'])} transaction)")


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "genesis":
        genesis(Path(args[1]))
    elif len(args) == 2 and args[0] == "capture":
        capture(Path(args[1]))
    else:
        sys.exit(__doc__)
