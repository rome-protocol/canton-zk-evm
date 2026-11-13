"""network/standard-contracts/deploy.py against a fake JSON-RPC node: the data checks itself, a dry run sends nothing, a first run deploys all four and
a second sends nothing, only the shortfall is funded, other code at an address is refused before anything is sent, and the key is never printed.
Needs eth-account (demo/requirements.txt pins it)."""
import contextlib, http.server, importlib.util, io, json, os, shutil, stat, tempfile, threading, unittest
from pathlib import Path

from eth_account import Account
from eth_account.typed_transactions import TypedTransaction
from hexbytes import HexBytes

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("standard_contracts_deploy", ROOT / "network" / "standard-contracts" / "deploy.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)

CHAIN_ID = 770101
KEY = "0x" + "ab" * 32
FUNDING = Account.from_key(KEY).address
ENTRIES = {e["name"]: e for e in json.loads(deploy.DATA_FILE.read_text())["contracts"]}
PRESIGNED = {e["presignedTx"]: e for e in ENTRIES.values() if e["how"] == "presigned"}


class FakeChain(http.server.ThreadingHTTPServer):
    """Just enough of a node: balances, nonces, code, and a block per transaction. A presigned transaction needs its signer to hold gasLimit x gasPrice
    and leaves the canonical runtime code; a call to the CREATE2 deployer with the salt and Permit2's init code leaves Permit2's."""
    daemon_threads = True

    def __init__(self, refuse_unprotected=False, frontrun=None):
        super().__init__(("127.0.0.1", 0), Handler)
        self.balance = {FUNDING.lower(): 10**19}
        self.nonce = {}
        self.code = {}
        self.sent = []
        self.block = 0
        self.refuse_unprotected = refuse_unprotected
        self.frontrun = frontrun   # a name: its presigned transaction is refused with "nonce too low" and other code is at its address
        self.pending = {}          # address -> transactions waiting in the pool
        self.receipts = {}

    def put_code(self, name):
        e = ENTRIES[name]
        self.code[e["address"].lower()] = deploy.runtime_code(e, deploy.init_code_of(e), CHAIN_ID)

    def handle(self, method, params):
        s = self
        if method == "eth_chainId":
            return hex(CHAIN_ID)
        if method == "eth_getCode":
            c = s.code.get(params[0].lower())
            return "0x" + c.hex() if c else "0x"
        if method == "eth_getBalance":
            return hex(s.balance.get(params[0].lower(), 0))
        if method == "eth_getTransactionCount":
            return hex(s.nonce.get(params[0].lower(), 0) + (s.pending.get(params[0].lower(), 0) if params[1] == "pending" else 0))
        if method == "eth_getBlockByNumber":
            return {"number": hex(s.block), "baseFeePerGas": hex(7)}
        if method == "eth_maxPriorityFeePerGas":
            return hex(1_000_000_000)
        if method == "eth_estimateGas":
            return hex(2_300_000)
        if method == "eth_getTransactionReceipt":
            return s.receipts.get(params[0])
        if method == "eth_sendRawTransaction":
            return s.send(params[0])
        raise AssertionError(method)

    def send(self, raw):
        if raw in PRESIGNED:
            if self.refuse_unprotected:
                raise RuntimeError("This transaction is not tied to a chain. Sign it for chain 770101.")
            e = PRESIGNED[raw]
            if e["name"] == self.frontrun:
                self.code[e["address"].lower()] = b"\x60\x00"
                raise RuntimeError("nonce too low")
            if self.balance.get(e["signer"].lower(), 0) < e["gasLimit"] * e["gasPrice"]:
                raise RuntimeError("insufficient funds for gas * price + value")
            self.nonce[e["signer"].lower()] = 1
            self.balance[e["signer"].lower()] -= e["gasLimit"] * e["gasPrice"] // 2
            self.put_code(e["name"])
            kind, used = "presigned", {"create2-deployer": 68131, "multicall3": 872776, "createx": 2580902}[e["name"]]
        else:
            data = HexBytes(raw)
            tx = TypedTransaction.from_bytes(data).as_dict()
            sender = Account.recover_transaction(raw).lower()
            self.nonce[sender] = self.nonce.get(sender, 0) + 1
            to = "0x" + tx["to"].hex() if isinstance(tx["to"], bytes) else tx["to"]
            self.balance[sender] -= tx["value"]
            self.balance[to.lower()] = self.balance.get(to.lower(), 0) + tx["value"]
            p2 = ENTRIES["permit2"]
            if tx["data"] and to.lower() == ENTRIES["create2-deployer"]["address"].lower():
                assert bytes(tx["data"]) == deploy.hexbytes(p2["salt"]) + deploy.hexbytes(p2["initCode"])
                self.put_code("permit2")
            kind, used = "from funding", 21000
        self.block += 1
        h = "0x" + deploy.keccak256(deploy.hexbytes(raw)).hex()
        self.sent.append((kind, raw, tx["value"] if kind == "from funding" else 0, to if kind == "from funding" else None))
        self.receipts[h] = {"status": "0x1", "blockNumber": hex(self.block), "gasUsed": hex(used)}
        return h


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["content-length"])))
        try:
            body = {"jsonrpc": "2.0", "id": req["id"], "result": self.server.handle(req["method"], req["params"])}
        except RuntimeError as e:
            body = {"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32000, "message": str(e)}}
        out = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class Deploy(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.key_file = self.dir / "funding.key"
        fd = os.open(self.key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(KEY[2:])
        self.chain = FakeChain()
        threading.Thread(target=self.chain.serve_forever, daemon=True).start()

    def tearDown(self):
        self.chain.shutdown()
        self.chain.server_close()
        shutil.rmtree(self.dir)

    def run_it(self, *extra, chain=None):
        chain = chain or self.chain
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = deploy.main(["--rpc", f"http://127.0.0.1:{chain.server_address[1]}", "--funding-key-file", str(self.key_file), "--wait-seconds", "2", *extra])
        self.assertNotIn(KEY[2:], out.getvalue() + err.getvalue())   # the key is never printed
        return code, out.getvalue(), err.getvalue()

    def hash_at(self, name):
        c = self.chain.code.get(ENTRIES[name]["address"].lower())
        return "0x" + deploy.keccak256(c).hex() if c else None

    def test_the_data_checks_itself(self):
        entries = deploy.load_data()
        self.assertEqual([e["name"] for e in entries], ["create2-deployer", "multicall3", "createx", "permit2"])
        self.assertEqual([e["address"] for e in entries], ["0x4e59b44847b379578588920cA78FbF26c0B4956C", "0xcA11bde05977b3631167028862bE2a173976CA11",
                                                           "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed", "0x000000000022D473030F116dDEE9F6B43aC78BA3"])

    def test_a_changed_presigned_transaction_or_signer_is_refused(self):
        data = json.loads(deploy.DATA_FILE.read_text())
        data["contracts"][1]["signer"] = ENTRIES["createx"]["signer"]
        broken = self.dir / "contracts.json"
        broken.write_text(json.dumps(data))
        real = deploy.DATA_FILE
        deploy.DATA_FILE = broken
        try:
            with self.assertRaisesRegex(deploy.Stop, "signer"):
                deploy.load_data()
            data = json.loads(real.read_text())
            data["contracts"][3]["salt"] = "0x" + "00" * 32
            broken.write_text(json.dumps(data))
            with self.assertRaisesRegex(deploy.Stop, "salt and init code"):
                deploy.load_data()
        finally:
            deploy.DATA_FILE = real

    def test_permit2_runtime_code_depends_on_the_chain_and_the_known_hash_holds(self):
        p2 = ENTRIES["permit2"]
        self.assertEqual(deploy.expected_hash(p2, 770101), p2["knownRuntimeCodeHashes"]["770101"])
        self.assertNotEqual(deploy.expected_hash(p2, 1), deploy.expected_hash(p2, 770101))
        # TestNet's chain: its own hash is pinned, and it is not DevNet's.
        self.assertEqual(deploy.expected_hash(p2, 770102), p2["knownRuntimeCodeHashes"]["770102"])
        self.assertNotEqual(p2["knownRuntimeCodeHashes"]["770102"], p2["knownRuntimeCodeHashes"]["770101"])

    def test_a_dry_run_sends_nothing(self):
        code, out, err = self.run_it("--dry-run")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.chain.sent, [])
        self.assertIn("dry run: nothing was sent", out)
        for name in ENTRIES:
            self.assertIn(ENTRIES[name]["address"], out)
        self.assertIn("compromised", out)   # the Multicall3 signer's key

    def test_the_first_run_deploys_all_four_and_the_second_sends_nothing(self):
        code, out, err = self.run_it()
        self.assertEqual(code, 0, err + out)
        for name in ENTRIES:
            self.assertEqual(self.hash_at(name), deploy.expected_hash(ENTRIES[name], CHAIN_ID), name)
        kinds = [k for k, *_ in self.chain.sent]
        self.assertEqual(kinds.count("presigned"), 3)
        self.assertEqual(kinds.count("from funding"), 4)   # three fundings and Permit2
        funded = {to.lower(): value for k, _, value, to in self.chain.sent if k == "from funding" and value}
        for name in ("create2-deployer", "multicall3", "createx"):
            e = ENTRIES[name]
            self.assertEqual(funded[e["signer"].lower()], e["gasLimit"] * e["gasPrice"], name)
        before = len(self.chain.sent)
        code, out, err = self.run_it()
        self.assertEqual(code, 0, err + out)
        self.assertEqual(len(self.chain.sent), before)
        self.assertIn("nothing to send", out)

    def test_only_the_shortfall_is_funded(self):
        e = ENTRIES["multicall3"]
        have = e["gasLimit"] * e["gasPrice"] * 3 // 4
        self.chain.balance[e["signer"].lower()] = have
        code, out, err = self.run_it("--only", "create2-deployer,multicall3")
        self.assertEqual(code, 0, err + out)
        funded = {to.lower(): value for k, _, value, to in self.chain.sent if k == "from funding"}
        self.assertEqual(funded[e["signer"].lower()], e["gasLimit"] * e["gasPrice"] - have)
        self.assertIsNone(self.hash_at("createx"))
        self.assertIsNone(self.hash_at("permit2"))

    def test_a_signer_that_holds_enough_is_not_funded_again(self):
        e = ENTRIES["create2-deployer"]
        self.chain.balance[e["signer"].lower()] = e["gasLimit"] * e["gasPrice"]
        code, out, err = self.run_it("--only", "create2-deployer")
        self.assertEqual(code, 0, err + out)
        self.assertEqual([k for k, *_ in self.chain.sent], ["presigned"])

    def test_other_code_at_an_address_stops_everything_before_anything_is_sent(self):
        self.chain.code[ENTRIES["multicall3"]["address"].lower()] = b"\x60\x00"
        code, out, err = self.run_it()
        self.assertEqual(code, 1)
        self.assertIn("REFUSED multicall3", err)
        self.assertEqual(self.chain.sent, [])

    def test_an_address_whose_signer_was_used_is_refused(self):
        self.chain.nonce[ENTRIES["createx"]["signer"].lower()] = 1
        code, out, err = self.run_it()
        self.assertEqual(code, 1)
        self.assertIn("cannot be deployed on this chain", err)
        self.assertEqual(self.chain.sent, [])

    def test_permit2_alone_needs_the_deployer(self):
        code, out, err = self.run_it("--only", "permit2")
        self.assertEqual(code, 1)
        self.assertIn("CREATE2 deployer", err)
        self.assertEqual(self.chain.sent, [])
        self.chain.put_code("create2-deployer")
        code, out, err = self.run_it("--only", "permit2")
        self.assertEqual(code, 0, err + out)
        self.assertEqual(self.hash_at("permit2"), deploy.expected_hash(ENTRIES["permit2"], CHAIN_ID))

    def test_a_key_file_that_others_can_read_is_refused(self):
        os.chmod(self.key_file, 0o644)
        code, out, err = self.run_it("--dry-run")
        self.assertEqual(code, 1)
        self.assertIn("chmod 600", err)

    def test_a_node_that_refuses_transactions_not_tied_to_a_chain_gets_a_hint(self):
        chain = FakeChain(refuse_unprotected=True)
        threading.Thread(target=chain.serve_forever, daemon=True).start()
        try:
            code, out, err = self.run_it(chain=chain)
        finally:
            chain.shutdown()
            chain.server_close()
        self.assertEqual(code, 1)
        self.assertIn("chain's own reth RPC", err)
        self.assertEqual(chain.sent, [])   # the probe stopped the run before any signer was funded
        self.assertEqual(chain.balance, {FUNDING.lower(): 10**19})

    def test_a_node_that_refuses_them_stops_before_funding_multicall3_too(self):
        chain = FakeChain(refuse_unprotected=True)
        chain.put_code("create2-deployer")
        threading.Thread(target=chain.serve_forever, daemon=True).start()
        try:
            code, out, err = self.run_it("--only", "multicall3", chain=chain)
        finally:
            chain.shutdown()
            chain.server_close()
        self.assertEqual(code, 1)
        self.assertIn("Nothing was funded", err)
        self.assertEqual(chain.sent, [])
        self.assertEqual(chain.balance.get(ENTRIES["multicall3"]["signer"].lower(), 0), 0)

    def test_a_key_file_only_its_owner_can_read_is_taken_whatever_the_owner_bits(self):
        for mode in (0o400, 0o600):
            os.chmod(self.key_file, mode)
            code, out, err = self.run_it("--dry-run")
            self.assertEqual(code, 0, err)
        for mode in (0o640, 0o604, 0o660, 0o601):
            os.chmod(self.key_file, mode)
            code, out, err = self.run_it("--dry-run")
            self.assertEqual(code, 1, oct(mode))
            self.assertIn("chmod 600", err)

    def test_a_funding_account_with_a_transaction_in_the_pool_is_refused(self):
        self.chain.pending[FUNDING.lower()] = 1
        code, out, err = self.run_it()
        self.assertEqual(code, 1)
        self.assertIn("waiting in the node's pool", err)
        self.assertEqual(self.chain.sent, [])
        self.chain.pending.clear()
        code, out, err = self.run_it()
        self.assertEqual(code, 0, err + out)

    def test_other_code_that_got_to_the_address_first_is_reported_as_such(self):
        chain = FakeChain(frontrun="multicall3")
        chain.put_code("create2-deployer")
        threading.Thread(target=chain.serve_forever, daemon=True).start()
        try:
            code, out, err = self.run_it("--only", "multicall3", chain=chain)
        finally:
            chain.shutdown()
            chain.server_close()
        self.assertEqual(code, 1)
        self.assertIn("now has code with hash", err)
        self.assertIn("other code was deployed there first", err)


if __name__ == "__main__":
    unittest.main()
