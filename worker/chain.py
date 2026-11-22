"""JSON-RPC to an EVM chain, a hot key, and the one way the worker sends a transaction: one at a time, found again after a restart, and replaced when it sticks.

An endpoint's URL can carry a key, so it is only ever held in memory: no message, log line or record here names a URL, and a failure is described by the call that failed and the kind of error.
"""
import json, os, re, stat, time, urllib.request
from pathlib import Path

from eth_abi import decode, encode
from eth_account import Account
from eth_utils import keccak, to_checksum_address

USER_AGENT = "Rome Protocol rome@romeprotocol.com"
URL = re.compile(r"https://[^/\s]+(/\S*)?|http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/\S*)?")   # a key must not cross a network in the clear


class ChainError(Exception):
    pass


class Refused(ChainError):
    """The node answered with an error: unlike a timeout, it is certain that the call had no effect."""


def selector(signature: str) -> bytes:
    return keccak(text=signature)[:4]


def call_data(signature: str, types: list, values: list) -> str:
    return "0x" + (selector(signature) + encode(types, values)).hex()


class Rpc:
    def __init__(self, label: str, url: str, timeout: int = 30):
        if not URL.fullmatch(url or ""):
            raise SystemExit(f"the {label} endpoint must be https, or http on this machine")
        self.label, self._url, self.timeout, self._chain_id = label, url, timeout, None

    def call(self, method: str, params: list):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        request = urllib.request.Request(self._url, body, {"content-type": "application/json", "user-agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as r:
                reply = json.loads(r.read(8 * 1024 * 1024))
        except (OSError, ValueError) as e:   # urllib's own text can name the URL: say only the kind
            raise ChainError(f"{self.label}: {method} failed ({type(e).__name__})") from None
        if not isinstance(reply, dict) or "error" in reply:
            raise Refused(f"{self.label}: {method} was refused: {str((reply.get('error') if isinstance(reply, dict) else reply))[:200]}")
        return reply.get("result")

    def view(self, to: str, signature: str, types: list, values: list, out: list, block: str = "latest"):
        """An eth_call, decoded; a revert is a ChainError."""
        raw = self.call("eth_call", [{"to": to, "data": call_data(signature, types, values)}, block])
        if not isinstance(raw, str) or not re.fullmatch(r"0x([0-9a-f]{2})*", raw):
            raise ChainError(f"{self.label}: {signature.split('(')[0]} gave an answer that is not hex")
        try:
            return decode(out, bytes.fromhex(raw[2:]))
        except Exception:
            raise ChainError(f"{self.label}: {signature.split('(')[0]} gave an answer that does not fit {out}") from None

    def number(self, method: str, params: list = ()) -> int:
        return int(self.call(method, list(params)), 16)

    def chain_id(self) -> int:
        self._chain_id = self._chain_id or self.number("eth_chainId")
        return self._chain_id

    def finalized(self) -> int:
        block = self.call("eth_getBlockByNumber", ["finalized", False])
        if not block:
            raise ChainError(f"{self.label}: no finalized block")
        return int(block["number"], 16)


def expect_chain(rpc: Rpc, wanted: int) -> None:
    """Exits unless the endpoint is the chain it should be: another network with a contract at the same address would get transactions that never land."""
    try:
        found = rpc.chain_id()
    except (ChainError, TypeError, ValueError) as e:
        raise SystemExit(f"the {rpc.label} endpoint cannot be asked for its chain id ({type(e).__name__})") from None
    if found != wanted:
        raise SystemExit(f"the {rpc.label} endpoint is chain {found}, not {wanted}")


def load_signer(path: str) -> "Account":
    """The hot key in a file that only its owner can read (one hex key). The error names the file and what is wrong, never the key."""
    try:
        if os.stat(path).st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            raise SystemExit(f"the key file {path} can be read by others: chmod 600 it")
        text = Path(path).read_text().strip()
    except OSError as e:
        raise SystemExit(f"cannot read the key file {path}: {e.strerror}") from None
    if not re.fullmatch(r"(0x)?[0-9a-fA-F]{64}", text):
        raise SystemExit(f"the key file {path} must hold one 32-byte hex key and nothing else")
    return Account.from_key("0x" + text.removeprefix("0x"))


def send(rpc: Rpc, signer, to: str, data: str, limits: dict, nonce: int = None, fees: tuple = None, gas: int = None, record=None) -> dict:
    """Signs and sends one transaction; returns what the record keeps to find it again (tx, nonce, fees, time). The gas is the estimate plus a third and must stay under
    limits['gas']; the fee per gas must stay under limits['gas_price']. With `record`, it is called with that dict BEFORE the transaction goes out, so a call that times out after the
    node took the transaction, or a crash in that window, still leaves a record that finds it again; if the node refuses the transaction, `record(None)` is called (it never was out)."""
    price = rpc.number("eth_gasPrice")
    max_fee, tip = fees or (2 * price, min(price, 10**9))
    if max_fee > limits["gas_price"]:
        raise ChainError(f"{rpc.label}: the gas price is over the limit")
    if gas is None:
        gas = rpc.number("eth_estimateGas", [{"from": signer.address, "to": to, "data": data}]) * 4 // 3
    if gas > limits["gas"]:
        raise ChainError(f"{rpc.label}: the gas needed is over the limit")
    nonce = rpc.number("eth_getTransactionCount", [signer.address, "latest"]) if nonce is None else nonce
    tx = {"type": 2, "chainId": rpc.chain_id(), "nonce": nonce, "to": to_checksum_address(to), "value": 0, "data": data, "gas": gas, "maxFeePerGas": max_fee, "maxPriorityFeePerGas": tip}
    raw = signer.sign_transaction(tx).raw_transaction
    sent = {"tx": "0x" + keccak(raw).hex(), "nonce": nonce, "fees": [max_fee, tip], "at": int(time.time())}
    if record:
        record(sent)
    try:
        rpc.call("eth_sendRawTransaction", ["0x" + raw.hex()])
    except Refused as e:
        if record and "already known" not in str(e):
            record(None)
        raise
    return sent


def settle(rpc: Rpc, signer, sent: dict, limits: dict, wait: int, final: bool) -> tuple:
    """Where a sent transaction is: ("done" | "failed", receipt), ("waiting", None), or ("replaced", None) when `wait` seconds have passed with no receipt: its nonce then goes
    to a transfer of nothing to the signer at twice the fees, so a transaction that sticks (the builder leaves some out) cannot hold the later ones. With `final` a receipt counts
    only in a block at or under the chain's finalized block (a block that is not final can still be unwound)."""
    receipt = rpc.call("eth_getTransactionReceipt", [sent["tx"]])
    if receipt and (not final or int(receipt["blockNumber"], 16) <= rpc.finalized()):
        return ("done" if receipt.get("status") == "0x1" else "failed"), receipt
    if receipt or time.time() - sent["at"] < wait:
        return "waiting", None
    if rpc.number("eth_getTransactionCount", [signer.address, "latest"]) <= sent["nonce"]:
        # twice the fees, but never over the gas price limit; the pool wants at least a tenth more than the transaction it replaces
        top, tip = min(2 * sent["fees"][0], limits["gas_price"]), 2 * sent["fees"][1]
        if top * 10 >= sent["fees"][0] * 11:
            send(rpc, signer, signer.address, "0x", limits, sent["nonce"], (top, min(tip, top)), 21000)
        elif rpc.call("eth_getTransactionByHash", [sent["tx"]]):
            raise ChainError(f"{rpc.label}: a transaction is stuck and a replacement would pass the gas price limit: waiting for it")
    return "replaced", None
