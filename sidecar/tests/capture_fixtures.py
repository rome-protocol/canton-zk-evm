#!/usr/bin/env python3
"""Helper for capture_fixtures.sh.

  capture <state-folder> <out-folder>
      Against the running reth (which holds the gateway in its genesis and has block 1, the plain transfer that
      prover/make-block.py builds), builds three more blocks with the test key, and writes:
        block.json  block 1: its hash, its header and its transaction list as they sit in the block's own encoding, and
                    the fields reth reports for it
        legs.json   the gateway's proof for four blocks, each taken while the block was the newest one: block 1 (the
                    gateway has nothing stored yet), block 2 (a wrapped token is registered and no leg is recorded, but the
                    gateway now has storage), block 3 (one deposit) and block 4 (a deposit, a withdrawal and a payment).
                    Each block has the legs it recorded, written as the sidecar's `legs` function reads them.

The key is the one prover/make-block.py made, kept in the state folder (mode 0600) and never printed.
"""
import importlib.util, json, sys
from pathlib import Path

from eth_abi import decode, encode
from eth_account import Account
from eth_hash.auto import keccak
from eth_utils import to_checksum_address

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("make_block", ROOT / "prover" / "make-block.py")
mb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mb)  # the ports and the rpc helpers, as prover/make-block.py has them

PINS = dict(line.split("=", 1) for line in (ROOT / "PINS").read_text().splitlines() if "=" in line and not line.startswith("#"))
GATEWAY = PINS["GATEWAY_ADDRESS"].lower()
KINDS = {1: "deposit", 2: "withdrawal", 3: "payment"}
LEG_TOPIC = "0x" + keccak(b"Leg(uint8,bytes32,address,address,uint256,string)").hex()
PAYEE = "0x" + "44" * 20
PARTY = "bob::1220" + "ab" * 34  # a Canton party id: the withdrawal's receiver


def strip(h: str) -> str:
    return h.removeprefix("0x")


def pad32(x: bytes) -> bytes:
    return x.rjust(32, b"\0")


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


def canton_amount(base_units: int) -> str:
    """An amount in base units (10 decimals) as Daml writes a Decimal: 10.0, 0.25, 0.0000000001."""
    whole, frac = divmod(base_units, 10**10)
    return f"{whole}.{str(frac).rjust(10, '0').rstrip('0') or '0'}"


def create_address(sender: str, nonce: int) -> str:
    """The address a contract makes with its first CREATEs: the Keccak-256 of the RLP of [sender, nonce], for a small nonce."""
    assert 0 < nonce < 128
    body = b"\x94" + bytes.fromhex(strip(sender)) + bytes([nonce])
    return "0x" + keccak(bytes([0xC0 + len(body)]) + body)[12:].hex()


def calldata(sig: str, types: list, values: list) -> str:
    return "0x" + keccak(sig.encode())[:4].hex() + encode(types, values).hex()


class Chain:
    def __init__(self, state: Path):
        self.jwt = bytes.fromhex((state / "reth" / "jwt.hex").read_text().strip())
        self.key = "0x" + (state / "test-key.hex").read_text().strip()
        self.address = Account.from_key(self.key).address.lower()
        self.chain_id = int(mb.rpc_http(mb.HTTP, "eth_chainId", []), 16)
        self.nonce = 1  # block 1 used nonce 0

    def tx(self, to: str, data: str, gas: int = 1_000_000) -> str:
        t = {"type": 2, "chainId": self.chain_id, "nonce": self.nonce, "value": 0, "gas": gas,
             "maxFeePerGas": 10 * 10**9, "maxPriorityFeePerGas": 10**9, "data": data, "to": to_checksum_address(to)}
        self.nonce += 1
        return "0x" + Account.sign_transaction(t, self.key).raw_transaction.hex().removeprefix("0x")

    def block(self, raws: list) -> dict:
        """Builds one block on reth's head holding exactly these transactions, imports it and makes it the head."""
        parent = mb.rpc_http(mb.HTTP, "eth_getBlockByNumber", ["latest", False])
        attributes = {"timestamp": hex(int(parent["timestamp"], 16) + 12), "prevRandao": mb.ZERO32,
                      "suggestedFeeRecipient": "0x" + "00" * 20, "withdrawals": [], "parentBeaconBlockRoot": mb.ZERO32}
        built = mb.rpc_ws("testing_buildBlockV1", [parent["hash"], attributes, raws, None])
        payload = built["executionPayload"]
        status = mb.rpc_http(mb.ENGINE, "engine_newPayloadV4", [payload, [], mb.ZERO32, built["executionRequests"]], self.jwt)
        assert status["status"] == "VALID", status
        head = payload["blockHash"]
        fcu = mb.rpc_http(mb.ENGINE, "engine_forkchoiceUpdatedV3",
                          [{"headBlockHash": head, "safeBlockHash": head, "finalizedBlockHash": head}, None], self.jwt)
        assert fcu["payloadStatus"]["status"] == "VALID", fcu
        block = mb.rpc_http(mb.HTTP, "eth_getBlockByNumber", ["latest", True])
        assert block["hash"] == head and len(block["transactions"]) == len(raws), "reth's block is not the one built"
        for t in block["transactions"]:
            receipt = mb.rpc_http(mb.HTTP, "eth_getTransactionReceipt", [t["hash"]])
            assert int(receipt["status"], 16) == 1, f"a transaction of block {int(block['number'], 16)} reverted"
        return block


