"""Tests for demo/evm.py on a chain that is already running: the RPC URL setting, keys without a genesis, the wrap helper, and the commands that wait
for a block Canton has committed. A fake chain answers the JSON-RPC. Run: python3 -m unittest discover -s demo/tests"""
import http.server, json, os, sys, tempfile, threading, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import evm
from eth_account import Account
from eth_account.typed_transactions import TypedTransaction
from eth_utils import keccak
from hexbytes import HexBytes

WTROME = "0x" + "c9" * 20
PINS = dict(line.split("=", 1) for line in (evm.ROOT / "PINS").read_text().splitlines() if "=" in line and not line.startswith("#"))
GATEWAY = PINS["GATEWAY_ADDRESS"]
CODE = bytes.fromhex("6080604052")


def selector(signature: str) -> str:
    return keccak(text=signature)[:4].hex()


def block(number, **extra):
    return {"number": hex(number), "hash": "0x" + f"{number:064x}", "gasUsed": hex(21000 * number), "transactions": [], **extra}


class FakeChain(http.server.BaseHTTPRequestHandler):
    """The state is a dict set by each test: receipts (tx -> list of answers, the last repeating), blocks (number -> block), finalized (a number)."""
    calls: list = []
    receipts: dict = {}
    blocks: dict = {}
    finalized = 0
    paths: list = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        FakeChain.paths.append(self.path)
        req = json.loads(self.rfile.read(int(self.headers["content-length"])))
        FakeChain.calls.append(req)
        m, params = req["method"], req["params"]
        if m == "eth_getTransactionReceipt":
            answers = FakeChain.receipts.get(params[0], [None])
            result = answers.pop(0) if len(answers) > 1 else answers[0]
        elif m == "eth_getBlockByNumber":
            number = FakeChain.finalized if params[0] == "finalized" else FakeChain.finalized + 100 if params[0] == "latest" else int(params[0], 16)
            result = FakeChain.blocks.get(number)
        else:
            result = {"eth_chainId": "0x2f3b5", "eth_getTransactionCount": "0x4", "eth_sendRawTransaction": "0x" + "ab" * 32,
                      "eth_getBalance": hex(3 * evm.ONE + 5), "eth_getCode": "0x" + CODE.hex()}[m]
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": result}).encode()
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)


def receipt(number, status=1, tx="0x" + "ab" * 32):
    return {"blockNumber": hex(number), "blockHash": "0x" + f"{number:064x}", "gasUsed": hex(122308), "status": hex(status), "contractAddress": None}


class LiveEvmTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeChain)
        threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        patch = mock.patch.dict(os.environ, {"CZE_STATE_DIR": self.tmp.name, "CZE_RPC_URL": f"http://127.0.0.1:{server.server_address[1]}/rpc",
                                             "RETH_HTTP_PORT": "1", "CZE_POLL_SECONDS": "0.01"})   # reth's port is wrong: only CZE_RPC_URL can work
        patch.start()
        self.addCleanup(patch.stop)
        FakeChain.calls, FakeChain.receipts, FakeChain.blocks, FakeChain.finalized, FakeChain.paths = [], {}, {}, 0, []
        self.tx = "0x" + "ab" * 32

    def raw_sent(self):
        [raw] = [bytes.fromhex(c["params"][0][2:]) for c in FakeChain.calls if c["method"] == "eth_sendRawTransaction"]
        return raw

    # --- the RPC URL
    def test_the_rpc_url_setting_is_the_chain_that_is_asked(self):
        self.assertEqual(evm.main(["chain"]), {"chainId": 193461})
        self.assertEqual(set(FakeChain.paths), {"/rpc"})

    def test_without_the_setting_it_is_reths_port_on_this_machine(self):
        del os.environ["CZE_RPC_URL"]
        self.assertEqual(evm.rpc_url(), "http://127.0.0.1:1")
        os.environ["RETH_HTTP_PORT"] = "8546"
        self.assertEqual(evm.rpc_url(), "http://127.0.0.1:8546")
        del os.environ["RETH_HTTP_PORT"]
        self.assertEqual(evm.rpc_url(), "http://127.0.0.1:8545")

    # --- keys
    def test_keys_are_made_without_any_genesis_and_are_not_funded_by_it(self):
        a = evm.main(["keys"])
        self.assertEqual({p.name for p in (Path(self.tmp.name) / "demo").iterdir()}, {"v.key", "u.key", "addresses.json"})   # no genesis.json
        self.assertEqual(FakeChain.calls, [])                                                                            # and nothing asked of the chain
        self.assertEqual(evm.main(["keys"]), a)

    # --- wrap
    def test_wrap_sends_the_coin_with_deposit_to_the_wrapped_coin(self):
        a = evm.main(["keys"])
        out = evm.main(["wrap", "v", WTROME, "3"])
        self.assertEqual(out, {"tx": self.tx})
        raw = self.raw_sent()
        self.assertEqual(Account.recover_transaction(raw), a["v"])
        tx = TypedTransaction.from_bytes(HexBytes(raw)).as_dict()
        self.assertEqual("0x" + bytes(tx["to"]).hex(), WTROME)
        self.assertEqual((tx["value"], bytes(tx["data"]).hex(), tx["gas"]), (3 * evm.ONE, selector("deposit()"), evm.WRAP_GAS))
        self.assertEqual(evm.SELECTOR_DEPOSIT, selector("deposit()"))

    def test_other_transactions_still_carry_no_value(self):
        evm.main(["approve", "v", WTROME, "gateway", "1"])
        self.assertEqual(TypedTransaction.from_bytes(HexBytes(self.raw_sent())).as_dict()["value"], 0)

    def test_wrap_needs_a_sender_a_token_and_a_whole_amount(self):
        for argv in (["wrap", "w", WTROME, "1"], ["wrap", "v", "nobody", "1"], ["wrap", "v", WTROME, "0"], ["wrap", "v", WTROME, "1.5"], ["wrap", "v", WTROME]):
            with self.assertRaises(SystemExit, msg=argv):
                evm.main(argv)
        self.assertEqual([c for c in FakeChain.calls if c["method"] == "eth_sendRawTransaction"], [])

    # --- wait
    def test_wait_returns_when_the_block_is_finalized_and_is_the_one_in_the_receipt(self):
        FakeChain.receipts[self.tx] = [None, receipt(7)]
        FakeChain.blocks = {5: block(5), 7: block(7), 8: block(8)}
        FakeChain.finalized = 6
        threading.Timer(0.1, setattr, (FakeChain, "finalized", 8)).start()   # Canton commits it a moment later
        out = evm.main(["wait", self.tx, "20"])
        self.assertEqual((out["block"], out["status"], out["finalized"], out["blockHash"]), (7, 1, True, "0x" + f"{7:064x}"))

    def test_wait_keeps_waiting_when_the_block_at_that_number_is_another_one(self):
        FakeChain.receipts[self.tx] = [{**receipt(7), "blockHash": "0x" + "ee" * 32}]   # reth took the block back and made another
        FakeChain.blocks, FakeChain.finalized = {7: block(7)}, 7
        with self.assertRaises(SystemExit) as why:
            evm.main(["wait", self.tx, "1"])
        self.assertIn("not in a finalized block", str(why.exception))

    def test_wait_finds_the_transaction_again_in_another_block_after_a_refused_one(self):
        FakeChain.receipts[self.tx] = [receipt(7), None, receipt(8)]   # block 7 was refused and taken back; the transaction came again in 8
        FakeChain.blocks, FakeChain.finalized = {7: block(7), 8: block(8)}, 8
        FakeChain.blocks[7] = block(7, hash="0x" + "dd" * 32)
        self.assertEqual(evm.main(["wait", self.tx, "20"])["block"], 8)

    def test_wait_gives_up_and_says_where_the_transaction_is(self):
        FakeChain.receipts[self.tx] = [receipt(7)]
        FakeChain.blocks, FakeChain.finalized = {7: block(7), 3: block(3)}, 3
        with self.assertRaises(SystemExit) as why:
            evm.main(["wait", self.tx, "1"])
        self.assertIn("in block 7", str(why.exception))
        FakeChain.receipts[self.tx] = [None]
        with self.assertRaises(SystemExit) as why:
            evm.main(["wait", self.tx, "1"])
        self.assertIn("in no block", str(why.exception))

    def test_a_reverted_transaction_is_reported_not_hidden(self):
        FakeChain.receipts[self.tx] = [receipt(7, status=0)]
        FakeChain.blocks, FakeChain.finalized = {7: block(7), 9: block(9)}, 9
        self.assertEqual(evm.main(["wait", self.tx, "20"])["status"], 0)

    # --- legs
    def tx_to(self, to, signature, n=0):
        return {"hash": f"0x{n:064x}", "to": to, "input": "0x" + selector(signature) + "00" * 64}

    def test_legs_counts_the_gateway_calls_that_can_make_a_leg(self):
        FakeChain.blocks = {9: block(9, transactions=[
            self.tx_to(GATEWAY, "claim(bytes32,address,uint256)"), self.tx_to(GATEWAY.upper().replace("0X", "0x"), "pay(bytes32,address,address,uint256)", 1),
            self.tx_to(GATEWAY, "withdraw(address,uint256,string)", 2), self.tx_to(GATEWAY, "register(string,string)", 3),     # not a leg
            self.tx_to(WTROME, "withdraw(address,uint256,string)", 4), {"hash": "0x" + "0" * 64, "to": None, "input": "0x6080"}])}      # not the gateway; a creation
        self.assertEqual(evm.main(["legs", "9"]), {"block": 9, "legs": 3, "kinds": ["claim", "pay", "withdraw"]})
        self.assertEqual(evm.main(["legs", "9"])["legs"], 3)
        FakeChain.blocks = {9: block(9)}
        self.assertEqual(evm.main(["legs", "9"]), {"block": 9, "legs": 0, "kinds": []})
        with self.assertRaises(SystemExit):
            evm.main(["legs", "10"])

    # --- small reads
    def test_block_ether_and_code(self):
        FakeChain.blocks, FakeChain.finalized = {12: block(12), 4: block(4)}, 12
        self.assertEqual(evm.main(["block", "finalized"]), {"number": 12, "hash": "0x" + f"{12:064x}", "gasUsed": 21000 * 12})
        self.assertEqual(evm.main(["block", "4"])["number"], 4)
        with self.assertRaises(SystemExit):
            evm.main(["block", "99"])
        with self.assertRaises(SystemExit):
            evm.main(["block", "tomorrow"])
        self.assertEqual(evm.main(["ether", WTROME]), {"wei": 3 * evm.ONE + 5, "ether": 3})
        self.assertEqual(evm.main(["code", GATEWAY]), {"size": 5, "codeHash": "0x" + keccak(CODE).hex()})


if __name__ == "__main__":
    unittest.main()
