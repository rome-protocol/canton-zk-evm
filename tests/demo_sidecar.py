#!/usr/bin/env python3
"""A stand-in for the sidecar, for the demo rehearsal only (tests/demo_rehearsal.sh). There is no GPU in CI, so there is no real
proof. This answers `verify` and `verify2` itself: the proof is accepted only if it is a stand-in proof the rehearsal's fake prover writes (832 fixed
bytes, then public values that commit to this block's hash, as a real proof's do), and then the rest of the answer is read from the header and the transaction list exactly as the real sidecar reads it. Every other
call, `legs` in particular, is passed to the REAL sidecar, which checks the gateway's storage proofs against the block's state root.
So the rehearsal runs everything but the zero-knowledge proof check.

Usage: demo_sidecar.py <port> <real sidecar port> <program-vk hex> <root-c hex> <the fixed first 832 bytes of the stand-in proof, hex>"""
import hashlib, http.server, os, re, sys, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "builder"))
from keccak import keccak256

port = real_port = program_vk = root_c = accepted = None   # set in main()


def item(b: bytes, i: int) -> tuple:
    """(payload start, end) of the RLP item at i."""
    p = b[i]
    if p < 0x80:
        return i, i + 1
    if p < 0xB8:
        return i + 1, i + 1 + p - 0x80
    if p < 0xC0:
        n = p - 0xB7
        return i + 1 + n, i + 1 + n + int.from_bytes(b[i + 1:i + 1 + n], "big")
    if p < 0xF8:
        return i + 1, i + 1 + p - 0xC0
    n = p - 0xF7
    return i + 1 + n, i + 1 + n + int.from_bytes(b[i + 1:i + 1 + n], "big")


def items(b: bytes) -> list:
    """The payloads of the items of an RLP list."""
    start, end = item(b, 0)
    out = []
    while start < end:
        s, e = item(b, start)
        out.append(b[s:e])
        start = e if b[start] >= 0x80 else start + 1
    return out


def committed_hash(public: bytes) -> str | None:
    """The block hash public values commit to: 64 slots of a 4-byte word and four zero bytes; the words are 0x20, the hash and zeros."""
    words = bytearray()
    for slot in range(64):
        chunk = public[slot * 8:slot * 8 + 8]
        if len(chunk) != 8 or any(chunk[4:]):
            return None
        words += chunk[:4]
    return None if words[0] != 0x20 or any(words[33:]) else bytes(words[1:33]).hex()


def verify(line: str) -> str:
    fields = line.split(",")
    if len(fields) != 3:
        return "no malformed input"
    proof, header_hex, txs_hex = fields
    header = bytes.fromhex(header_hex)
    if len(proof) != 2688 or not proof.startswith(accepted) or committed_hash(bytes.fromhex(proof[len(accepted):])) != keccak256(header).hex():
        return "no the proof does not verify"
    f = items(header)
    number, ts, gas_limit, gas_used = (int.from_bytes(f[i], "big") for i in (8, 11, 9, 10))
    tx_count = len(items(bytes.fromhex(txs_hex))) if txs_hex else 0
    return " ".join(["ok", program_vk, root_c, keccak256(header).hex(), f[0].hex(), str(number), f[3].hex(), str(ts), str(gas_limit), str(gas_used), str(tx_count)])


def length_prefixed(rest: str) -> tuple | None:
    """Takes one field off the front of `rest`: 10 decimal digits for its length (even), then the field. Returns (field, the rest)."""
    digits = rest[:10]
    if len(digits) != 10 or not re.fullmatch(r"[0-9]{10}", digits) or int(digits) % 2:
        return None
    n = int(digits)
    return None if len(rest) < 10 + n else (rest[10:10 + n], rest[10 + n:])


def verify2(line: str) -> str:
    """The same answer as `verify` for a line that is a 64-digit SHA-256 of what follows it, then two length-prefixed fields (proof, header)
    and the transactions as the rest. The hash is of the text as received, which Daml has lowercased; a mismatch is malformed input."""
    body = line[64:]
    if len(line) < 64 or hashlib.sha256(body.encode()).hexdigest() != line[:64]:
        return "no malformed input"
    first = length_prefixed(body)
    second = length_prefixed(first[1]) if first else None
    if not second:
        return "no malformed input"
    fields = [first[0], second[0], second[1]]
    if any(re.fullmatch(r"([0-9a-f]{2})*", f) is None for f in fields):
        return "no malformed input"
    return verify(",".join(fields))


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"   # keep-alive, as the real sidecar's server does: Canton reuses its connections

    def log_message(self, *args):
        pass

    def reply(self, body: bytes, content_type: str = "text/plain"):
        self.send_response(200); self.send_header("content-type", content_type); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        self.reply(b"{}", "application/json")

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        function = self.headers.get("X-Daml-External-Function-Id")
        with open(os.environ["FAKE_LOG"], "a") as log:
            log.write(f"{port} {function} {self.headers.get('X-Daml-External-Mode')}\n")
        if function == "verify":
            answer = verify(bytes.fromhex(body.decode()).decode()).encode().hex().encode()
        elif function == "verify2":
            answer = verify2(body.decode()).encode().hex().encode()
        else:
            request = urllib.request.Request(f"http://127.0.0.1:{real_port}/api/v1/external-call", body, {"X-Daml-External-Function-Id": function or ""})
            with urllib.request.urlopen(request, timeout=60) as r:
                answer = r.read()
        self.reply(answer)


if __name__ == "__main__":
    port, real_port, program_vk, root_c, accepted = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
