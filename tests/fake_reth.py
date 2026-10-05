#!/usr/bin/env python3
"""A stand-in for reth's JSON-RPC, for the Canton network test only: it answers eth_call with true, which is what the gateway
contract's wrapped(token) says for a token it made, and anything else with an error. Usage: fake_reth.py <port>"""
import http.server, json, sys

port = int(sys.argv[1])


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if request["method"] == "eth_call":
            answer = {"jsonrpc": "2.0", "id": request["id"], "result": "0x" + "00" * 31 + "01"}
        else:
            answer = {"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "not here"}}
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(answer).encode())


http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
