#!/usr/bin/env python3
"""Puts the standard contracts at their canonical addresses on an EVM chain. See network/standard-contracts/README.md.

  deploy.py --rpc <URL> --funding-key-file <FILE> [--dry-run] [--only <name,name>] [--wait-seconds <N>]

    create2-deployer  0x4e59b44847b379578588920cA78FbF26c0B4956C   (keyless, presigned)
    multicall3        0xcA11bde05977b3631167028862bE2a173976CA11   (keyless, presigned)
    createx           0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed   (keyless, presigned)
    permit2           0x000000000022D473030F116dDEE9F6B43aC78BA3   (through the CREATE2 deployer, canonical salt and init code)

  For each one, in this order:
    - the address has code whose Keccak-256 is the canonical runtime code hash: it is skipped;
    - the address has other code: nothing is sent for any contract, and this exits 1 (the address cannot be used);
    - no code: a presigned one is deployed by funding its one-time signer with the shortfall of gasLimit x gasPrice (nothing if it holds that
      already), waiting for the funding, and sending the signed transaction as it is; Permit2 is a transaction of the funding account to the
      CREATE2 deployer. Then the code at the address is read and its hash checked.
  A run that finds all of them in place sends nothing. --dry-run reads the chain and prints what a run would do; it sends nothing.

The data (the presigned transactions, the Permit2 init code, the runtime code hashes and where each comes from) is contracts.json beside this
file. Before it touches the chain, this checks the data against itself: each presigned transaction's signer, its nonce, its gas, the address its
creation gives, and the Permit2 address that its init code and salt give from the deployer. A mismatch stops it.

--funding-key-file holds the funding account's key as hex (with or without 0x); a file that the group or others have any permission on is
refused (mode 0600 or 0400 work). The key
is read here, used to sign, and never printed. The funding account pays for the funding transfers and for Permit2's deployment.

The presigned transactions are not tied to a chain (they are signed before EIP-155). A node that refuses those (Ostia's public RPC does) cannot
take them: give --rpc the RPC of the chain's own reth. Needs: pip install eth-account (demo/requirements.txt pins it).
"""
import argparse, json, os, re, stat, sys, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "builder"))
from keccak import keccak256

USER_AGENT = "ostia-standard-contracts/1 Rome Protocol rome@romeprotocol.com"
DATA_FILE = HERE / "contracts.json"
FUNDING_TX_GAS = 21_000
CREATE2_FALLBACK_GAS = 4_000_000   # the gas limit shown in a dry run before the deployer exists (a real run asks the node)
GWEI = 10**9
TYPE_HASH = keccak256(b"EIP712Domain(string name,uint256 chainId,address verifyingContract)")   # Permit2's EIP-712 domain
NAME_HASH = keccak256(b"Permit2")


class Stop(Exception):
    """A refusal or a failure: the message is printed and the exit code is 1."""


# ---- RLP, for the presigned transactions (no dependency: a legacy transaction is a list of nine byte strings)

def rlp_item(b: bytes, i: int):
    p = b[i]
    if p < 0x80:
        return b[i:i + 1], i + 1
    if p < 0xb8:
        n = p - 0x80
        return b[i + 1:i + 1 + n], i + 1 + n
    if p < 0xc0:
        ll = p - 0xb7
        n = int.from_bytes(b[i + 1:i + 1 + ll], "big")
        return b[i + 1 + ll:i + 1 + ll + n], i + 1 + ll + n
    if p < 0xf8:
        n, s = p - 0xc0, i + 1
    else:
        ll = p - 0xf7
        n, s = int.from_bytes(b[i + 1:i + 1 + ll], "big"), i + 1 + ll
    items, j = [], s
    while j < s + n:
        x, j = rlp_item(b, j)
        items.append(x)
    return items, s + n


