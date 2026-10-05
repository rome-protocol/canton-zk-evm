"""Tests for demo/evm.py with a fake reth (the HTTP JSON-RPC port only). Run: python3 -m unittest discover -s demo/tests"""
import http.server, json, os, shutil, stat, sys, tempfile, threading, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import evm
from eth_abi import decode
from eth_account import Account
from eth_account.typed_transactions import TypedTransaction
from eth_utils import keccak
from hexbytes import HexBytes

TOKEN = "0x" + "ab" * 20   # letters: reth reports addresses in lower case and the signer wants them checksummed
WRAPPED = "0x" + "cd" * 20
PINS = dict(line.split("=", 1) for line in (evm.ROOT / "PINS").read_text().splitlines() if "=" in line and not line.startswith("#"))
GATEWAY = PINS["GATEWAY_ADDRESS"]
ID = "ab" * 32
PARTY = "u::1220" + "ee" * 32


def selector(signature: str) -> str:
    return keccak(text=signature)[:4].hex()


class FakeReth(http.server.BaseHTTPRequestHandler):
    calls: list = []
    receipt = None

    def log_message(self, *args):
        pass

    @staticmethod
    def call_result(to: str, data: str) -> str:
        """What reth answers an eth_call, by the function called."""
        if data[2:10] == selector("register(string,string)"):
            return "0x" + WRAPPED[2:].rjust(64, "0")                  # the address the next registration would make
        if data[2:10] == selector("totalSupply()"):
            return hex(25 * 10**9)                                    # 2.5 wrapped tokens, in base units
        if data[2:10] == selector("balanceOf(address)"):
            return hex(4 * 10**10) if to.lower() == WRAPPED else hex(7 * evm.ONE)   # 4 wrapped tokens, or 7 TKA
        raise AssertionError(f"unexpected call {data}")

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["content-length"])))
        FakeReth.calls.append(req)
        m = req["method"]
        result = {"eth_chainId": hex(770101), "eth_getTransactionCount": "0x2", "eth_sendRawTransaction": "0x" + "ab" * 32,
                  "eth_getTransactionReceipt": FakeReth.receipt,
                  "eth_call": self.call_result(req["params"][0]["to"], req["params"][0]["data"]) if m == "eth_call" else None}[m]
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
        folder = Path(self.tmp.name) / "demo"
        for who in ("v", "u"):
            key_file = folder / f"{who}.key"
            self.assertEqual(stat.S_IMODE(key_file.stat().st_mode), 0o600)
            self.assertEqual(Account.from_key("0x" + key_file.read_text().strip()).address, a[who])
            self.assertNotIn(key_file.read_text().strip(), json.dumps(a))   # the key is never in what is printed
        self.assertNotEqual(a["u"], a["v"])
        self.assertEqual(evm.main(["keys"]), a)                     # a second run keeps them
        self.assertEqual({p.name for p in folder.iterdir()}, {"v.key", "u.key", "addresses.json"})

    def test_a_folder_with_only_some_of_the_files_is_refused(self):
        for lost in ("addresses.json", "u.key", "v.key"):
            with self.subTest(lost=lost):
                shutil.rmtree(Path(self.tmp.name) / "demo", ignore_errors=True)
                evm.main(["keys"])
                (Path(self.tmp.name) / "demo" / lost).unlink()
                with self.assertRaises(SystemExit):
                    evm.main(["keys"])

    def test_genesis_funds_u_and_v_and_leaves_the_rest(self):
        out = evm.main(["genesis"])
        funded = json.loads(Path(out["genesis"]).read_text())
        base = json.loads((evm.ROOT / "network" / "genesis.json").read_text())
        self.assertEqual(funded["config"], base["config"])           # the chain rules are the pinned ones
        a = evm.main(["keys"])
        self.assertEqual(out["funded"], [a["v"], a["u"]])
        two = {a[who].lower().removeprefix("0x") for who in ("v", "u")}
        for address in two:
            self.assertEqual(funded["alloc"][address], {"balance": hex(10 * evm.ONE)})
        self.assertEqual({k: x for k, x in funded["alloc"].items() if k not in two}, base["alloc"])
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

    def sent(self, who: str):
        """The one transaction sent: (its decoded fields, whether `who` signed it)."""
        raw = self.raw_sent()
        self.assertEqual(Account.recover_transaction(raw), evm.main(["keys"])[who])
        tx = TypedTransaction.from_bytes(HexBytes(raw)).as_dict()
        return ("0x" + bytes(tx["to"]).hex() if tx.get("to") else None), bytes(tx["data"]).hex(), tx["gas"]

    def test_register_sends_the_gateway_a_wrapped_token_to_make_and_says_where_it_will_be(self):
        out = evm.main(["register", "v", "Wrapped TKB", "wTKB"])
        to, data, _ = self.sent("v")
        self.assertEqual(to, GATEWAY)
        self.assertEqual(data[:8], selector("register(string,string)"))
        self.assertEqual(decode(["string", "string"], bytes.fromhex(data[8:])), ("Wrapped TKB", "wTKB"))
        self.assertEqual(out, {"tx": "0x" + "ab" * 32, "token": WRAPPED})   # the address eth_call said the registration makes

    def test_claim_is_sent_by_the_recipient_in_base_units(self):
        evm.main(["claim", "u", ID, WRAPPED, "10"])
        to, data, _ = self.sent("u")
        self.assertEqual(to, GATEWAY)
        self.assertEqual(data[:8], selector("claim(bytes32,address,uint256)"))
        i, token, amount = decode(["bytes32", "address", "uint256"], bytes.fromhex(data[8:]))
        self.assertEqual((i.hex(), token.lower(), amount), (ID, WRAPPED, 10 * 10**10))

    def test_withdraw_is_sent_by_the_holder_with_the_party_text(self):
        evm.main(["withdraw", "u", WRAPPED, "0.4", PARTY])
        to, data, _ = self.sent("u")
        self.assertEqual(to, GATEWAY)
        self.assertEqual(data[:8], selector("withdraw(address,uint256,string)"))
        token, amount, party = decode(["address", "uint256", "string"], bytes.fromhex(data[8:]))
        self.assertEqual((token.lower(), amount, party), (WRAPPED, 4 * 10**9, PARTY))

    def test_pay_is_sent_by_the_payer_with_the_payment_id(self):
        u = evm.main(["keys"])["u"]
        evm.main(["pay", "v", ID, TOKEN, u, "10"])
        to, data, _ = self.sent("v")
        self.assertEqual(to, GATEWAY)
        self.assertEqual(data[:8], selector("pay(bytes32,address,address,uint256)"))
        i, token, payee, amount = decode(["bytes32", "address", "address", "uint256"], bytes.fromhex(data[8:]))
        self.assertEqual((i.hex(), token.lower(), payee.lower(), amount), (ID, TOKEN, u.lower(), 10 * evm.ONE))

    def test_approve_names_the_gateway_by_its_word(self):
        evm.main(["approve", "v", TOKEN, "gateway", "10"])
        to, data, _ = self.sent("v")
        self.assertEqual(to, TOKEN)
        self.assertEqual(data[:8], selector("approve(address,uint256)"))
        spender, amount = decode(["address", "uint256"], bytes.fromhex(data[8:]))
        self.assertEqual((spender.lower(), amount), (GATEWAY, 10 * evm.ONE))
        FakeReth.calls.clear()
        evm.main(["approve", "v", TOKEN, "0x" + "11" * 20, "0"])   # an approval back to zero is allowed
        _, data, _ = self.sent("v")
        self.assertEqual(decode(["address", "uint256"], bytes.fromhex(data[8:])), ("0x" + "11" * 20, 0))

    def test_every_transaction_has_a_gas_limit_the_block_can_take(self):
        for argv in (["register", "v", "n", "s"], ["claim", "u", ID, WRAPPED, "1"], ["withdraw", "u", WRAPPED, "1", PARTY],
                     ["pay", "v", ID, TOKEN, TOKEN, "1"], ["approve", "v", TOKEN, "gateway", "1"]):
            FakeReth.calls.clear()
            evm.main(argv)
            *_, gas = self.sent(argv[1])
            self.assertTrue(21_000 < gas <= 3_000_000, argv[0])

    def test_wrapped_amounts_are_exact(self):
        self.assertEqual(evm.wrapped_units("10"), 10**11)
        self.assertEqual(evm.wrapped_units("0.0000000001"), 1)
        self.assertEqual(evm.wrapped_units("1234.5"), 12345 * 10**9)
        self.assertEqual([evm.wrapped_text(n) for n in (10**11, 1, 12345 * 10**9, 0)], ["10.0", "0.0000000001", "1234.5", "0.0"])
        for bad in ("0", "0.0", "-1", "1.00000000001", "1e3", "", ".5", "1.", " 1", "0x10", "1\n"):
            with self.assertRaises(SystemExit, msg=bad):
                evm.wrapped_units(bad)

    def test_wrong_arguments_are_refused_before_anything_is_sent(self):
        bad = (["claim", "u", ID, WRAPPED, "0"], ["claim", "x", ID, WRAPPED, "1"], ["claim", "u", "ab" * 31, WRAPPED, "1"],
               ["claim", "u", ID.upper(), WRAPPED, "1"], ["claim", "u", ID + "\n", WRAPPED, "1"], ["claim", "u", ID, "0x12", "1"], ["withdraw", "u", WRAPPED, "1", ""],
               ["pay", "v", ID, TOKEN, TOKEN, "0"], ["pay", "v", ID, TOKEN, "nobody", "1"], ["pay", "v", "0x" + ID, TOKEN, TOKEN, "1"],
               ["approve", "v", TOKEN, "gateway", "-1"], ["approve", "v", TOKEN, "somebody", "1"], ["register", "v", "", "wTKB"], ["register", "v", "n"])
        for argv in bad:
            with self.assertRaises(SystemExit, msg=str(argv)):
                evm.main(argv)
        self.assertEqual([c for c in FakeReth.calls if c["method"] == "eth_sendRawTransaction"], [])

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

    def test_wrapped_balance_and_supply_are_read_at_the_block_asked_for(self):
        self.assertEqual(evm.main(["wrapped", WRAPPED, "0x" + "22" * 20]), {"balance": "4.0", "supply": "2.5"})
        self.assertEqual({c["params"][1] for c in FakeReth.calls if c["method"] == "eth_call"}, {"latest"})
        FakeReth.calls.clear()
        evm.main(["wrapped", WRAPPED, "0x" + "22" * 20, "finalized"])
        self.assertEqual({c["params"][1] for c in FakeReth.calls if c["method"] == "eth_call"}, {"finalized"})
        with self.assertRaises(SystemExit):
            evm.main(["wrapped", WRAPPED, "0x" + "22" * 20, "pending"])


if __name__ == "__main__":
    unittest.main()
