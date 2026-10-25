#!/usr/bin/env python3
"""The EVM side of the demo: the keys, the funded genesis, and the transactions U and V send. See demo/README.md.

  evm.py keys                      make V's and U's keys (kept in $CZE_STATE_DIR/demo/v.key and u.key, mode 0600, never printed);
                                   print both addresses
  evm.py genesis                   write $CZE_STATE_DIR/demo/genesis.json: network/genesis.json plus 10 ether for each of V and U
  evm.py deploy                    V deploys TKA, which gives its whole supply (1,000 TKA) to V; print the transaction hash
  evm.py transfer <token> <amount> V sends U <amount> TKA (a whole number) from the token at that address; print the transaction hash
  evm.py give <u|v> <token> <to> <amount>
                                   the sender sends <amount> (a whole number) of the token at that address to <to>, an address: the token's own
                                   transfer. The live cycle uses it to send the WtROME of a payment back to V; print the transaction hash
  evm.py register <u|v> <name> <symbol>
                                   the gateway makes a wrapped token; print the transaction hash and the address the token will have
                                   (register one token at a time: the address is worked out from the gateway's state when the transaction is sent)
  evm.py claim <u|v> <deposit id> <token> <amount>
                                   the sender claims a deposit: the gateway mints <amount> of the wrapped token to it. The amount is in
                                   whole wrapped tokens, with up to 10 decimals; the id is the deposit request's, 64 lowercase hex digits
  evm.py withdraw <u|v> <token> <amount> <party>
                                   the sender burns <amount> of the wrapped token; the Canton token goes to <party> (its full id)
  evm.py approve <u|v> <token> <spender> <amount>
                                   the sender lets <spender> (an address, or the word gateway) take <amount> TKA (a whole number, 0 or more)
  evm.py pay <u|v> <payment id> <token> <to> <amount>
                                   the sender pays <to> <amount> TKA (a whole number) through the gateway, against the payment with that
                                   id (64 lowercase hex digits). The sender must have approved the gateway for it first
  evm.py wrap <u|v> <token> <amount>
                                   the sender wraps <amount> of the chain's coin (a whole number) into WtROME, the wrapped coin at <token>:
                                   a send of that much with deposit(), which mints as many WtROME to the sender. Then WtROME can be paid
                                   through the gateway (approve, then pay) as TKA is
  evm.py receipt <tx hash>         print the transaction's block number, block hash, gas used, and the contract it made
  evm.py wait <tx hash> [seconds]  wait (600 seconds if none are given) until the transaction is in a block that is the chain's finalized
                                   block or lies below it, which is a block Canton has committed, and the block at that number is the
                                   one the receipt names. Print what `receipt` prints. The blocks are made by a producer that is running
  evm.py legs <block number>       how many of the block's transactions are calls of the gateway that can make a leg (claim, pay,
                                   withdraw), and which
  evm.py block <latest|finalized|number>
                                   print that block's number, hash and gas used
  evm.py ether <address>           print the address's balance of the chain's coin, in wei and in whole coins
  evm.py code <address>            print the size and the Keccak-256 of the code at the address (latest block)
  evm.py chain                     print the chain id
  evm.py balance <token> <holder> [block]
                                   print the holder's TKA balance in whole tokens (eth_call balanceOf)
  evm.py wrapped <token> <holder> [block]
                                   print the holder's balance of a wrapped token and its supply, as Canton writes amounts ("10.0")
  evm.py describe <token> [block]  print a wrapped token's name() and symbol(); both are null where there is no code at the address; an error from the chain stops the command

[block] is latest (the default) or finalized: the block Canton has committed. Balances should be read at finalized.
The transactions go to the chain's JSON-RPC: CZE_RPC_URL, or reth's HTTP port on this machine (RETH_HTTP_PORT, default 8545). They wait in
its pool until the builder takes them into a block. On a chain that is already running, V's and U's keys are the ones in
$CZE_STATE_DIR/demo (`keys` makes them without any genesis; the chain's coin for their fees has to be sent to the addresses it prints).
Needs the packages in demo/requirements.txt. Prints one JSON object per command.
"""
import json, os, re, sys, time, urllib.request
from pathlib import Path

