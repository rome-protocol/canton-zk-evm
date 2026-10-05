#!/usr/bin/env python3
"""Checks the gateway contract on a real reth. Run by gateway/tests/run.sh; see there.

  check.py genesis <state>   makes the test accounts' keys (mode 0600, in <state>/keys) and writes <state>/genesis.json:
                             network/genesis.json plus 10 ether for each account
  check.py run <state>       builds blocks by hand on the running reth (testing_buildBlockV1, engine_newPayloadV4,
                             engine_forkchoiceUpdatedV3, as prover/make-block.py does) and checks, for every function and every
                             refusal, the receipts, the events, the balances and the storage. For each block it works out the
                             running hash of the block's legs in Python, from the legs the test meant to make, and compares it with
                             legs[n] as eth_getProof reports it.
"""
import importlib.util, json, os, secrets, sys, time
from pathlib import Path

from eth_abi import decode, encode
from eth_account import Account
from eth_utils import to_checksum_address

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "builder"))
from keccak import keccak256  # noqa: E402  (the builder's own pure-Python Keccak-256, independent of the contract's)

_spec = importlib.util.spec_from_file_location("make_block", ROOT / "prover" / "make-block.py")
mb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mb)  # rpc_http, rpc_ws and the ports, as prover/make-block.py has them

PINS = dict(line.split("=", 1) for line in (ROOT / "PINS").read_text().splitlines() if "=" in line and not line.startswith("#"))
GW = PINS["GATEWAY_ADDRESS"]
RUNTIME = "0x" + (ROOT / "gateway" / "Gateway.bin-runtime").read_text().strip()
NAMES = ["deployer", "alice", "bob", "carol"]
ZERO32 = b"\0" * 32
EMPTY_STORAGE_ROOT = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"
EMPTY_PARTY_HASH = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
DEPOSIT, WITHDRAWAL, PAYMENT = 1, 2, 3
LEG_TOPIC = "0x" + keccak256(b"Leg(uint8,bytes32,address,address,uint256,string)").hex()
HTTP = mb.HTTP

failed = []


def ok(cond: bool, label: str) -> None:
    print(("ok: " if cond else "FAIL: ") + label)
    if not cond:
        failed.append(label)


def word(x) -> bytes:
    """An address, an id or a number (as an int or a hex quantity such as "0x1") as one 32-byte word."""
    return (int(x, 16) if isinstance(x, str) else int(x)).to_bytes(32, "big")


def selector(sig: str) -> str:
    return keccak256(sig.encode())[:4].hex()


def calldata(sig: str, values: list) -> str:
    types = sig[sig.index("(") + 1:-1]
    return "0x" + selector(sig) + (encode(types.split(","), values).hex() if types else "")


def create_address(sender: str, nonce: int) -> str:
    assert 0 < nonce < 128
    body = b"\x94" + bytes.fromhex(sender.removeprefix("0x")) + bytes([nonce])
    return "0x" + keccak256(bytes([0xC0 + len(body)]) + body)[12:].hex()


def leg_hash(legs: list) -> bytes:
    """The running hash of a block's legs, as the contract's documentation says: keccak256 over seven 32-byte words,
    starting from 32 zero bytes. A leg is (kind, id, token, account, amount, party)."""
    h = ZERO32
    for kind, ident, token, account, amount, party in legs:
        h = keccak256(h + word(kind) + word(ident) + word(token) + word(account) + word(amount) + keccak256(party.encode()))
    return h


