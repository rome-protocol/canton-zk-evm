"""What decides whether the nightly's L5 runs, tested where it is decided: `explorer/test/l5/l5.sh probe`, which reads the explorer's /api/openapi.json
(paths['/api'].get['x-modules']) and never calls the API itself, against a fake explorer. Exit 0 and the modules runs L5, 3 skips it, 4 fails the job.
Needs bash, curl and jq."""
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
    def probe(self, status, body):
        server = serve(status, body)
        try:
            run = subprocess.run(["bash", str(L5 / "l5.sh"), "probe"], capture_output=True, text=True, timeout=60,
                                 env={"PATH": __import__("os").environ["PATH"], "EXPLORER": f"http://127.0.0.1:{server.server_port}",
                                      "L5_PROBE_TRIES": "2", "L5_PROBE_WAIT": "0"})
            return run.returncode, run.stdout.strip(), run.stderr
        finally:
            server.shutdown()
            server.server_close()

    @staticmethod
    def spec(modules=None, door=True):
        paths = {"/api/block/{id}": {"get": {}}}
        if door:
            get = {"tags": ["Etherscan"]}
            if modules is not None:
                get["x-modules"] = modules
            paths["/api"] = {"get": get}
        return json.dumps({"openapi": "3.1.0", "paths": paths})

    MODULES = {"account": ["balance"], "transaction": ["getstatus"], "proxy": ["eth_blockNumber"]}

    def test_the_door_in_the_description_runs_l5_with_its_modules(self):
        code, out, _ = self.probe(200, self.spec(self.MODULES))
        self.assertEqual((code, out), (0, "account,transaction,proxy"))

    def test_the_contract_module_appears_when_it_lands(self):
        code, out, _ = self.probe(200, self.spec({**self.MODULES, "contract": ["getabi"]}))
        self.assertEqual((code, out), (0, "account,transaction,proxy,contract"))

    def test_no_door_in_the_description_is_exit_3(self):
        self.assertEqual(self.probe(200, self.spec(door=False))[0], 3)

    def test_the_door_without_its_modules_is_a_failure(self):
        self.assertEqual(self.probe(200, self.spec(None))[0], 4)  # /api without x-modules

    def test_a_description_that_cannot_be_read_is_a_failure_not_a_skip(self):
        for status, body in [(404, "{}"), (429, '{"error":"slow down"}'), (500, ""), (200, "<!doctype html>"), (200, '{"openapi":"3.1.0"}')]:
            code, _, err = self.probe(status, body)
            self.assertEqual(code, 4, (status, body))
            self.assertIn("L5 FAIL", err)

    def test_a_door_with_no_modules_is_a_failure(self):
        self.assertEqual(self.probe(200, self.spec({}))[0], 4)

    def test_the_no_door_results_are_a_failure(self):
        out = json.loads(subprocess.run(["bash", str(L5 / "l5.sh"), "no-door"], capture_output=True, text=True, check=True).stdout)
        self.assertEqual(out["status"], "failed")
        self.assertEqual(len(out["failures"]), 1)
        self.assertIn("no Etherscan-compatible /api door", out["failures"][0])

    def test_the_nightly_fails_on_a_description_with_no_door(self):
        # Runs the very branch of tests/demo_nightly_chain.sh that handles probe exit 3, with the real l5.sh, and reads back what it leaves.
        chain = (Path(__file__).resolve().parent / "demo_nightly_chain.sh").read_text()
        start = chain.index('if [ "$probe_rc" = 3 ]; then')
        end = chain.index("elif", start)
        branch = chain[start:end] + "fi\n"
        with tempfile.TemporaryDirectory() as out_dir:
            script = f'nightly_failed=()\nL5={L5}\nNIGHTLY_OUT={out_dir}\nprobe_rc=3\n{branch}echo "FAILED=${{nightly_failed[*]}}"\n'
            run = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=60)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn("FAILED=L5 (no /api door)", run.stdout)
            self.assertEqual(json.loads((Path(out_dir) / "l5.json").read_text())["status"], "failed")


if __name__ == "__main__":
    unittest.main()
