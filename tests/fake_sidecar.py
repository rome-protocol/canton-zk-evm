#!/usr/bin/env python3
"""A stand-in for the sidecar, for the Canton network test only: it answers every external call with the line in the
file named by $FAKE_ANSWER (plain text), or, when a file "$FAKE_ANSWER.<port>" exists, with the line in that file, so that
two sidecars can be made to answer differently. It records each call as "<port> <function> <mode>" in $FAKE_LOG.
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
        with open(os.environ["FAKE_LOG"], "a") as log:
            log.write(f"{port} {self.headers.get('X-Daml-External-Function-Id')} {self.headers.get('X-Daml-External-Mode')}\n")
        own = f"{os.environ['FAKE_ANSWER']}.{port}"
        answer = open(own if os.path.exists(own) else os.environ["FAKE_ANSWER"]).read().strip()
        self.send_response(200); self.end_headers(); self.wfile.write(answer.encode().hex().encode())


http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
