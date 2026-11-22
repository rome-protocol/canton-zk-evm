#!/usr/bin/env python3
"""Tests of deploy_note_board.py against a local chain (anvil), with a throwaway keystore. Run by deploy-test.sh after `forge build`."""
import json, os, secrets, shutil, socket, subprocess, tempfile, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "deploy_note_board.py"
PASSWORD = secrets.token_hex(12)  # a new throwaway for the keystore of this run, made on the local test chain
BRIDGE = "0x" + "b2" * 20


def sh(*args, env=None):
    return subprocess.run(args, capture_output=True, text=True, env={**os.environ, **(env or {})})


class NoteBoardDeploy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
        cls.url = f"http://127.0.0.1:{port}"
        cls.anvil = subprocess.Popen(["anvil", "--port", str(port), "--silent"])
        for _ in range(100):
            if sh("cast", "chain-id", "--rpc-url", cls.url).returncode == 0:
                break
            time.sleep(0.1)
        (cls.tmp / "pw").write_text(PASSWORD)
        sh("cast", "wallet", "new", str(cls.tmp), "key", "--unsafe-password", PASSWORD)
        who = sh("cast", "wallet", "address", "--keystore", str(cls.tmp / "key"), "--password-file", str(cls.tmp / "pw")).stdout.strip()
        sh("cast", "rpc", "anvil_setBalance", who, "0x56BC75E2D63100000", "--rpc-url", cls.url)
        cls.chain_id = int(sh("cast", "chain-id", "--rpc-url", cls.url).stdout)

    @classmethod
    def tearDownClass(cls):
        cls.anvil.terminate()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def config(self, **over):
        c = {"local": {"chainId": self.chain_id, "bridge": BRIDGE}}
        c["local"].update(over)
        p = self.tmp / f"cfg-{time.monotonic_ns()}.json"
        p.write_text(json.dumps(c))
        return p

    def run_deploy(self, chain, cfg, *extra, url=None):
        a = ["python3", str(SCRIPT), "--config", str(cfg), "--keystore", str(self.tmp / "key"), "--password-file", str(self.tmp / "pw"), *extra, chain]
        p = sh(*a, env={"NOTE_BOARD_RPC_URL": url or self.url})
        return p.returncode, p.stdout + p.stderr

    def test_deploys_bound_to_the_configured_bridge_and_reads_it_back(self):
        rc, out = self.run_deploy("local", self.config())
        self.assertEqual(rc, 0, out)
        board = next(w for w in out.split() if w.startswith("0x") and len(w) == 42)
        self.assertEqual(sh("cast", "call", board, "BRIDGE()(address)", "--rpc-url", self.url).stdout.strip().lower(), BRIDGE)
        self.assertEqual(sh("cast", "call", board, "count()(uint256)", "--rpc-url", self.url).stdout.split()[0], "0")
        self.assertIn("read-backs passed", out)

    def test_refuses_a_chain_that_is_not_the_configs(self):
        rc, out = self.run_deploy("local", self.config(chainId=self.chain_id + 1))
        self.assertNotEqual(rc, 0)
        self.assertIn("chain id", out)

    def test_refuses_an_unknown_chain_name(self):
        rc, out = self.run_deploy("nowhere", self.config())
        self.assertNotEqual(rc, 0)
        self.assertIn("nowhere", out)

    def test_refuses_a_bad_bridge_address(self):
        rc, out = self.run_deploy("local", self.config(bridge="0x1234"))
        self.assertNotEqual(rc, 0)
        self.assertIn("bridge", out)

    def test_refuses_a_chain_that_is_not_local_without_live(self):
        # The same chain, but the node says it is not anvil: a stand-in that forwards every call and answers web3_clientVersion with another name.
        import http.server, threading, urllib.request
        target = self.url

        class Proxy(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                if json.loads(body).get("method") == "web3_clientVersion":
                    out = json.dumps({"jsonrpc": "2.0", "id": json.loads(body)["id"], "result": "reth/v1"}).encode()
                else:
                    out = urllib.request.urlopen(urllib.request.Request(target, body, {"Content-Type": "application/json"})).read()
                self.send_response(200); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)
            def log_message(self, *a): pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), Proxy)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{srv.server_address[1]}"
            rc, out = self.run_deploy("local", self.config(), url=url)
            self.assertNotEqual(rc, 0)
            self.assertIn("--live", out)
            rc, out = self.run_deploy("local", self.config(), "--live", url=url)
            self.assertEqual(rc, 0, out)
        finally:
            srv.shutdown()


if __name__ == "__main__":
    unittest.main()
