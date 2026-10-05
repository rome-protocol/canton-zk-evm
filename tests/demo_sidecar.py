#!/usr/bin/env python3
"""A stand-in for the sidecar, for the demo rehearsal only (tests/demo_rehearsal.sh). There is no GPU in CI, so there is no real
proof. This answers `verify` itself: the proof is accepted only if it is the one stand-in proof the rehearsal's fake prover writes, and
then the rest of the answer is read from the header and the transaction list exactly as the real sidecar reads it. Every other
call, `fact` in particular, is passed to the REAL sidecar, which checks the storage proofs against the block's state root.
So the rehearsal runs everything but the zero-knowledge proof check.

Usage: demo_sidecar.py <port> <real sidecar port> <program-vk hex> <root-c hex> <the accepted proof, hex>"""
import http.server, os, sys, urllib.request
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


def verify(line: str) -> str:
    fields = line.split(",")
    if len(fields) != 3:
        return "no malformed input"
    proof, header_hex, txs_hex = fields
    if proof != accepted:
        return "no the proof does not verify"
    header = bytes.fromhex(header_hex)
    f = items(header)
    number, ts, gas_limit, gas_used = (int.from_bytes(f[i], "big") for i in (8, 11, 9, 10))
    tx_count = len(items(bytes.fromhex(txs_hex))) if txs_hex else 0
    return " ".join(["ok", program_vk, root_c, keccak256(header).hex(), f[0].hex(), str(number), f[3].hex(), str(ts), str(gas_limit), str(gas_used), str(tx_count)])


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
        else:
            request = urllib.request.Request(f"http://127.0.0.1:{real_port}/api/v1/external-call", body, {"X-Daml-External-Function-Id": function or ""})
            with urllib.request.urlopen(request, timeout=60) as r:
                answer = r.read()
        self.reply(answer)


if __name__ == "__main__":
    port, real_port, program_vk, root_c, accepted = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
