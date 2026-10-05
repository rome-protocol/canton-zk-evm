"""Tests for demo/evm.py with a fake reth (the HTTP JSON-RPC port only). Run: python3 -m unittest discover -s demo/tests"""
import http.server, json, os, stat, sys, tempfile, threading, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import evm
from eth_account import Account
from eth_account.typed_transactions import TypedTransaction
from hexbytes import HexBytes

TOKEN = "0x" + "ab" * 20   # letters: reth reports addresses in lower case and the signer wants them checksummed


class FakeReth(http.server.BaseHTTPRequestHandler):
    calls: list = []
    receipt = None

    def log_message(self, *args):
        pass

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["content-length"])))
        FakeReth.calls.append(req)
        m = req["method"]
        result = {"eth_chainId": hex(770101), "eth_getTransactionCount": "0x2", "eth_sendRawTransaction": "0x" + "ab" * 32,
                  "eth_getTransactionReceipt": FakeReth.receipt,
                  "eth_call": hex(7 * evm.ONE)}[m]
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": result}).encode()
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)


class EvmTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        os.environ["CZE_STATE_DIR"] = self.tmp.name
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeReth)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        os.environ["RETH_HTTP_PORT"] = str(self.server.server_address[1])
        FakeReth.calls, FakeReth.receipt = [], None

    def test_keys_are_private_and_stable(self):
        a = evm.main(["keys"])
        key_file = Path(self.tmp.name) / "demo" / "v.key"
        self.assertEqual(stat.S_IMODE(key_file.stat().st_mode), 0o600)
        self.assertEqual(Account.from_key("0x" + key_file.read_text().strip()).address, a["v"])
        self.assertNotEqual(a["u"], a["v"])
        self.assertEqual(evm.main(["keys"]), a)                     # a second run keeps them
        self.assertNotIn(key_file.read_text().strip(), json.dumps(a))   # the key is never in what is printed
        files = {p.name for p in key_file.parent.iterdir()}
        self.assertEqual(files, {"v.key", "addresses.json"})        # U's key is not kept

    def test_one_of_the_two_files_is_refused(self):
        evm.main(["keys"])
        (Path(self.tmp.name) / "demo" / "addresses.json").unlink()
        with self.assertRaises(SystemExit):
            evm.main(["keys"])

    def test_genesis_funds_v_only_and_leaves_the_rest(self):
        out = evm.main(["genesis"])
        funded = json.loads(Path(out["genesis"]).read_text())
        base = json.loads((evm.ROOT / "network" / "genesis.json").read_text())
        self.assertEqual(funded["config"], base["config"])           # the chain rules are the pinned ones
        v = out["funded"].lower().removeprefix("0x")
        self.assertEqual(funded["alloc"][v], {"balance": hex(10 * evm.ONE)})
        self.assertEqual({k: x for k, x in funded["alloc"].items() if k != v}, base["alloc"])
        self.assertEqual({k: x for k, x in funded.items() if k != "alloc"}, {k: x for k, x in base.items() if k != "alloc"})

    def raw_sent(self):
        [req] = [c for c in FakeReth.calls if c["method"] == "eth_sendRawTransaction"]
        return bytes.fromhex(req["params"][0][2:])

    def test_deploy_sends_a_signed_creation_with_the_constructor_arguments(self):
        v = evm.main(["keys"])["v"]
        out = evm.main(["deploy"])
        self.assertEqual(out["tx"], "0x" + "ab" * 32)
        raw = self.raw_sent()
        self.assertEqual(raw[0], 2)                                  # an EIP-1559 transaction
        decoded = Account.recover_transaction(raw)
        self.assertEqual(decoded, v)
        tx = TypedTransaction.from_bytes(HexBytes(raw)).as_dict()
        self.assertEqual((tx["chainId"], tx["nonce"], tx["gas"]), (770101, 2, evm.DEPLOY_GAS))
        self.assertFalse(tx.get("to"))                              # a creation has no recipient
        code = (evm.ROOT / "demo" / "TKA.bin").read_text().strip()
        self.assertEqual(bytes(tx["data"]).hex(), code + v.lower()[2:].rjust(64, "0") + f"{1000 * evm.ONE:064x}")

    def test_transfer_goes_to_the_token_and_pays_u(self):
        a = evm.main(["keys"])
        evm.main(["transfer", TOKEN, "10"])
        raw = self.raw_sent()
        self.assertEqual(Account.recover_transaction(raw), a["v"])
        tx = TypedTransaction.from_bytes(HexBytes(raw)).as_dict()
        self.assertEqual("0x" + bytes(tx["to"]).hex(), TOKEN)
        self.assertEqual(bytes(tx["data"]).hex(), "a9059cbb" + a["u"].lower()[2:].rjust(64, "0") + f"{10 * evm.ONE:064x}")

    def test_bad_arguments_are_refused(self):
        for argv in (["transfer", TOKEN, "0"], ["transfer", TOKEN, "-1"], ["transfer", TOKEN, "1.5"], ["nothing"], []):
            with self.assertRaises(SystemExit, msg=str(argv)):
                evm.main(argv)

    def test_receipt_and_balance(self):
        with self.assertRaises(SystemExit):
            evm.main(["receipt", "0x" + "ab" * 32])                  # not in a block yet
        FakeReth.receipt = {"blockNumber": "0x2", "blockHash": "0x" + "cd" * 32, "gasUsed": "0x5208", "status": "0x1", "contractAddress": TOKEN}
        self.assertEqual(evm.main(["receipt", "0x" + "ab" * 32]), {"block": 2, "blockHash": "0x" + "cd" * 32, "gasUsed": 21000, "status": 1, "contract": TOKEN})
        self.assertEqual(evm.main(["balance", TOKEN, "0x" + "22" * 20]), {"tka": 7})


if __name__ == "__main__":
    unittest.main()
