"""What decides whether the nightly's L5 runs, tested where it is decided: `explorer/test/l5/l5.sh probe` (DOOR, and a live probe that must agree with it) against
a fake explorer. Exit 0 runs L5, 3 skips it, 4 fails the job. Needs bash, curl and jq."""
import http.server
import json
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

L5 = Path(__file__).resolve().parent.parent / "explorer" / "test" / "l5"


def serve(status, body):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            payload = body.encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class Probe(unittest.TestCase):
    def probe(self, marker, status, body):
        server = serve(status, body)
        try:
            with tempfile.TemporaryDirectory() as d:
                door = Path(d) / "DOOR"
                door.write_text(marker + "\n")
                run = subprocess.run(["bash", str(L5 / "l5.sh"), "probe"], capture_output=True, text=True, timeout=60,
                                     env={"PATH": __import__("os").environ["PATH"], "EXPLORER": f"http://127.0.0.1:{server.server_port}", "L5_DOOR_FILE": str(door),
                                          "L5_PROBE_TRIES": "2", "L5_PROBE_WAIT": "0"})
                return run.returncode, run.stderr
        finally:
            server.shutdown()
            server.server_close()

    OK = '{"jsonrpc":"2.0","id":83,"result":"0x1f"}'

    def test_the_repo_says_absent(self):
        self.assertEqual((L5 / "DOOR").read_text().strip(), "absent")

    def test_absent_and_not_answering_is_a_skip(self):
        for status, body in [(404, '{"error":"not found"}'), (200, "<!doctype html>"), (200, '{"status":"0","result":"Invalid module"}'), (200, '{"result":null}')]:
            self.assertEqual(self.probe("absent", status, body)[0], 3, (status, body))

    def test_absent_but_answering_is_a_failure(self):
        code, err = self.probe("absent", 200, self.OK)
        self.assertEqual(code, 4)
        self.assertIn("DOOR still says 'absent'", err)

    def test_present_and_answering_runs(self):
        self.assertEqual(self.probe("present", 200, self.OK)[0], 0)

    def test_present_and_not_answering_is_a_failure_not_a_skip(self):
        for status, body in [(404, "{}"), (429, '{"error":"slow down"}'), (200, '{"status":"0","result":"Invalid module"}'), (500, "")]:
            code, err = self.probe("present", status, body)
            self.assertEqual(code, 4, (status, body))
            self.assertIn("L5 FAIL", err)

    def test_a_marker_that_is_neither_is_refused(self):
        self.assertNotIn(self.probe("maybe", 200, self.OK)[0], (0, 3))

    def test_the_skip_is_not_a_pass(self):
        out = json.loads(subprocess.run(["bash", str(L5 / "l5.sh"), "skipped"], capture_output=True, text=True, check=True).stdout)
        self.assertEqual(out["status"], "skipped")
        self.assertTrue(out["reason"].startswith("SKIPPED"))
        self.assertEqual(out["failures"], [])


if __name__ == "__main__":
    unittest.main()
