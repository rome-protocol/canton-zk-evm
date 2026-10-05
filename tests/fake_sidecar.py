#!/usr/bin/env python3
"""A stand-in for the sidecar, for the Canton network test only. It answers each external call with the line in a file, by
function: "$FAKE_ANSWER.<function>" (plain text), or, when a file "$FAKE_ANSWER.<port>.<function>" exists, with the line in
that one, so that two sidecars can be made to answer differently. A function with neither file gets a 500. It records each
call as "<port> <function> <mode>" in $FAKE_LOG.
Usage: fake_sidecar.py <port>"""
import http.server, os, sys

port = int(sys.argv[1])


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):   # /api/v1/version: Canton checks it at start-up
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b"{}")

    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        function = self.headers.get("X-Daml-External-Function-Id")
        with open(os.environ["FAKE_LOG"], "a") as log:
            log.write(f"{port} {function} {self.headers.get('X-Daml-External-Mode')}\n")
        base = os.environ["FAKE_ANSWER"]
        for name in (f"{base}.{port}.{function}", f"{base}.{function}"):
            if os.path.exists(name):
                answer = open(name).read().strip()
                self.send_response(200); self.end_headers(); self.wfile.write(answer.encode().hex().encode())
                return
        self.send_response(500); self.end_headers(); self.wfile.write(f"no answer for {function}".encode())


http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