from eth_abi import decode, encode
from eth_account import Account
from eth_utils import keccak, to_checksum_address

ROOT = Path(__file__).resolve().parent.parent
ONE = 10**18
SUPPLY = 1000 * ONE
DEPLOY_GAS = 1_200_000
TRANSFER_GAS = 100_000
MAX_FEE = 10 * 10**9
PRIORITY_FEE = 10**9
FUNDED = 10 * ONE   # each of V and U in the genesis
WRAPPED_DECIMALS = 10
REGISTER_GAS = 2_000_000
GATEWAY_GAS = 300_000
PAY_GAS = 400_000
APPROVE_GAS = 100_000
WRAP_GAS = 150_000
LEG_CALLS = {"claim(bytes32,address,uint256)": "claim", "pay(bytes32,address,address,uint256)": "pay", "withdraw(address,uint256,string)": "withdraw"}
WAIT_SECONDS = 600
SELECTOR_DEPOSIT = "d0e30db0"   # deposit(): WtROME mints as much as it is sent
SELECTOR_TRANSFER = "a9059cbb"
SELECTOR_BALANCE_OF = "70a08231"
SELECTOR_TOTAL_SUPPLY = "18160ddd"
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
ID = re.compile(r"[0-9a-f]{64}")
WHOLE = re.compile(r"[0-9]+")
WRAPPED_AMOUNT = re.compile(r"([0-9]+)(?:\.([0-9]{1,10}))?")   # all of these are matched whole (fullmatch)


def state_dir() -> Path:
    return Path(os.environ.get("CZE_STATE_DIR", ROOT / "state")) / "demo"


def pad32(address: str) -> str:
    return address.lower().removeprefix("0x").rjust(64, "0")


