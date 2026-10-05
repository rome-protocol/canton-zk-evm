#!/usr/bin/env python3
"""A pass-through for the demo rehearsal (tests/demo_rehearsal.sh) that writes down what a client asks for. The explorer is pointed at it
instead of at reth and at Canton's Ledger API, so that the rehearsal can check, from the log, that the explorer called nothing but the calls it
should. Every request goes to the real service unchanged and its answer comes back unchanged. One JSON line is written for each request:
{"method": ..., "path": ..., "body": ...}.

Usage: demo_call_log.py <listen port> <service url> <log file>      (listens on 127.0.0.1 only)"""
import http.server, json, sys, threading, urllib.error, urllib.request

# Not passed on: the connection's own headers, and a wish for a compressed answer (only the content type comes back, so the caller could not tell it was one).
SKIPPED = {"connection", "transfer-encoding", "keep-alive", "content-length", "host", "accept-encoding"}


def make_server(port: int, upstream: str, log_file: str) -> http.server.ThreadingHTTPServer:
    lock = threading.Lock()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def handle_any(self):
            body = self.rfile.read(int(self.headers.get("content-length") or 0))
            with lock, open(log_file, "a") as f:
                f.write(json.dumps({"method": self.command, "path": self.path, "body": body.decode("utf-8", "replace")}) + "\n")
            headers = {k: v for k, v in self.headers.items() if k.lower() not in SKIPPED}
            req = urllib.request.Request(upstream + self.path, body or None, headers, method=self.command)
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    status, answer, kind = r.status, r.read(), r.headers.get("content-type")
            except urllib.error.HTTPError as e:
                with e:
                    status, answer, kind = e.code, e.read(), e.headers.get("content-type")
            except OSError:
                status, answer, kind = 502, b"the service did not answer", "text/plain"
            self.send_response(status)
            if kind:
                self.send_header("content-type", kind)
            self.send_header("content-length", str(len(answer)))
            self.end_headers()
            self.wfile.write(answer)

        do_GET = do_POST = do_HEAD = do_PUT = do_DELETE = handle_any

    return http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    make_server(int(sys.argv[1]), sys.argv[2].rstrip("/"), sys.argv[3]).serve_forever()
