"""Tests for demo/twin.py with small fakes of Ostia (demo/evm.py's rpc and send) and the Ledger API. Run: python3 -m unittest tests/test_demo_twin.py"""
import json, os, sys, unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "demo"))
import canton, evm, twin
sys.path.insert(0, str(ROOT / "demo" / "tests"))
from test_canton import FakeLedger, LedgerTestCase

RUNTIME = twin.VAULT_CODE.read_text().strip()
VAULT = "0x" + "5a" * 20


def run_creation_code(init: bytes) -> bytes:
    """The few opcodes of the creation prefix, run for real: PUSH1, PUSH2, DUP1, CODECOPY and RETURN. What RETURN gives is the code the chain would keep."""
    stack, memory, pc = [], bytearray(), 0
    while True:
        op = init[pc]
        if op == 0x60:
            stack.append(init[pc + 1]); pc += 2
        elif op == 0x61:
            stack.append(int.from_bytes(init[pc + 1:pc + 3], "big")); pc += 3
        elif op == 0x80:
            stack.append(stack[-1]); pc += 1
        elif op == 0x39:   # CODECOPY(destOffset, offset, size)
            dest, offset, size = stack.pop(), stack.pop(), stack.pop()
            memory[dest:dest + size] = init[offset:offset + size]; pc += 1
        elif op == 0xF3:   # RETURN(offset, size)
            offset, size = stack.pop(), stack.pop()
            return bytes(memory[offset:offset + size])
        else:
            raise AssertionError(f"opcode {op:#x} at {pc} is not one the prefix uses")


class FakeOstia:
    """reth's answers for one creation: the transaction it was sent, and the receipt and the code that follow. `code` is what ends up at the address."""
    def __init__(self, code: bytes = None, status: int = 1, pending: int = 0):
        self.code, self.status, self.pending, self.sent, self.calls = code, status, pending, [], []

    def send(self, folder, who, to, data, gas, *rest):
        self.sent.append({"who": who, "to": to, "data": data, "gas": gas})
        if self.code is None:
            self.code = run_creation_code(bytes.fromhex(data))
        return "0x" + "ab" * 32

    def rpc(self, method, params):
        self.calls.append(method)
        if method == "eth_getTransactionReceipt":
            if self.pending:
                self.pending -= 1
                return None
            return {"blockNumber": hex(7), "blockHash": "0x" + "bb" * 32, "gasUsed": hex(412345), "status": hex(self.status), "contractAddress": "0x" + "5A" * 20}
        if method == "eth_getCode":
            return "0x" + self.code.hex()
        raise AssertionError(method)