def legs_of(number: int) -> list:
    """The legs a block recorded, from the gateway's events and in their order, in the form the sidecar's `legs` reads."""
    logs = mb.rpc_http(mb.HTTP, "eth_getLogs", [{"fromBlock": hex(number), "toBlock": hex(number), "address": GATEWAY, "topics": [LEG_TOPIC]}])
    out = []
    for log in logs:
        kind, ident, token, account, amount, party = decode(["uint8", "bytes32", "address", "address", "uint256", "string"],
                                                             bytes.fromhex(strip(log["data"])))
        out.append({
            "kind": KINDS[kind],
            "id": ident.hex(),
            "token": strip(token),
            "account": strip(account),
            "amount": canton_amount(amount) if kind != 3 else amount.to_bytes(32, "big").hex(),
            "party": party.encode().hex(),
        })
    return out


def gateway_proof(number: int, block: dict) -> dict:
    """The gateway's account proof and the storage proof of legs[number], while that block is the newest."""
    key = keccak(pad32(number.to_bytes(32, "big")) + pad32(b"\0"))
    proof = mb.rpc_http(mb.HTTP, "eth_getProof", [GATEWAY, ["0x" + key.hex()], hex(number)])
    return {
        "number": number,
        "stateRoot": strip(block["stateRoot"]),
        "accountNodes": [strip(n) for n in proof["accountProof"]],
        "storageNodes": [strip(n) for n in proof["storageProof"][0]["proof"]],
        "value": strip(proof["storageProof"][0]["value"]).rjust(64, "0"),
        "legs": legs_of(number),
    }


def block_json(block: dict) -> dict:
    raw = bytes.fromhex(strip(mb.rpc_ws("debug_getRawBlock", [block["number"]])))
    _, end, at = rlp_item(raw, 0)
    assert end == len(raw), "the raw block is not one list"
    h_start, h_end, _ = rlp_item(raw, at)  # the header
    t_start, t_end, _ = rlp_item(raw, h_end)  # the transactions
    header, txs = raw[h_start:h_end], raw[t_start:t_end]
    assert keccak(header).hex() == strip(block["hash"]), "the header does not hash to the block's hash"
    return {
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
    }


def capture(state: Path, out: Path) -> None:
    c = Chain(state)
    ident = lambda s: keccak(s.encode())
    block1 = mb.rpc_http(mb.HTTP, "eth_getBlockByNumber", ["0x1", False])
    assert block1["number"] == "0x1", "block 1 is not there: run prover/make-block.py build first"
    assert int(mb.rpc_http(mb.HTTP, "eth_blockNumber", []), 16) == 1, "reth is past block 1"
    blocks = {"unused": gateway_proof(1, block1)}
    one = block_json(mb.rpc_http(mb.HTTP, "eth_getBlockByNumber", ["0x1", False]))

    # Block 2: a wrapped token is registered. No leg, but the gateway now has storage.
    token = create_address(GATEWAY, 1)
    b2 = c.block([c.tx(GATEWAY, calldata("register(string,string)", ["string", "string"], ["Wrapped TKB", "wTKB"]), 3_000_000)])
    assert mb.rpc_http(mb.HTTP, "eth_getCode", [token, "latest"]) != "0x", "the wrapped token is not where it should be"
    blocks["registered"] = gateway_proof(2, b2)

    # Block 3: one deposit.
    claim = lambda i, amount: calldata("claim(bytes32,address,uint256)", ["bytes32", "address", "uint256"], [i, token, amount])
    b3 = c.block([c.tx(GATEWAY, claim(ident("deposit-1"), 10 * 10**10))])
    blocks["deposit"] = gateway_proof(3, b3)

    # Block 4: a deposit, a withdrawal and a payment (of the wrapped token, which is a plain ERC-20 to the gateway).
    b4 = c.block([
        c.tx(GATEWAY, claim(ident("deposit-2"), 5 * 10**10)),
        c.tx(GATEWAY, calldata("withdraw(address,uint256,string)", ["address", "uint256", "string"], [token, 4 * 10**10, PARTY])),
        c.tx(token, calldata("approve(address,uint256)", ["address", "uint256"], [GATEWAY, 10**10])),
        c.tx(GATEWAY, calldata("pay(bytes32,address,address,uint256)", ["bytes32", "address", "address", "uint256"],
                               [ident("dvp-1"), token, PAYEE, 10**10])),
    ])
    blocks["three"] = gateway_proof(4, b4)
    assert [leg["kind"] for leg in blocks["three"]["legs"]] == ["deposit", "withdrawal", "payment"], "block 4 has the wrong legs"
    assert [len(blocks[k]["legs"]) for k in ("unused", "registered", "deposit")] == [0, 0, 1], "a block has the wrong legs"

    out.mkdir(parents=True, exist_ok=True)
    (out / "block.json").write_text(json.dumps(one, indent=2) + "\n")
    (out / "legs.json").write_text(json.dumps({"gateway": strip(GATEWAY), "blocks": blocks}, indent=2) + "\n")
    print(f"wrote {out}/block.json (block 1) and {out}/legs.json (blocks 1 to 4)")


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "capture":
        capture(Path(args[1]), Path(args[2]))
    else:
        sys.exit(__doc__)