def genesis(state: Path) -> None:
    keys = state / "keys"
    keys.mkdir(parents=True, exist_ok=True)
    base = json.loads((ROOT / "network" / "genesis.json").read_text())
    for name in NAMES:
        key = secrets.token_hex(32)
        fd = os.open(keys / f"{name}.hex", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(key)
        base["alloc"][Account.from_key("0x" + key).address.lower()] = {"balance": hex(10 * 10**18)}
    (state / "genesis.json").write_text(json.dumps(base, indent=2))


class Chain:
    def __init__(self, state: Path):
        self.jwt = bytes.fromhex((state / "reth" / "jwt.hex").read_text().strip())
        self.accounts = {n: Account.from_key("0x" + (state / "keys" / f"{n}.hex").read_text().strip()) for n in NAMES}
        self.nonces = {n: 0 for n in NAMES}
        self.chain_id = int(mb.rpc_http(HTTP, "eth_chainId", []), 16)

    def addr(self, who: str) -> str:
        return self.accounts[who].address.lower()

    def tx(self, who: str, to: str | None, data: str, gas: int = 3_000_000) -> str:
        """A signed type-2 transaction from one of the test accounts, as raw hex. Its nonce is used up whether or not it reverts."""
        t = {"type": 2, "chainId": self.chain_id, "nonce": self.nonces[who], "value": 0, "gas": gas,
             "maxFeePerGas": 10 * 10**9, "maxPriorityFeePerGas": 10**9, "data": data}
        if to:
            t["to"] = to_checksum_address(to)
        self.nonces[who] += 1
        return "0x" + Account.sign_transaction(t, self.accounts[who].key).raw_transaction.hex().removeprefix("0x")

    def block(self, raws: list) -> dict:
        """Builds one block on reth's head holding exactly these transactions, imports it and makes it the head."""
        parent = mb.rpc_http(HTTP, "eth_getBlockByNumber", ["latest", False])
        attributes = {"timestamp": hex(int(parent["timestamp"], 16) + 12), "prevRandao": "0x" + "00" * 32,
                      "suggestedFeeRecipient": "0x" + "00" * 20, "withdrawals": [], "parentBeaconBlockRoot": "0x" + "00" * 32}
        built = mb.rpc_ws("testing_buildBlockV1", [parent["hash"], attributes, raws, None])
        payload = built["executionPayload"]
        status = mb.rpc_http(mb.ENGINE, "engine_newPayloadV4", [payload, [], "0x" + "00" * 32, built["executionRequests"]], self.jwt)
        assert status["status"] == "VALID", status
        head = payload["blockHash"]
        fcu = mb.rpc_http(mb.ENGINE, "engine_forkchoiceUpdatedV3",
                          [{"headBlockHash": head, "safeBlockHash": head, "finalizedBlockHash": head}, None], self.jwt)
        assert fcu["payloadStatus"]["status"] == "VALID", fcu
        block = mb.rpc_http(HTTP, "eth_getBlockByNumber", ["latest", True])
        assert block["hash"] == head and len(block["transactions"]) == len(raws), "reth's block is not the one built"
        return block


def rpc(method: str, params: list):
    return mb.rpc_http(HTTP, method, params)


def call(to: str, sig: str, values: list, types: str | None = None):
    out = bytes.fromhex(rpc("eth_call", [{"to": to, "data": calldata(sig, values)}, "latest"]).removeprefix("0x"))
    return decode(types.split(","), out) if types else out


def storage_at(address: str, key: bytes) -> int:
    return int(rpc("eth_getStorageAt", [address, "0x" + key.hex(), "latest"]), 16)


def legs_at(number: int) -> bytes:
    """legs[number] as eth_getProof gives it: the storage proof of the key keccak256(number . 0), the slot of a mapping at 0."""
    proof = rpc("eth_getProof", [GW, ["0x" + keccak256(word(number) + word(0)).hex()], hex(number)])
    assert proof["accountProof"], "no account proof"
    return word(proof["storageProof"][0]["value"])


def block_legs(number: int) -> list:
    """The Leg events of one block, in log order, as (kind, id, token, account, amount, party)."""
    logs = rpc("eth_getLogs", [{"fromBlock": hex(number), "toBlock": hex(number), "address": GW, "topics": [LEG_TOPIC]}])
    out = []
    for log in logs:
        kind, ident, token, account, amount, party = decode(["uint8", "bytes32", "address", "address", "uint256", "string"],
                                                             bytes.fromhex(log["data"][2:]))
        out.append((kind, "0x" + ident.hex(), token, account, amount, party))
    return out


def statuses(block: dict) -> list:
    return [int(rpc("eth_getTransactionReceipt", [t["hash"]])["status"], 16) for t in block["transactions"]]


def same_legs(a: list, b: list) -> bool:
    norm = lambda legs: [(k, i.lower(), t.lower(), c.lower(), n, p) for k, i, t, c, n, p in legs]
    return norm(a) == norm(b)


def check_block(block: dict, meant: list, label: str) -> None:
    """The block's events are the legs the test meant, in that order, and legs[n] is the hash of exactly those."""
    n = int(block["number"], 16)
    ok(same_legs(block_legs(n), meant), f"{label}: the Leg events are the {len(meant)} meant, in order")
    ok(legs_at(n) == leg_hash(meant), f"{label}: legs[{n}] in the storage proof is the hash worked out in Python")


def run(state: Path) -> None:
    c = Chain(state)
    d, a, b, cc = (c.addr(n) for n in NAMES)
    ident = lambda s: "0x" + keccak256(s.encode()).hex()
    erc20 = lambda t, who: call(t, "balanceOf(address)", [who], "uint256")[0]
    supply = lambda t: call(t, "totalSupply()", [], "uint256")[0]
    used = lambda i: storage_at(GW, keccak256(word(i) + word(1))) == 1
    wrapped = lambda t: storage_at(GW, keccak256(word(t) + word(2))) == 1
    withdrawals = lambda: storage_at(GW, word(3))

    # --- the genesis holds the gateway: its runtime code, nonce 1, no balance and no storage
    proof = rpc("eth_getProof", [GW, [], "0x0"])
    ok(rpc("eth_getCode", [GW, "0x0"]) == RUNTIME, "block 0 holds the gateway's runtime code at GATEWAY_ADDRESS")
    ok(proof["codeHash"] == "0x" + keccak256(bytes.fromhex(RUNTIME[2:])).hex(), "the account's code hash is the hash of that code")
    ok(int(proof["nonce"], 16) == 1 and int(proof["balance"], 16) == 0, "the account has nonce 1 and no balance")
    ok(proof["storageHash"] == EMPTY_STORAGE_ROOT, "the account has no storage")
    ok(EMPTY_PARTY_HASH == keccak256(b"").hex(), "the Keccak-256 of an empty party is the value the documents name")

    # --- blocks without legs: legs[n] reads as zero
    c.block([])
    ok(legs_at(1) == ZERO32 and block_legs(1) == [], "an empty block has no legs and legs[1] is zero")

    # --- register: anyone makes a wrapped token; it is a leg of nothing
    wtkb, wtkc = create_address(GW, 1), create_address(GW, 2)
    ok(call(GW, "register(string,string)", ["Wrapped TKB", "wTKB"], "address")[0].lower() == wtkb, "register would make the token at the CREATE address of nonce 1")
    blk = c.block([c.tx("alice", GW, calldata("register(string,string)", ["Wrapped TKB", "wTKB"])),
                   c.tx("bob", GW, calldata("register(string,string)", ["Wrapped TKC", "wTKC"]))])
    ok(statuses(blk) == [1, 1], "two registers")
    ok(wrapped(wtkb) and wrapped(wtkc), "wrapped[token] is set for both")
    ok(rpc("eth_getCode", [wtkb, "latest"]) == rpc("eth_getCode", [wtkc, "latest"]) != "0x", "both are the same code")
    ok(call(wtkb, "name()", [], "string")[0] == "Wrapped TKB" and call(wtkb, "symbol()", [], "string")[0] == "wTKB", "the token has its name and symbol")
    ok(call(wtkb, "decimals()", [], "uint8")[0] == 10 and supply(wtkb) == 0, "the token has 10 decimals and no supply")
    check_block(blk, [], "register")

    # --- the test tokens: TKA (a plain ERC-20, 1000 tokens to alice), the three badly behaved ones and one that lets anyone mint and burn
    mocks = {k.split(":")[1]: v["bin"] for k, v in json.loads((state / "mocks.json").read_text())["contracts"].items()}
    tka_code = (ROOT / "demo" / "TKA.bin").read_text().strip() + encode(["address", "uint256"], [a, 1000 * 10**18]).hex()
    blk = c.block([c.tx("deployer", None, "0x" + tka_code),
                   c.tx("deployer", None, "0x" + mocks["FalseToken"]),
                   c.tx("deployer", None, "0x" + mocks["SilentToken"]),
                   c.tx("deployer", None, "0x" + mocks["CallbackToken"] + encode(["address"], [GW]).hex()),
                   c.tx("deployer", None, "0x" + mocks["OpenToken"])])
    tka, false_token, silent_token, callback, open_token = (rpc("eth_getTransactionReceipt", [t["hash"]])["contractAddress"] for t in blk["transactions"])
    ok(all(statuses(blk)) and erc20(tka, a) == 1000 * 10**18, "the test tokens are deployed; alice holds 1000 TKA")

    # --- claim (a deposit leg): the recipient mints to herself
    id1, id2, id3 = ident("deposit-1"), ident("deposit-2"), ident("dvp-1")
    blk = c.block([c.tx("bob", GW, calldata("claim(bytes32,address,uint256)", [bytes.fromhex(id1[2:]), wtkb, 10 * 10**10]))])
    check_block(blk, [(DEPOSIT, id1, wtkb, b, 10 * 10**10, "")], "claim")
    ok(statuses(blk) == [1] and erc20(wtkb, b) == 10 * 10**10 and supply(wtkb) == 10 * 10**10, "claim mints to the caller and the supply is the amount")
    ok(used(id1), "used[id] is set by the claim")

    # --- one block with three legs of three kinds, and a refused transaction between them
    party = "bob::1220" + "ab" * 34
    wid1 = "0x" + keccak256(word(c.chain_id) + word(GW) + word(1)).hex()
    blk = c.block([
        c.tx("carol", GW, calldata("claim(bytes32,address,uint256)", [bytes.fromhex(id2[2:]), wtkb, 5 * 10**10])),
        c.tx("alice", GW, calldata("claim(bytes32,address,uint256)", [bytes.fromhex(id1[2:]), wtkb, 1])),          # id used: reverts
        c.tx("bob", GW, calldata("withdraw(address,uint256,string)", [wtkb, 4 * 10**10, party])),
        c.tx("alice", tka, calldata("approve(address,uint256)", [GW, 2 * 10**18])),
        c.tx("alice", GW, calldata("pay(bytes32,address,address,uint256)", [bytes.fromhex(id3[2:]), tka, cc, 10**18])),
    ])
    check_block(blk, [(DEPOSIT, id2, wtkb, cc, 5 * 10**10, ""), (WITHDRAWAL, wid1, wtkb, b, 4 * 10**10, party),
                      (PAYMENT, id3, tka, cc, 10**18, "")], "three legs")
    ok(statuses(blk) == [1, 0, 1, 1, 1], "the transaction that reused a deposit id reverted and the others did not")
    ok(erc20(wtkb, b) == 6 * 10**10 and erc20(wtkb, cc) == 5 * 10**10 and supply(wtkb) == 11 * 10**10, "the burn and the mint moved the balances and the supply")
    ok(withdrawals() == 1, "the withdrawal counter is 1")
    ok(erc20(tka, a) == 999 * 10**18 and erc20(tka, cc) == 10**18, "pay moved the TKA from the payer to the payee")
    ok(used(id3), "used[id] is set by the payment")

    # --- the next block starts again from zero; a second withdrawal has another id
    wid2 = "0x" + keccak256(word(c.chain_id) + word(GW) + word(2)).hex()
    blk = c.block([c.tx("carol", GW, calldata("withdraw(address,uint256,string)", [wtkb, 5 * 10**10, party]))])
    check_block(blk, [(WITHDRAWAL, wid2, wtkb, cc, 5 * 10**10, party)], "second withdrawal")
    ok(wid1 != wid2 and withdrawals() == 2 and supply(wtkb) == 6 * 10**10, "the withdrawal ids differ, the counter is 2, the supply is 6")

    # --- every refusal reverts, leaves no leg and changes nothing
    fresh = [bytes.fromhex(ident(f"fresh-{i}")[2:]) for i in range(10)]
    unknown = "0x" + "99" * 20
    refused = [
        ("claim of zero", c.tx("bob", GW, calldata("claim(bytes32,address,uint256)", [fresh[0], wtkb, 0]))),
        ("claim of a token that is not wrapped", c.tx("bob", GW, calldata("claim(bytes32,address,uint256)", [fresh[1], open_token, 1]))),
        ("claim of a plain ERC-20 that is not wrapped", c.tx("bob", GW, calldata("claim(bytes32,address,uint256)", [fresh[8], tka, 1]))),
        ("claim of an address that is not a token", c.tx("bob", GW, calldata("claim(bytes32,address,uint256)", [fresh[2], unknown, 1]))),
        ("claim with a used id", c.tx("bob", GW, calldata("claim(bytes32,address,uint256)", [bytes.fromhex(id2[2:]), wtkb, 1]))),
        ("withdraw of zero", c.tx("bob", GW, calldata("withdraw(address,uint256,string)", [wtkb, 0, party]))),
        ("withdraw of a token that is not wrapped", c.tx("alice", GW, calldata("withdraw(address,uint256,string)", [open_token, 1, party]))),
        ("withdraw of a plain ERC-20 that is not wrapped", c.tx("alice", GW, calldata("withdraw(address,uint256,string)", [tka, 1, party]))),
        ("withdraw of more than the balance", c.tx("bob", GW, calldata("withdraw(address,uint256,string)", [wtkb, 6 * 10**10 + 1, party]))),
        ("pay of zero", c.tx("alice", GW, calldata("pay(bytes32,address,address,uint256)", [fresh[3], tka, cc, 0]))),
        ("pay with a used id", c.tx("alice", GW, calldata("pay(bytes32,address,address,uint256)", [bytes.fromhex(id3[2:]), tka, cc, 1]))),
        ("pay of a token that says no", c.tx("alice", GW, calldata("pay(bytes32,address,address,uint256)", [fresh[4], false_token, cc, 1]))),
        ("pay of a token that says nothing", c.tx("alice", GW, calldata("pay(bytes32,address,address,uint256)", [fresh[5], silent_token, cc, 1]))),
        ("pay without an allowance", c.tx("carol", GW, calldata("pay(bytes32,address,address,uint256)", [fresh[6], tka, a, 1]))),
        ("pay of an address with no code", c.tx("alice", GW, calldata("pay(bytes32,address,address,uint256)", [fresh[7], unknown, cc, 1]))),
        ("mint by someone who is not the gateway", c.tx("alice", wtkb, calldata("mint(address,uint256)", [a, 1]))),
        ("burn by someone who is not the gateway", c.tx("bob", wtkb, calldata("burn(address,uint256)", [b, 1]))),
    ]
    before = (supply(wtkb), erc20(wtkb, b), erc20(tka, a), withdrawals())
    blk = c.block([raw for _, raw in refused])
    ok(statuses(blk) == [0] * len(refused), "every refusal reverted: " + ", ".join(label for label, _ in refused))
    check_block(blk, [], "refusals")
    ok((supply(wtkb), erc20(wtkb, b), erc20(tka, a), withdrawals()) == before, "the refusals changed no supply, balance or counter")
    ok(not any(used("0x" + f.hex()) for f in fresh), "a refused claim or payment did not use up its id")

    # --- a token that calls back into the gateway while pay is moving it
    idp1, idp2, idq = (bytes.fromhex(ident(s)[2:]) for s in ("pay-p1", "pay-p2", "pay-q"))
    pay = lambda i, amount: calldata("pay(bytes32,address,address,uint256)", [i, callback, cc, amount])
    blk = c.block([c.tx("deployer", callback, calldata("arm(bytes)", [bytes.fromhex(pay(idp1, 7)[2:])])),
                   c.tx("alice", GW, pay(idp1, 7))])
    ok(statuses(blk) == [1, 1], "a payment whose token calls back with the same id goes through")
    ok(call(callback, "lastOk()", [], "bool")[0] is False, "the callback with the same id found it used and failed")
    check_block(blk, [(PAYMENT, "0x" + idp1.hex(), callback, cc, 7, "")], "callback, same id")
    blk = c.block([c.tx("deployer", callback, calldata("arm(bytes)", [bytes.fromhex(pay(idq, 9)[2:])])),
                   c.tx("alice", GW, pay(idp2, 5))])
    ok(statuses(blk) == [1, 1] and call(callback, "lastOk()", [], "bool")[0] is True, "a callback with another id goes through")
    check_block(blk, [(PAYMENT, "0x" + idp2.hex(), callback, cc, 5, ""), (PAYMENT, "0x" + idq.hex(), callback, cc, 9, "")],
                "callback, another id (the outer leg first)")

    # --- the wrapped token is a plain ERC-20 between holders, and a block of plain transfers has no legs
    blk = c.block([c.tx("bob", wtkb, calldata("transfer(address,uint256)", [a, 10**10])),
                   c.tx("bob", wtkb, calldata("approve(address,uint256)", [cc, 10**10])),
                   c.tx("carol", wtkb, calldata("transferFrom(address,address,uint256)", [b, d, 10**10]))])
    ok(statuses(blk) == [1, 1, 1] and erc20(wtkb, a) == 10**10 and erc20(wtkb, d) == 10**10 and supply(wtkb) == 6 * 10**10,
       "transfer, approve and transferFrom of a wrapped token work and leave the supply alone")
    check_block(blk, [], "plain transfers")

    if failed:
        sys.exit(f"{len(failed)} check(s) failed")
    print("all gateway checks passed")


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "genesis":
        genesis(Path(args[1]))
    elif len(args) == 2 and args[0] == "run":
        run(Path(args[1]))
    else:
        sys.exit(__doc__)
