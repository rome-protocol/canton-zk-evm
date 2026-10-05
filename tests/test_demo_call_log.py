"""The rehearsal's call log (tests/demo_call_log.py): it passes every request to the real service unchanged, and writes one JSON line for each
request, with its method, path and body, so that the rehearsal can say exactly what the explorer asked for.
Run: python3 -m unittest discover -s tests -p 'test_demo_call_log.py'"""
import http.server, json, sys, tempfile, threading, unittest, urllib.error, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import demo_call_log as c


class Upstream(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body, kind="application/json"):
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(404, b'{"cause":"nothing here"}') if self.path == "/missing" else self.reply(200, b'{"offset":42}')

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        self.reply(200, json.dumps({"echo": body.decode(), "type": self.headers.get("content-type"), "encoding": self.headers.get("accept-encoding")}).encode())


class CallLog(unittest.TestCase):
    def setUp(self):
        self.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        self.dir = tempfile.TemporaryDirectory()
        self.log = Path(self.dir.name) / "calls"
        self.proxy = c.make_server(0, f"http://127.0.0.1:{self.upstream.server_port}", str(self.log))
        threading.Thread(target=self.proxy.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.proxy.server_port}"

    def tearDown(self):
        self.proxy.shutdown(); self.proxy.server_close()
        if self.upstream is not None:
            self.upstream.shutdown(); self.upstream.server_close()
        self.dir.cleanup()

    def lines(self):
        return [json.loads(x) for x in self.log.read_text().splitlines()]

    def test_a_get_is_passed_on_and_logged(self):
        with urllib.request.urlopen(self.base + "/v2/state/ledger-end") as r:
            self.assertEqual((r.status, json.load(r)), (200, {"offset": 42}))
        self.assertEqual(self.lines(), [{"method": "GET", "path": "/v2/state/ledger-end", "body": ""}])

    def test_a_post_is_passed_on_with_its_body_and_logged_with_it(self):
        body = json.dumps({"filter": "reader"})
        # The answer comes back with its content type and nothing else of its headers, so the service is not asked for a compressed one.
        req = urllib.request.Request(self.base + "/v2/updates", body.encode(), {"content-type": "application/json", "accept-encoding": "gzip"})
        with urllib.request.urlopen(req) as r:
            self.assertEqual(json.load(r), {"echo": body, "type": "application/json", "encoding": "identity"})
        self.assertEqual(self.lines(), [{"method": "POST", "path": "/v2/updates", "body": body}])

    def test_the_status_of_a_refusal_comes_through(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(self.base + "/missing")
        with e.exception:
            self.assertEqual((e.exception.code, json.load(e.exception)), (404, {"cause": "nothing here"}))
        self.assertEqual([x["path"] for x in self.lines()], ["/missing"])

    def test_the_calls_are_logged_in_order_one_line_each(self):
        for path in ("/a", "/b", "/c"):
            urllib.request.urlopen(self.base + path).read()
        self.assertEqual([x["path"] for x in self.lines()], ["/a", "/b", "/c"])

    def test_a_service_that_does_not_answer_is_a_502_and_is_still_logged(self):
        self.upstream.shutdown(); self.upstream.server_close(); self.upstream = None
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(self.base + "/gone")
        e.exception.close()
        self.assertEqual(e.exception.code, 502)
        self.assertEqual([x["path"] for x in self.lines()], ["/gone"])

    def test_it_listens_on_the_loopback_only(self):
        self.assertEqual(self.proxy.server_address[0], "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