class DeployVaultTests(unittest.TestCase):
    def setUp(self):
        self.ostia = FakeOstia()
        os.environ["CZE_POLL_SECONDS"] = "0"
        for patcher in (mock.patch.object(evm, "send", self.ostia.send), mock.patch.object(evm, "rpc", self.ostia.rpc),
                        mock.patch.object(evm, "state_dir", lambda: Path("/nowhere"))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_the_prefix_returns_exactly_the_runtime_code(self):
        code = bytes.fromhex(RUNTIME)
        init = bytes.fromhex(twin.creation_code(code))
        self.assertEqual(init[:twin.PREFIX_BYTES].hex(), "61" + len(code).to_bytes(2, "big").hex() + "80600c6000396000f3")
        self.assertEqual(init[twin.PREFIX_BYTES:], code)
        self.assertEqual(len(init), twin.PREFIX_BYTES + len(code))
        self.assertEqual(run_creation_code(init), code)

    def test_the_prefix_works_for_any_length(self):
        for size in (1, 255, 256, 3056, 24576):
            code = bytes(range(256)) * (size // 256) + bytes(range(size % 256))
            self.assertEqual(run_creation_code(bytes.fromhex(twin.creation_code(code))), code)

    def test_deploy_is_sent_by_u_with_no_to_and_reports_the_code(self):
        got = twin.main(["deploy-vault"])
        [sent] = self.ostia.sent
        self.assertEqual((sent["who"], sent["to"], sent["data"]), ("u", None, twin.creation_code(bytes.fromhex(RUNTIME))))
        self.assertEqual(got, {"address": VAULT, "tx": "0x" + "ab" * 32, "block": 7, "gasUsed": 412345, "codeHash": "0x" + evm.keccak(bytes.fromhex(RUNTIME)).hex()})

    def test_it_waits_for_the_receipt(self):
        self.ostia.pending = 3
        self.assertEqual(twin.main(["deploy-vault"])["block"], 7)
        self.assertEqual(self.ostia.calls.count("eth_getTransactionReceipt"), 5)   # three empty, one here, one in evm.receipt_of

    def test_other_code_at_the_address_fails(self):
        self.ostia.code = bytes.fromhex(RUNTIME)[:-1] + b"\x00"
        with self.assertRaisesRegex(canton.Fail, "not gateway/Vault.bin-runtime"):
            twin.main(["deploy-vault"])

    def test_a_reverted_creation_fails(self):
        self.ostia.status = 0
        with self.assertRaisesRegex(canton.Fail, "did not make a contract"):
            twin.main(["deploy-vault"])

    def test_a_runtime_file_that_is_not_hex_fails(self):
        with mock.patch.object(twin, "VAULT_CODE", ROOT / "README.md"), self.assertRaisesRegex(canton.Fail, "cannot read the vault's runtime code"):
            twin.main(["deploy-vault"])


TOKEN = "ab" * 20


class FakeToken:
    """An ERC-20 on Ostia: what name(), symbol() and decimals() give at the finalized block. `decimals` None is an address with no code."""
    def __init__(self, name="Tether USD", symbol="USDT", decimals=6):
        self.name, self.symbol, self.decimals, self.reads = name, symbol, decimals, []

    def read_text(self, token, signature, tag):
        self.reads.append((token, signature, tag))
        return None if self.decimals is None else {"name()": self.name, "symbol()": self.symbol}[signature]

    def rpc(self, method, params):
        assert method == "eth_call" and params[0]["data"] == "0x313ce567", (method, params)
        self.reads.append((params[0]["to"], "decimals()", params[1]))
        return "0x" if self.decimals is None else f"0x{self.decimals:064x}"


class TwinTestCase(LedgerTestCase):
    def setUp(self):
        super().setUp()
        self.token = FakeToken()
        for patcher in (mock.patch.object(evm, "read_text", self.token.read_text), mock.patch.object(evm, "rpc", self.token.rpc)):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.net = canton.Network()


class RulesTests(TwinTestCase):
    def test_the_gateway_party_makes_the_rules_from_what_the_token_says(self):
        got = twin.rules(self.net, "0x" + TOKEN.upper())
        [made] = self.made(twin.TWIN_RULES)
        self.assertEqual(made, {"admin": "gw::1", "token": TOKEN, "name": "Tether USD", "symbol": "USDT", "decimals": "6"})
        [(node, body)] = FakeLedger.submitted
        self.assertEqual((node, body["actAs"], body["userId"]), ("operator", ["gw::1"], "operator"))
        self.assertEqual(got, {"created": True, "contractId": "cid-1", "admin": "gw::1", "token": TOKEN, "name": "Tether USD", "symbol": "USDT", "decimals": 6,
                               "instrument": "erc20:" + TOKEN})
        self.assertEqual({tag for _, _, tag in self.token.reads}, {"finalized"})

    def test_a_second_run_changes_nothing_and_prints_the_existing_rules(self):
        first = twin.rules(self.net, TOKEN)
        self.token.name = "Another name"   # not read again
        second = twin.rules(self.net, "0x" + TOKEN)
        self.assertEqual(len(FakeLedger.submitted), 1)
        self.assertEqual(second, {**first, "created": False})

    def test_rules_of_another_admin_or_token_are_not_the_ones(self):
        mine = {"admin": "gw::1", "token": "cd" * 20, "name": "n", "symbol": "s", "decimals": "18"}
        FakeLedger.contracts[("gw::1", twin.TWIN_RULES)] = [{"contractId": "other-token", "offset": 1, "createArgument": mine},
                                                            {"contractId": "other-admin", "offset": 2, "createArgument": {**mine, "admin": "x::1", "token": TOKEN}}]
        self.assertEqual(twin.rules(self.net, TOKEN)["contractId"], "cid-1")
        self.assertEqual(len(FakeLedger.submitted), 1)

    def test_a_token_that_is_not_there_makes_nothing(self):
        self.token.decimals = None
        with self.assertRaisesRegex(canton.Fail, "no name"):
            twin.rules(self.net, TOKEN)
        self.assertEqual(FakeLedger.submitted, [])

    def test_a_token_with_no_decimals_or_too_many_makes_nothing(self):
        self.token.decimals = 37
        with self.assertRaisesRegex(canton.Fail, "37 decimals"):
            twin.rules(self.net, TOKEN)
        self.token.name = ""
        with self.assertRaisesRegex(canton.Fail, "empty"):
            twin.rules(self.net, TOKEN)
        self.assertEqual(FakeLedger.submitted, [])

    def test_two_rules_for_one_token_are_refused(self):
        row = {"admin": "gw::1", "token": TOKEN, "name": "n", "symbol": "s", "decimals": "6"}
        FakeLedger.contracts[("gw::1", twin.TWIN_RULES)] = [{"contractId": f"r{i}", "offset": i, "createArgument": row} for i in (1, 2)]
        with self.assertRaisesRegex(canton.Fail, "2 TwinRules"):
            twin.rules(self.net, TOKEN)

    def test_main_takes_one_address(self):
        self.assertEqual(twin.main(["rules", TOKEN])["contractId"], "cid-1")
        for argv in (["rules"], ["rules", TOKEN, "x"], ["rules", "nope"]):
            with self.assertRaises(SystemExit):
                twin.main(argv)


if __name__ == "__main__":
    unittest.main()