def make_keys(folder: Path) -> dict:
    """V's and U's keys go to v.key and u.key (created exclusively, mode 0600) and are never returned or printed. Re-running keeps them."""
    folder.mkdir(parents=True, exist_ok=True)
    names = ("v.key", "u.key", "addresses.json")
    present = [(folder / n).exists() for n in names]
    if any(present) and not all(present):
        raise SystemExit(f"{folder} has only some of {', '.join(names)}: remove them all to start again")
    if not any(present):
        accounts = {who: Account.create() for who in ("v", "u")}
        for who, account in accounts.items():
            fd = os.open(folder / f"{who}.key", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(account.key.hex().removeprefix("0x"))
        (folder / "addresses.json").write_text(json.dumps({who: a.address for who, a in accounts.items()}))
    return json.loads((folder / "addresses.json").read_text())


def funded_genesis(base: dict, addresses: list) -> dict:
    genesis = json.loads(json.dumps(base))
    for address in addresses:
        genesis["alloc"][address.lower().removeprefix("0x")] = {"balance": hex(FUNDED)}
    return genesis


def load_key(folder: Path, who: str) -> str:
    return "0x" + (folder / f"{who}.key").read_text().strip()


def rpc_url() -> str:
    return os.environ.get("CZE_RPC_URL") or f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', 8545)}"


def rpc(method: str, params: list):
    url = rpc_url()
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    with urllib.request.urlopen(urllib.request.Request(url, body, {"content-type": "application/json"}), timeout=60) as r:
        reply = json.load(r)
    if "error" in reply:
        raise SystemExit(f"{method} failed: {reply['error']}")
    return reply["result"]


def send(folder: Path, who: str, to: str | None, data: str, gas: int, value: int = 0) -> str:
    """U or V signs a type-2 transaction and sends it to reth's pool. The key is read from its file and used here only."""
    make_keys(folder)
    account = Account.from_key(load_key(folder, who))
    tx = {"type": 2, "chainId": int(rpc("eth_chainId", []), 16), "nonce": int(rpc("eth_getTransactionCount", [account.address, "pending"]), 16),
          "value": value, "gas": gas, "maxFeePerGas": MAX_FEE, "maxPriorityFeePerGas": PRIORITY_FEE, "data": "0x" + data}
    if to:
        tx["to"] = to_checksum_address(to)
    raw = account.sign_transaction(tx).raw_transaction.hex().removeprefix("0x")
    return rpc("eth_sendRawTransaction", ["0x" + raw])


def deploy_data(v_address: str) -> str:
    code = (ROOT / "demo" / "TKA.bin").read_text().strip()
    return code + pad32(v_address) + f"{SUPPLY:064x}"


def transfer_data(to: str, whole_tokens: int) -> str:
    return SELECTOR_TRANSFER + pad32(to) + f"{whole_tokens * ONE:064x}"


def call_data(signature: str, values: list) -> str:
    """The selector of a function and its arguments, as the ABI writes them (hex without 0x)."""
    types = signature[signature.index("(") + 1:-1].split(",")
    return keccak(text=signature)[:4].hex() + encode(types, values).hex()


def gateway_address() -> str:
    pins = dict(line.split("=", 1) for line in (ROOT / "PINS").read_text().splitlines() if "=" in line and not line.startswith("#"))
    return pins["GATEWAY_ADDRESS"]


def who_sends(word: str) -> str:
    if word not in ("u", "v"):
        raise SystemExit(f"the sender must be u or v, not {word!r}")
    return word


def address_of(value: str, what: str) -> str:
    if not ADDRESS.fullmatch(value):
        raise SystemExit(f"{what} must be an address: 0x and 40 hex digits, not {value!r}")
    return to_checksum_address(value)


def id_of(value: str) -> bytes:
    if not ID.fullmatch(value):
        raise SystemExit(f"the id must be 64 lowercase hex digits, not {value!r}")
    return bytes.fromhex(value)


def whole(value: str, what: str, least: int = 1) -> int:
    if not WHOLE.fullmatch(value) or int(value) < least:
        raise SystemExit(f"{what} must be a whole number of at least {least}, not {value!r}")
    return int(value)


def wrapped_units(text: str) -> int:
    """A wrapped token's amount as Canton writes it ("10", "0.5") in base units: 10 decimals, exactly, and more than zero."""
    m = WRAPPED_AMOUNT.fullmatch(text)
    units = int(m.group(1)) * 10**WRAPPED_DECIMALS + int((m.group(2) or "").ljust(WRAPPED_DECIMALS, "0")) if m else 0
    if units == 0:
        raise SystemExit(f"a wrapped amount must be more than zero, with at most {WRAPPED_DECIMALS} decimals, not {text!r}")
    return units


def wrapped_text(units: int) -> str:
    """Base units as Canton writes an amount: at least one decimal, no trailing zeros after that ("10.0", "0.0000000001")."""
    whole_part, fraction = divmod(units, 10**WRAPPED_DECIMALS)
    return f"{whole_part}.{f'{fraction:0{WRAPPED_DECIMALS}d}'.rstrip('0') or '0'}"


def block_tag(argv: list) -> str:
    tag = argv[0] if argv else "latest"
    if tag not in ("latest", "finalized"):
        raise SystemExit(f"the block must be latest or finalized, not {tag!r}")
    return tag


def read_word(token: str, data: str, tag: str) -> int:
    return int(rpc("eth_call", [{"to": token, "data": "0x" + data}, tag]), 16)


def receipt_of(tx: str) -> dict:
    r = rpc("eth_getTransactionReceipt", [tx])
    if r is None:
        raise SystemExit(f"no receipt for {tx}: the transaction is not in a block yet")
    return {"block": int(r["blockNumber"], 16), "blockHash": r["blockHash"], "gasUsed": int(r["gasUsed"], 16),
            "status": int(r["status"], 16), "contract": r.get("contractAddress")}


def wait_finalized(tx: str, seconds: int) -> dict:
    """Until the transaction's block is final: reth's finalized block is that block or a later one, and the block at that number has the hash the
    receipt names. A block Canton refuses is taken back by reth, and the transaction may come again in another block, so the receipt is read
    again each time round."""
    deadline = time.time() + seconds
    while True:
        r = rpc("eth_getTransactionReceipt", [tx])
        if r is not None:
            number, finalized = int(r["blockNumber"], 16), rpc("eth_getBlockByNumber", ["finalized", False])
            if finalized and int(finalized["number"], 16) >= number:
                there = rpc("eth_getBlockByNumber", [hex(number), False])
                if there and there["hash"] == r["blockHash"]:
                    return receipt_of(tx)
        if time.time() > deadline:
            raise SystemExit(f"{tx} is not in a finalized block after {seconds} seconds" + (f" (it is in block {int(r['blockNumber'], 16)})" if r is not None else " (it is in no block)"))
        time.sleep(float(os.environ.get("CZE_POLL_SECONDS", "1")))


def legs_in(number: int) -> dict:
    """The transactions of a block that call the gateway's claim, pay or withdraw: each can make a leg. Their number is what the leg count of the block is."""
    block = rpc("eth_getBlockByNumber", [hex(number), True])
    if block is None:
        raise SystemExit(f"no block {number}")
    gateway = gateway_address().lower()
    selectors = {keccak(text=signature)[:4].hex(): name for signature, name in LEG_CALLS.items()}
    kinds = [selectors[t["input"][2:10]] for t in block["transactions"] if (t.get("to") or "").lower() == gateway and t["input"][2:10] in selectors]
    return {"block": number, "legs": len(kinds), "kinds": kinds}


def read_text(token: str, signature: str, tag: str) -> str | None:
    """A string that a view function of the contract returns, or None where the call gives an empty answer (no code at that address). An error
    from the chain, or an answer that is not a string, ends the command: a failed read is not the same as no token."""
    answer = rpc("eth_call", [{"to": token, "data": "0x" + keccak(text=signature)[:4].hex()}, tag])
    if answer == "0x":
        return None
    try:
        return decode(["string"], bytes.fromhex(answer[2:]))[0]
    except Exception as error:
        raise SystemExit(f"{signature} at {token} gave an answer that is not a string: {answer!r} ({error})")


def balance(token: str, holder: str, tag: str = "latest") -> int:
    return read_word(token, SELECTOR_BALANCE_OF + pad32(holder), tag) // ONE


def main(argv: list) -> dict:
    folder = state_dir()
    n, cmd = len(argv), argv[:1]
    if cmd == ["keys"] and n == 1:
        return make_keys(folder)
    if cmd == ["genesis"] and n == 1:
        addresses = make_keys(folder)
        out = folder / "genesis.json"
        funded = [addresses["v"], addresses["u"]]
        out.write_text(json.dumps(funded_genesis(json.loads((ROOT / "network" / "genesis.json").read_text()), funded), indent=2))
        os.chmod(out, 0o644)   # reth's container user has to read it
        return {"genesis": str(out), "funded": funded}
    if cmd == ["deploy"] and n == 1:
        v = make_keys(folder)["v"]
        return {"tx": send(folder, "v", None, deploy_data(v), DEPLOY_GAS), "supplyTo": v, "supply": 1000}
    if cmd == ["transfer"] and n == 3 and WHOLE.fullmatch(argv[2]) and int(argv[2]) > 0:
        return {"tx": send(folder, "v", argv[1], transfer_data(make_keys(folder)["u"], int(argv[2])), TRANSFER_GAS)}
    if cmd == ["give"] and n == 5:
        return {"tx": send(folder, who_sends(argv[1]), address_of(argv[2], "the token"), transfer_data(address_of(argv[3], "the receiver"), whole(argv[4], "the amount")), TRANSFER_GAS)}
    if cmd == ["register"] and n == 4 and argv[2] and argv[3]:
        who, address = who_sends(argv[1]), make_keys(folder)[argv[1]]
        data = call_data("register(string,string)", [argv[2], argv[3]])
        # What the gateway would make now, asked of reth before the transaction goes in: the address of the wrapped token.
        made = rpc("eth_call", [{"from": address, "to": gateway_address(), "data": "0x" + data}, "latest"])
        return {"tx": send(folder, who, gateway_address(), data, REGISTER_GAS), "token": "0x" + made[-40:]}
    if cmd == ["claim"] and n == 5:
        data = call_data("claim(bytes32,address,uint256)", [id_of(argv[2]), address_of(argv[3], "the token"), wrapped_units(argv[4])])
        return {"tx": send(folder, who_sends(argv[1]), gateway_address(), data, GATEWAY_GAS)}
    if cmd == ["withdraw"] and n == 5 and argv[4]:
        data = call_data("withdraw(address,uint256,string)", [address_of(argv[2], "the token"), wrapped_units(argv[3]), argv[4]])
        return {"tx": send(folder, who_sends(argv[1]), gateway_address(), data, GATEWAY_GAS)}
    if cmd == ["approve"] and n == 5:
        spender = gateway_address() if argv[3] == "gateway" else address_of(argv[3], "the spender")
        data = call_data("approve(address,uint256)", [spender, whole(argv[4], "the amount", 0) * ONE])
        return {"tx": send(folder, who_sends(argv[1]), address_of(argv[2], "the token"), data, APPROVE_GAS)}
    if cmd == ["pay"] and n == 6:
        data = call_data("pay(bytes32,address,address,uint256)", [id_of(argv[2]), address_of(argv[3], "the token"), address_of(argv[4], "the payee"), whole(argv[5], "the amount") * ONE])
        return {"tx": send(folder, who_sends(argv[1]), gateway_address(), data, PAY_GAS)}
    if cmd == ["wrap"] and n == 4:
        return {"tx": send(folder, who_sends(argv[1]), address_of(argv[2], "the token"), SELECTOR_DEPOSIT, WRAP_GAS, whole(argv[3], "the amount") * ONE)}
    if cmd == ["receipt"] and n == 2:
        return receipt_of(argv[1])
    if cmd == ["wait"] and n in (2, 3):
        return {**wait_finalized(argv[1], whole(argv[2], "the seconds") if n == 3 else WAIT_SECONDS), "finalized": True}
    if cmd == ["legs"] and n == 2 and WHOLE.fullmatch(argv[1]):
        return legs_in(int(argv[1]))
    if cmd == ["block"] and n == 2:
        tag = argv[1] if argv[1] in ("latest", "finalized") else hex(whole(argv[1], "the block number", 0))
        b = rpc("eth_getBlockByNumber", [tag, False])
        if b is None:
            raise SystemExit(f"no block {argv[1]}")
        return {"number": int(b["number"], 16), "hash": b["hash"], "gasUsed": int(b["gasUsed"], 16)}
    if cmd == ["ether"] and n == 2:
        wei = int(rpc("eth_getBalance", [address_of(argv[1], "the address"), "latest"]), 16)
        return {"wei": wei, "ether": wei // ONE}
    if cmd == ["code"] and n == 2:
        code = bytes.fromhex(rpc("eth_getCode", [address_of(argv[1], "the address"), "latest"]).removeprefix("0x"))
        return {"size": len(code), "codeHash": "0x" + keccak(code).hex()}
    if cmd == ["chain"] and n == 1:
        return {"chainId": int(rpc("eth_chainId", []), 16)}
    if cmd == ["balance"] and n in (3, 4):
        return {"tka": balance(argv[1], argv[2], block_tag(argv[3:]))}
    if cmd == ["wrapped"] and n in (3, 4):
        tag = block_tag(argv[3:])
        return {"balance": wrapped_text(read_word(argv[1], SELECTOR_BALANCE_OF + pad32(argv[2]), tag)),
                "supply": wrapped_text(read_word(argv[1], SELECTOR_TOTAL_SUPPLY, tag))}
    if cmd == ["describe"] and n in (2, 3):
        token, tag = address_of(argv[1], "the token"), block_tag(argv[2:])
        return {"name": read_text(token, "name()", tag), "symbol": read_text(token, "symbol()", tag)}
    raise SystemExit(__doc__)


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1:])))
