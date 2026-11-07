#!/usr/bin/env python3
"""A stand-in for a token registry, for the accounts service's Canton test only. The local network has no Canton Coin, so no scan proxy: this serves the token standard's
off-chain API (POST /registry/allocation-instruction/v1/allocation-factory and POST /registry/transfer-instruction/v1/<id>/choice-contexts/accept) with the answers that
the test writes into <answers>/allocation-factory.json and <answers>/accept.json, and only to a request that carries the bearer token in <token file>.
Usage: fake_registry.py <port> <answers directory> <token file>"""
import http.server, os, re, sys

port, answers, bearer_file = int(sys.argv[1]), sys.argv[2], sys.argv[3]
ACCEPT = re.compile(r"/registry/transfer-instruction/v1/00[0-9a-f]+/choice-contexts/accept\Z")


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        name = "allocation-factory.json" if self.path == "/registry/allocation-instruction/v1/allocation-factory" else "accept.json" if ACCEPT.fullmatch(self.path) else None
        path = os.path.join(answers, name) if name else None
        if self.headers.get("authorization") != "Bearer " + open(bearer_file).read().strip():
            status, data = 401, b"{}"
        elif not path or not os.path.exists(path):
            status, data = 404, b"{}"
        else:
            status, data = 200, open(path, "rb").read()
        self.send_response(status); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)


http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
