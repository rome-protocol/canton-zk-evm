#!/usr/bin/env python3
"""A pass-through in front of Canton's JSON Ledger API that can lose one reply, for the pipeline scenario (tests/network_pipeline.sh).

Every request goes to the real service unchanged and its answer comes back unchanged, with one exception. While the control file exists, the
next POST to /v2/commands/submit-and-wait is sent on, Canton takes the command and answers, and then this proxy deletes the control file, writes
the line "dropped <command id>" to the log and closes the connection without a word. The caller sees a command with no answer that Canton
has committed: a lost reply, made to happen at an exact command instead of by a timeout.

It can also hold one reply back. With a hold file and a number of seconds, the first submit-and-wait whose command id contains the text in the hold
file is answered that many seconds late (the file is deleted as it is used). The scenario puts the first 16 hex digits of a block's hash there when
it gives that block a bad proof: Canton refuses it at once, and the builder hears of it only after the blocks behind it have had time to be proven.

After a dropped reply it can also go blind for a number of seconds: the reads of completions (/v2/commands/completions) are answered with 503 and not
sent on. This matters only when the caller cannot settle its command another way: the builder asks Canton's head first and settles a committed command
at once from it, and reads completions only when the head does not yet show the block.

Usage: ledger_drop_proxy.py <listen port> <service url> <control file> <log file> [<hold file> <seconds> [<blind seconds>]]      (listens on 127.0.0.1 only)
The log has one line for every submit-and-wait: "forwarded <command id> <status>", "held <command id> <seconds>" or "dropped <command id>",
and one "blind" line for every completions read it refused."""
import http.server, json, os, sys, threading, time, urllib.error, urllib.request

SKIPPED = {"connection", "transfer-encoding", "keep-alive", "content-length", "host", "accept-encoding"}
SUBMIT = "/v2/commands/submit-and-wait"
COMPLETIONS = "/v2/commands/completions"


def command_id(body: bytes) -> str:
    try:
        return str(json.loads(body).get("commandId", "?"))
    except (ValueError, AttributeError):
        return "?"


def make_server(port: int, upstream: str, control: str, log_file: str, hold_file: str = "", hold_seconds: float = 0, blind_seconds: float = 0) -> http.server.ThreadingHTTPServer:
    lock = threading.Lock()
    blind_until = [0.0]

    def note(line: str) -> None:
        with lock, open(log_file, "a") as f:
            f.write(line + "\n")

    def take_control() -> bool:
        """True for exactly one caller while the control file exists: whoever deletes it."""
        try:
            os.unlink(control)
            return True
        except FileNotFoundError:
            return False

    def take_hold(cid: str) -> bool:
        """True when the hold file names this command's block; the file is used up."""
        if not hold_file:
            return False
        with lock:
            try:
                with open(hold_file) as f:
                    wanted = f.read().strip()
                if wanted and wanted in cid:
                    os.unlink(hold_file)
                    return True
            except OSError:
                pass
        return False

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def handle_any(self):
            body = self.rfile.read(int(self.headers.get("content-length") or 0))
            if time.time() < blind_until[0] and self.path.split("?")[0] == COMPLETIONS:
                note("blind")
                self.send_response(503)
                self.send_header("content-length", "0")
                self.end_headers()
                return
            headers = {k: v for k, v in self.headers.items() if k.lower() not in SKIPPED}
            req = urllib.request.Request(upstream + self.path, body or None, headers, method=self.command)
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    status, answer, kind = r.status, r.read(), r.headers.get("content-type")
            except urllib.error.HTTPError as e:
                with e:
                    status, answer, kind = e.code, e.read(), e.headers.get("content-type")
            except OSError:
                status, answer, kind = 502, b"the service did not answer", "text/plain"
            if self.command == "POST" and self.path.split("?")[0] == SUBMIT:
                if status == 200 and os.path.exists(control) and take_control():
                    blind_until[0] = time.time() + blind_seconds
                    note(f"dropped {command_id(body)}")
                    self.close_connection = True
                    self.connection.shutdown(2)   # the command is committed; the caller hears nothing
                    return
                if take_hold(command_id(body)):
                    note(f"held {command_id(body)} {hold_seconds:g}")
                    time.sleep(hold_seconds)
                note(f"forwarded {command_id(body)} {status}")
            self.send_response(status)
            if kind:
                self.send_header("content-type", kind)
            self.send_header("content-length", str(len(answer)))
            self.end_headers()
            self.wfile.write(answer)

        do_GET = do_POST = do_HEAD = do_PUT = do_DELETE = handle_any

    class Server(http.server.ThreadingHTTPServer):
        daemon_threads = True

    return Server(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    if len(sys.argv) not in (5, 7, 8):
        sys.exit(__doc__)
    extra = (sys.argv[5], float(sys.argv[6]), float(sys.argv[7]) if len(sys.argv) == 8 else 0) if len(sys.argv) >= 7 else ("", 0, 0)
    make_server(int(sys.argv[1]), sys.argv[2].rstrip("/"), sys.argv[3], sys.argv[4], *extra).serve_forever()
