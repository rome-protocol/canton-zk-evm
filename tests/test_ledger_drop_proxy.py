"""tests/ledger_drop_proxy.py: everything passes through, and while the control file exists the next submit-and-wait is committed upstream
and its reply is lost, once."""
import http.server, json, os, sys, tempfile, threading, unittest, urllib.error, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
import ledger_drop_proxy


class Upstream(http.server.BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        Upstream.seen.append((self.path, body))
        answer = json.dumps({"updateId": "u", "completionOffset": 7}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(answer)))
        self.end_headers()
        self.wfile.write(answer)

    do_GET = do_POST


def serve(server):
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class DropProxy(unittest.TestCase):
    def setUp(self):
        Upstream.seen = []
        self.dir = tempfile.TemporaryDirectory()
        self.control, self.log = os.path.join(self.dir.name, "drop"), os.path.join(self.dir.name, "log")
        self.up = serve(http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream))
        self.proxy = serve(ledger_drop_proxy.make_server(0, f"http://127.0.0.1:{self.up.server_port}", self.control, self.log))
        self.url = f"http://127.0.0.1:{self.proxy.server_port}"

    def tearDown(self):
        self.proxy.shutdown(); self.proxy.server_close(); self.up.shutdown(); self.up.server_close(); self.dir.cleanup()

    def logged(self):
        with open(self.log) as f:
            return f.read()

    def submit(self, cid):
        req = urllib.request.Request(self.url + "/v2/commands/submit-and-wait", json.dumps({"commandId": cid}).encode(), {"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)

    def test_passes_through(self):
        self.assertEqual(self.submit("a")["completionOffset"], 7)
        self.assertEqual(self.logged(), "forwarded a 200\n")

    def test_drops_one_reply_and_the_command_is_committed(self):
        open(self.control, "w").close()
        with self.assertRaises(OSError):
            self.submit("b")
        self.assertEqual([p for p, _ in Upstream.seen], ["/v2/commands/submit-and-wait"])   # it reached the service
        self.assertFalse(os.path.exists(self.control))
        self.assertEqual(self.submit("c")["updateId"], "u")   # the next one is answered
        self.assertEqual(self.logged(), "dropped b\nforwarded c 200\n")

    def test_other_calls_are_never_dropped(self):
        open(self.control, "w").close()
        with urllib.request.urlopen(urllib.request.Request(self.url + "/v2/commands/completions", b"{}", {"content-type": "application/json"}), timeout=10) as r:
            self.assertEqual(r.status, 200)
        self.assertTrue(os.path.exists(self.control))


if __name__ == "__main__":
    unittest.main()