def rlp_encode(x) -> bytes:
    if isinstance(x, int):
        x = x.to_bytes((x.bit_length() + 7) // 8, "big")
    if isinstance(x, bytes):
        if len(x) == 1 and x[0] < 0x80:
            return x
        return rlp_length(0x80, len(x)) + x
    body = b"".join(rlp_encode(e) for e in x)
    return rlp_length(0xc0, len(body)) + body


def rlp_length(base: int, n: int) -> bytes:
    if n < 56:
        return bytes([base + n])
    size = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([base + 55 + len(size)]) + size


def decode_legacy(raw: bytes) -> dict:
    fields, end = rlp_item(raw, 0)
    if end != len(raw) or not isinstance(fields, list) or len(fields) != 9:
        raise Stop("a presigned transaction is not a legacy transaction")
    nonce, price, gas, to, value, data, v, r, s = fields
    num = lambda b: int.from_bytes(b, "big")
    return {"nonce": num(nonce), "gasPrice": num(price), "gasLimit": num(gas), "to": to, "value": num(value), "data": data,
            "v": num(v), "r": num(r), "s": num(s), "unsigned": rlp_encode(fields[:6])}


def recover_signer(tx: dict) -> str:
    from eth_keys import keys
    sig = keys.Signature(vrs=(tx["v"] - 27, tx["r"], tx["s"]))
    return sig.recover_public_key_from_msg_hash(keccak256(tx["unsigned"])).to_checksum_address()


def create_address(sender: str, nonce: int) -> str:
    return "0x" + keccak256(rlp_encode([bytes.fromhex(sender[2:]), nonce]))[12:].hex()


def create2_address(deployer: str, salt: bytes, init_code: bytes) -> str:
    return "0x" + keccak256(b"\xff" + bytes.fromhex(deployer[2:]) + salt + keccak256(init_code))[12:].hex()


# ---- the data

def hexbytes(s: str) -> bytes:
    return bytes.fromhex(s.removeprefix("0x"))


def lower(a: str) -> str:
    return a.lower()


def runtime_code(entry: dict, init_code: bytes, chain_id: int) -> bytes:
    """The runtime code the entry's creation leaves at its address on that chain: the init code after the constructor, with the 'immutable'
    slots filled (the contract's address for `address`; for Permit2 the chain id and the domain separator built from it)."""
    code = bytearray(init_code[entry["runtimeStart"]:])
    address = hexbytes(entry["address"])
    for im in entry["immutables"]:
        at = im["offset"]
        if code[at:at + 32] != bytes(32):
            raise Stop(f"{entry['name']}: the init code is not zero where an immutable goes (offset {at})")
        if im["kind"] == "address":
            word = bytes(12) + address
        elif im["kind"] == "chainId":
            word = chain_id.to_bytes(32, "big")
        elif im["kind"] == "domainSeparator":
            word = keccak256(TYPE_HASH + NAME_HASH + chain_id.to_bytes(32, "big") + bytes(12) + address)
        else:
            raise Stop(f"{entry['name']}: unknown immutable kind {im['kind']}")
        code[at:at + 32] = word
    return bytes(code)


def init_code_of(entry: dict) -> bytes:
    return hexbytes(entry["initCode"]) if entry["how"] == "create2" else decode_legacy(hexbytes(entry["presignedTx"]))["data"]


def expected_hash(entry: dict, chain_id: int) -> str:
    h = "0x" + keccak256(runtime_code(entry, init_code_of(entry), chain_id)).hex()
    pinned = entry["runtimeCodeHash"] or entry.get("knownRuntimeCodeHashes", {}).get(str(chain_id))
    if pinned is not None and pinned != h:
        raise Stop(f"{entry['name']}: the runtime code hash worked out for chain {chain_id} ({h}) is not the one in {DATA_FILE.name} ({pinned})")
    return h


def load_data() -> list:
    """Reads contracts.json and checks every entry against itself. Offline."""
    entries = json.loads(DATA_FILE.read_text())["contracts"]
    by_name = {e["name"]: e for e in entries}
    for e in entries:
        name = e["name"]
        if e["how"] == "presigned":
            tx = decode_legacy(hexbytes(e["presignedTx"]))
            if tx["v"] not in (27, 28):
                raise Stop(f"{name}: the presigned transaction carries a chain id (v is {tx['v']}); a keyless deployment is signed before EIP-155")
            if tx["nonce"] != 0 or tx["to"] != b"" or tx["value"] != 0:
                raise Stop(f"{name}: the presigned transaction is not a contract creation with nonce 0 and no value")
            if (tx["gasLimit"], tx["gasPrice"]) != (e["gasLimit"], e["gasPrice"]):
                raise Stop(f"{name}: the presigned transaction's gas limit or gas price is not the one in {DATA_FILE.name}")
            signer = recover_signer(tx)
            if signer != e["signer"]:
                raise Stop(f"{name}: the presigned transaction's signer is {signer}, not {e['signer']}")
            if lower(create_address(signer, 0)) != lower(e["address"]):
                raise Stop(f"{name}: the signer's first contract is at {create_address(signer, 0)}, not {e['address']}")
        elif e["how"] == "create2":
            via = by_name.get(e["via"])
            if via is None:
                raise Stop(f"{name}: the CREATE2 deployer {e['via']} is not in {DATA_FILE.name}")
            got = create2_address(via["address"], hexbytes(e["salt"]), hexbytes(e["initCode"]))
            if lower(got) != lower(e["address"]):
                raise Stop(f"{name}: the salt and init code give {got} from {via['address']}, not {e['address']}")
        else:
            raise Stop(f"{name}: unknown way of deploying: {e['how']}")
    return entries


# ---- the node

class Node:
    def __init__(self, url: str):
        self.url = url

    def call(self, method: str, params: list):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(self.url, body, {"content-type": "application/json", "user-agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                reply = json.load(r)
        except OSError as e:
            raise Stop(f"{method}: cannot reach {self.url}: {e}")
        if "error" in reply:
            raise Stop(f"{method} failed: {reply['error'].get('message', reply['error'])}")
        return reply["result"]

    def number(self, method: str, params: list) -> int:
        return int(self.call(method, params), 16)

    def code_hash(self, address: str):
        """None when the address has no code, else the Keccak-256 of its code."""
        code = self.call("eth_getCode", [address, "latest"])
        return None if code in ("0x", "0x0") else "0x" + keccak256(hexbytes(code)).hex()

    def wait_receipt(self, tx_hash: str, seconds: int) -> dict:
        end = time.time() + seconds
        while time.time() < end:
            r = self.call("eth_getTransactionReceipt", [tx_hash])
            if r:
                return r
            time.sleep(1)
        raise Stop(f"transaction {tx_hash} is not in a block after {seconds} seconds; run this again once it is (until then a run refuses to send, so nothing is funded twice)")


def refuses_unprotected(err: Exception) -> bool:
    """True when a node's refusal of a transaction says it wants the transaction tied to a chain."""
    text = str(err)
    return "not tied to a chain" in text or "EIP-155" in text or "replay" in text.lower()


UNPROTECTED_HINT = "This node refuses transactions that are not tied to a chain. Send the presigned ones to the chain's own reth RPC."


def read_key(path: str):
    p = Path(path)
    try:
        st = p.stat()
    except OSError as e:
        raise Stop(f"cannot read the funding key file: {e.strerror}")
    if st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise Stop(f"the funding key file {path} has permissions for the group or others: chmod 600 it (0600 or 0400 work)")
    text = p.read_text().strip().removeprefix("0x")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", text):
        raise Stop(f"the funding key file {path} does not hold one key as 64 hex digits")
    from eth_account import Account
    return Account.from_key("0x" + text)


def fees(node: Node) -> tuple:
    """(maxFeePerGas, maxPriorityFeePerGas) for a transaction of the funding account: twice the newest block's base fee plus the node's tip."""
    base = int(node.call("eth_getBlockByNumber", ["latest", False]).get("baseFeePerGas") or "0x0", 16)
    try:
        tip = node.number("eth_maxPriorityFeePerGas", [])
    except Stop:
        tip = GWEI
    return 2 * base + tip, tip


def send_from_funding(node: Node, account, chain_id: int, to: str, value: int, data: bytes, gas: int, wait: int) -> dict:
    max_fee, tip = fees(node)
    tx = {"type": 2, "chainId": chain_id, "nonce": node.number("eth_getTransactionCount", [account.address, "pending"]), "to": to, "value": value,
          "gas": gas, "maxFeePerGas": max_fee, "maxPriorityFeePerGas": tip, "data": "0x" + data.hex()}
    raw = account.sign_transaction(tx).raw_transaction
    h = node.call("eth_sendRawTransaction", ["0x" + raw.hex()])
    receipt = node.wait_receipt(h, wait)
    if receipt.get("status") != "0x1":
        raise Stop(f"the transaction {h} failed (status {receipt.get('status')})")
    return receipt


# ---- the plan

def survey(node: Node, entries: list, chain_id: int) -> list:
    """One dict per entry: the canonical hash for this chain, what the address holds, and for a presigned one the signer's nonce and balance."""
    out = []
    for e in entries:
        s = {"entry": e, "expected": expected_hash(e, chain_id), "have": node.code_hash(e["address"])}
        if e["how"] == "presigned":
            s["signerNonce"] = node.number("eth_getTransactionCount", [e["signer"], "latest"])
            s["signerPending"] = node.number("eth_getTransactionCount", [e["signer"], "pending"])
            s["signerBalance"] = node.number("eth_getBalance", [e["signer"], "latest"])
            s["need"] = e["gasLimit"] * e["gasPrice"]
        out.append(s)
    return out


def refusals(states: list) -> list:
    out = []
    for s in states:
        e = s["entry"]
        if s["have"] is not None and s["have"] != s["expected"]:
            out.append(f"{e['name']}: {e['address']} has code with hash {s['have']}, not the canonical {s['expected']}: this address cannot be used on this chain")
        elif s["have"] is None and e["how"] == "presigned":
            if s["signerNonce"] > 0:
                out.append(f"{e['name']}: {e['address']} has no code, and its signer {e['signer']} has sent {s['signerNonce']} transaction(s): its one deployment "
                           f"transaction cannot be mined again, so the address cannot be deployed on this chain")
            elif s["signerPending"] > 0:
                out.append(f"{e['name']}: a transaction of its signer {e['signer']} is waiting in the node's pool: let it be mined, then run this again")
    return out


def run(args) -> int:
    entries = load_data()
    by_name = {e["name"]: e for e in entries}
    wanted = [n for n in args.only.split(",")] if args.only else [e["name"] for e in entries]
    unknown = [n for n in wanted if n not in by_name]
    if unknown:
        raise Stop(f"--only names a contract that is not here: {', '.join(unknown)} (they are: {', '.join(by_name)})")
    chosen = [e for e in entries if e["name"] in wanted]
    node = Node(args.rpc)
    chain_id = node.number("eth_chainId", [])
    account = read_key(args.funding_key_file)
    print(f"chain {chain_id}; funding account {account.address}")
    # Permit2 is deployed through the CREATE2 deployer, so the deployer is looked at too, and has to be there or be part of this run.
    states = survey(node, entries if args.only is None else [e for e in entries if e["name"] in wanted or e["name"] in {c.get("via") for c in chosen}], chain_id)
    problems = refusals(states)
    for s in states:
        e = s["entry"]
        if e["how"] == "create2" and s["have"] is None:
            via = next(x for x in states if x["entry"]["name"] == e["via"])
            if via["have"] is None and e["via"] not in wanted:
                problems.append(f"{e['name']}: the CREATE2 deployer {via['entry']['address']} is not on this chain and is not part of this run")
    if problems:
        for p in problems:
            print("REFUSED " + p, file=sys.stderr)
        print("nothing was sent", file=sys.stderr)
        return 1

    todo = [s for s in states if s["entry"]["name"] in wanted and s["have"] is None]
    if todo:
        latest, pending = (node.number("eth_getTransactionCount", [account.address, tag]) for tag in ("latest", "pending"))
        if pending > latest:
            print(f"REFUSED the funding account {account.address} has {pending - latest} transaction(s) waiting in the node's pool: a transfer of an earlier run "
                  f"may be among them, and a new run would fund a signer twice. Let them be mined, then run this again", file=sys.stderr)
            print("nothing was sent", file=sys.stderr)
            return 1
    max_fee, _ = fees(node)
    shortfalls = {s["entry"]["name"]: max(0, s["need"] - s["signerBalance"]) for s in todo if s["entry"]["how"] == "presigned"}
    create2_gas = CREATE2_FALLBACK_GAS
    for s in todo:
        if s["entry"]["how"] == "create2":
            e = s["entry"]
            via = next(x for x in states if x["entry"]["name"] == e["via"])
            if via["have"] is not None:
                data = "0x" + (hexbytes(e["salt"]) + hexbytes(e["initCode"])).hex()
                create2_gas = node.number("eth_estimateGas", [{"from": account.address, "to": via["entry"]["address"], "data": data}]) * 12 // 10
    cost = sum(shortfalls.values()) + (len(shortfalls) * FUNDING_TX_GAS + sum(create2_gas for s in todo if s["entry"]["how"] == "create2")) * max_fee
    balance = node.number("eth_getBalance", [account.address, "latest"])
    for s in states:
        e = s["entry"]
        if s["have"] is not None:
            print(f"{e['name']}: {e['address']} is in place (code hash {s['have']})")
    if not todo:
        print("nothing to send")
        return 0
    for s in todo:
        e = s["entry"]
        if e["how"] == "presigned":
            short = shortfalls[e["name"]]
            print(f"{e['name']}: {e['address']} has no code: " + (f"fund {e['signer']} with {short} wei (gas limit {e['gasLimit']} x {e['gasPrice']} wei, it holds {s['signerBalance']})" if short else f"{e['signer']} holds enough already")
                  + ", then send the presigned transaction")
        else:
            print(f"{e['name']}: {e['address']} has no code: send the deployment to the CREATE2 deployer with salt {e['salt']} (gas limit {create2_gas})")
        if e["name"] == "multicall3":
            print("  note: Multicall3's signer key is reported compromised by the Multicall3 project; between the funding and the deployment someone holding it can deploy other code at the address. The hash is checked after, and a mismatch is reported.")
    print(f"the funding account needs about {cost} wei for this and holds {balance}")
    if balance < cost:
        print(f"REFUSED the funding account is short by {cost - balance} wei", file=sys.stderr)
        return 1
    if args.dry_run:
        print("dry run: nothing was sent")
        return 0

    # Before any signer is funded, send the first presigned transaction that needs funding as a probe. A signer that holds too little makes the node
    # answer "insufficient funds" and keep nothing, so the probe costs nothing; a node that wants a transaction tied to a chain says so, and the run stops
    # before it has funded anyone. (A probe that is taken, because the signer was funded in the meantime, is that transaction: it is waited for below.)
    probed = {}
    first = next((s["entry"] for s in todo if s["entry"]["how"] == "presigned" and shortfalls[s["entry"]["name"]]), None)
    if first is not None:
        try:
            probed[first["name"]] = node.call("eth_sendRawTransaction", [first["presignedTx"]])
        except Stop as err:
            if refuses_unprotected(err):
                raise Stop(f"{err}\n  {UNPROTECTED_HINT} Nothing was funded.")

    for s in states:
        e = s["entry"]
        if e["name"] not in wanted or s["have"] is not None:
            continue
        if e["how"] == "presigned":
            short = shortfalls[e["name"]]
            h = probed.pop(e["name"], None)
            if short and h is None:
                receipt = send_from_funding(node, account, chain_id, e["signer"], short, b"", FUNDING_TX_GAS, args.wait_seconds)
                print(f"{e['name']}: funded {e['signer']} with {short} wei in block {int(receipt['blockNumber'], 16)}")
            if node.code_hash(e["address"]) is None and node.number("eth_getTransactionCount", [e["signer"], "latest"]) > 0:
                raise Stop(f"{e['name']}: the signer {e['signer']} sent a transaction before this run's: its nonce is used and {e['address']} has no code from this run")
            receipt = None
            try:
                if h is None:
                    h = node.call("eth_sendRawTransaction", [e["presignedTx"]])
                receipt = node.wait_receipt(h, args.wait_seconds)
            except Stop as err:
                if refuses_unprotected(err):
                    raise Stop(f"{err}\n  {UNPROTECTED_HINT}")
                # The node did not take the transaction (or it is not mined): say what is at the address now, which is the cause when someone got there first.
                have = node.code_hash(e["address"])
                if have is not None and have != s["expected"]:
                    raise Stop(f"{err}\n  {e['name']}: {e['address']} now has code with hash {have}, not the canonical {s['expected']}: other code was deployed there "
                               f"first (the signer's key is not secret), so this address cannot be used on this chain. The signer {e['signer']} was funded in this run")
                if have is None:
                    raise
                print(f"{e['name']}: the node did not take the presigned transaction ({err}), but the canonical code is at {e['address']} now")
            if receipt is not None:
                print(f"{e['name']}: presigned transaction {h} in block {int(receipt['blockNumber'], 16)}, status {receipt.get('status')}, gas used {int(receipt['gasUsed'], 16)}")
                if receipt.get("status") != "0x1":
                    raise Stop(f"{e['name']}: the presigned transaction failed: its signer's nonce is used now, so {e['address']} cannot be deployed on this chain")
        else:
            via = by_name[e["via"]]
            receipt = send_from_funding(node, account, chain_id, via["address"], 0, hexbytes(e["salt"]) + hexbytes(e["initCode"]), create2_gas, args.wait_seconds)
            print(f"{e['name']}: deployment through {via['name']} in block {int(receipt['blockNumber'], 16)}, gas used {int(receipt['gasUsed'], 16)}")
        have = node.code_hash(e["address"])
        if have != s["expected"]:
            raise Stop(f"{e['name']}: after the deployment the code at {e['address']} has hash {have}, not the canonical {s['expected']}")
        print(f"{e['name']}: {e['address']} verified (code hash {have})")
    print("ok")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Deploys the standard contracts at their canonical addresses (see the top of this file).")
    ap.add_argument("--rpc", required=True, help="JSON-RPC URL of the chain; the presigned transactions are sent here")
    ap.add_argument("--funding-key-file", required=True, help="file with the funding account's key as hex; any group or other permission on it is refused (0600 or 0400 work)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan and send nothing")
    ap.add_argument("--only", help="comma-separated names to deploy (default: all): create2-deployer, multicall3, createx, permit2")
    ap.add_argument("--wait-seconds", type=int, default=300, help="how long to wait for each transaction to be in a block (default 300)")
    args = ap.parse_args(argv)
    try:
        return run(args)
    except Stop as e:
        print(f"FAIL: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
