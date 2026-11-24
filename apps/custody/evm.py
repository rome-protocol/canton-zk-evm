"""What the buy worker needs of Ethereum, with no dependency: a secp256k1 signature (deterministic, RFC 6979), an EIP-1559 transfer, and a small JSON-RPC client for reth.

The same key, nonce and fields always give the same bytes, so a send that is made again is the same transaction and lands once. See README.md ("The paid path").
"""
import hashlib, hmac, sys, urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "builder"))
from keccak import keccak256
import builder as b

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798, 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)
TRANSFER_GAS = 21000   # a plain value transfer to an account


def _add(a, c):
    if a is None:
        return c
    if c is None:
        return a
    if a[0] == c[0]:
        if (a[1] + c[1]) % P == 0:
            return None
        slope = 3 * a[0] * a[0] * pow(2 * a[1], -1, P) % P
    else:
        slope = (c[1] - a[1]) * pow(c[0] - a[0], -1, P) % P
    x = (slope * slope - a[0] - c[0]) % P
    return x, (slope * (a[0] - x) - a[1]) % P


def _mul(k: int, point):
    out = None
    while k:
        if k & 1:
            out = _add(out, point)
        point = _add(point, point)
        k >>= 1
    return out


def _key(private: bytes) -> int:
    d = int.from_bytes(private, "big")
    if len(private) != 32 or not 0 < d < N:
        raise ValueError("a private key is 32 bytes, more than zero and under the curve's order")
    return d


def address_of(private: bytes) -> str:
    """The 40 lowercase hex digits of the account that this key controls."""
    x, y = _mul(_key(private), G)
    return keccak256(x.to_bytes(32, "big") + y.to_bytes(32, "big"))[12:].hex()


def _nonce(d: int, digest: bytes):
    """The nonces of RFC 6979 (HMAC-SHA256), one after another."""
    v, k = b"\x01" * 32, b"\x00" * 32
    seed = d.to_bytes(32, "big") + digest
    k = hmac.new(k, v + b"\x00" + seed, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    k = hmac.new(k, v + b"\x01" + seed, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    while True:
        v = hmac.new(k, v, hashlib.sha256).digest()
        candidate = int.from_bytes(v, "big")
        if 0 < candidate < N:
            yield candidate
        k = hmac.new(k, v + b"\x00", hashlib.sha256).digest()
        v = hmac.new(k, v, hashlib.sha256).digest()


def sign(private: bytes, digest: bytes) -> tuple:
    """(r, s, recovery id 0 or 1) of the 32-byte digest, with the low s that Ethereum wants."""
    d, z = _key(private), int.from_bytes(digest, "big")
    for k in _nonce(d, digest):
        x, y = _mul(k, G)
        r = x % N
        if r == 0:
            continue
        s = pow(k, -1, N) * (z + r * d) % N
        if s == 0:
            continue
        recovery = (y & 1) | (2 if x >= N else 0)
        if s > N // 2:
            s, recovery = N - s, recovery ^ 1
        return r, s, recovery


def recover(digest: bytes, r: int, s: int, recovery: int) -> str:
    """The 40 hex digits of the account that signed the digest (used by the tests)."""
    x = r + (N if recovery & 2 else 0)
    y = pow((x ** 3 + 7) % P, (P + 1) // 4, P)
    if (y & 1) != (recovery & 1):
        y = P - y
    z, r_inv = int.from_bytes(digest, "big"), pow(r, -1, N)
    point = _mul(r_inv, _add(_mul(s, (x, y)), _mul((N - z) % N, G)))
    return keccak256(point[0].to_bytes(32, "big") + point[1].to_bytes(32, "big"))[12:].hex()


def rlp(item) -> bytes:
    """The RLP of bytes, an int (no leading zeros) or a list."""
    if isinstance(item, int):
        item = item.to_bytes((item.bit_length() + 7) // 8, "big")
    if isinstance(item, (bytes, bytearray)):
        item = bytes(item)
        return item if len(item) == 1 and item[0] < 0x80 else _head(len(item), 0x80) + item
    body = b"".join(rlp(i) for i in item)
    return _head(len(body), 0xC0) + body


def _head(size: int, base: int) -> bytes:
    if size < 56:
        return bytes([base + size])
    length = size.to_bytes((size.bit_length() + 7) // 8, "big")
    return bytes([base + 55 + len(length)]) + length


def transfer(private: bytes, chain_id: int, nonce: int, to: str, value: int, max_fee: int, tip: int, gas: int = TRANSFER_GAS) -> bytes:
    """A signed EIP-1559 transaction that sends `value` wei to `to` (40 hex digits): the bytes that eth_sendRawTransaction takes."""
    body = [chain_id, nonce, tip, max_fee, gas, bytes.fromhex(to), value, b"", []]
    r, s, recovery = sign(private, keccak256(b"\x02" + rlp(body)))
    return b"\x02" + rlp(body + [recovery & 1, r, s])


class Reth:
    """The few JSON-RPC calls the buy worker makes on reth. An answer that is not what the call returns is a RuntimeError that never carries the URL."""

    def __init__(self, url: str):
        self.url, self.n = url, 0

    def call(self, method: str, params: list):
        self.n += 1
        try:
            answer = b.post_json(self.url, {"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}, {"user-agent": "Rome Protocol rome@romeprotocol.com"}, timeout=30)
        except urllib.error.HTTPError as e:
            e.close()
            raise RuntimeError(f"reth answered HTTP {e.code} to {method}") from None
        except (OSError, ValueError):
            raise RuntimeError(f"reth cannot be reached for {method}") from None
        if not isinstance(answer, dict):
            raise RuntimeError(f"reth's answer to {method} is not an answer")
        if isinstance(answer.get("error"), dict):
            raise RpcError(method, answer["error"].get("code"), b.bounded_text(answer["error"].get("message", "")))
        return answer.get("result")

    def number(self, method: str, params: list) -> int:
        value = self.call(method, params)
        try:
            return int(value, 16)
        except (TypeError, ValueError):
            raise RuntimeError(f"reth's answer to {method} is not a number") from None

    def chain_id(self) -> int:
        return self.number("eth_chainId", [])

    def balance(self, address: str) -> int:
        return self.number("eth_getBalance", ["0x" + address, "latest"])

    def next_nonce(self, address: str) -> int:
        """The account's transaction count with what reth's pool holds."""
        return self.number("eth_getTransactionCount", ["0x" + address, "pending"])

    def gas_price(self) -> int:
        return self.number("eth_gasPrice", [])

    def tip(self) -> int:
        return self.number("eth_maxPriorityFeePerGas", [])

    def estimate_gas(self, sender: str, to: str, value: int) -> int:
        """The gas of a value transfer from `sender` to `to` (40 hex digits each). An RpcError when reth says it fails."""
        return self.number("eth_estimateGas", [{"from": "0x" + sender, "to": "0x" + to, "value": hex(value)}])

    def send(self, raw: bytes) -> str:
        return self.call("eth_sendRawTransaction", ["0x" + raw.hex()])

    def receipt(self, tx_hash: str):
        """The receipt (a dict) once the transaction is in a block, else None."""
        found = self.call("eth_getTransactionReceipt", [tx_hash])
        return found if isinstance(found, dict) else None

    def known(self, tx_hash: str) -> bool:
        """Whether reth holds the transaction, in a block or in its pool."""
        return isinstance(self.call("eth_getTransactionByHash", [tx_hash]), dict)


class RpcError(RuntimeError):
    def __init__(self, method: str, code, message: str):
        super().__init__(f"reth refused {method} ({code}): {message}")
        self.code, self.message = code, message
