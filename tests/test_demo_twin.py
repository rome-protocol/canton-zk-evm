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
        self.balances = {}   # holder address (40 lowercase hex digits) -> balanceOf, in base units

    def read_text(self, token, signature, tag):
        self.reads.append((token, signature, tag))
        return None if self.decimals is None else {"name()": self.name, "symbol()": self.symbol}[signature]

    def rpc(self, method, params):
        data = params[0]["data"]
        assert method == "eth_call" and data[:10] in ("0x313ce567", "0x70a08231"), (method, params)
        if data.startswith("0x70a08231"):
            self.reads.append((params[0]["to"], "balanceOf", params[1], data[-40:]))
            return f"0x{self.balances[data[-40:]]:064x}"
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
        self.assertEqual({read[2] for read in self.token.reads}, {"finalized"})

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


class DisclosedTests(TwinTestCase):
    def test_the_file_is_one_disclosed_contract_as_setup_reads_it(self):
        made = twin.rules(self.net, TOKEN)
        out = self.state / "rules.json"
        got = twin.main(["disclosed", "0x" + TOKEN, str(out)])
        self.assertEqual(json.loads(out.read_text()), {"templateId": twin.TWIN_RULES, "contractId": made["contractId"], "createdEventBlob": "blob-1", "synchronizerId": "sync::1"})
        self.assertEqual(out.stat().st_mode & 0o777, 0o644)
        self.assertEqual(got["contractId"], made["contractId"])

    def test_the_blob_is_asked_for(self):
        twin.rules(self.net, TOKEN)
        with mock.patch.object(canton.Network, "template", autospec=True, side_effect=canton.Network.template) as template:
            twin.disclosed(self.net, TOKEN, str(self.state / "rules.json"))
        template.assert_called_once_with(self.net, "operator", "gateway", twin.TWIN_RULES, blob=True)

    def test_it_is_what_setup_py_accepts(self):
        sys.path.insert(0, str(ROOT / "network" / "external"))
        import setup
        made = twin.rules(self.net, TOKEN)
        out = self.state / "rules.json"
        twin.disclosed(self.net, TOKEN, str(out))
        self.assertEqual(setup.read_rules_disclosed(str(out), made["contractId"])["contractId"], made["contractId"])

    def test_a_file_that_is_there_is_replaced_and_opened_up(self):
        twin.rules(self.net, TOKEN)
        out = self.state / "rules.json"
        out.write_text("old")
        out.chmod(0o600)
        twin.disclosed(self.net, TOKEN, str(out))
        self.assertEqual(out.stat().st_mode & 0o777, 0o644)
        self.assertEqual(json.loads(out.read_text())["contractId"], "cid-1")

    def test_no_rules_or_no_blob_writes_nothing(self):
        out = self.state / "rules.json"
        with self.assertRaisesRegex(canton.Fail, "found 0"):
            twin.disclosed(self.net, TOKEN, str(out))
        FakeLedger.contracts[("gw::1", twin.TWIN_RULES)] = [{"contractId": "r1", "offset": 1, "templateId": twin.TWIN_RULES,
                                                            "createArgument": {"admin": "gw::1", "token": TOKEN, "name": "n", "symbol": "s", "decimals": "6"}}]
        with self.assertRaisesRegex(canton.Fail, "without createdEventBlob"):
            twin.disclosed(self.net, TOKEN, str(out))
        self.assertFalse(out.exists())


U, V, GW = "u::1", "v::1", "gw::1"
VAULT_A, VAULT_B = "a1" * 20, "b2" * 20


def holding(owner, amount, token=TOKEN, admin=GW):
    return {"contractId": f"h-{owner}-{amount}", "offset": 1, "createArgument": {"admin": admin, "owner": owner, "token": token, "amount": amount, "meta": {"values": {}}}}


def allocation(sender, amount, token=TOKEN, admin=GW):
    leg = {"sender": sender, "receiver": "x::1", "amount": amount, "instrumentId": {"admin": admin, "id": "erc20:" + token}}
    return {"contractId": f"a-{sender}-{amount}", "offset": 1, "createArgument": {"admin": admin, "token": token, "allocation": {"transferLeg": leg}}}


class BalancesTests(TwinTestCase):
    def setup_twin(self, decimals, held, vaults, locked=(), kinds=("Vault", "Vault")):
        """A twin of `decimals` decimals with these holdings (and allocations) on the ledger, and these vault balances (base units) on Ostia."""
        self.token.decimals = decimals
        FakeLedger.contracts[(GW, twin.TWIN_HOLDING)] = list(held)
        FakeLedger.contracts[(GW, twin.TWIN_ALLOCATION)] = list(locked)
        registry = [{"contractAddress": a, "contractCodeHash": "00" * 32, "contractKind": k} for a, k in zip((VAULT_A, VAULT_B), kinds)]
        FakeLedger.contracts[("op::1", canton.CHAIN + "ZkChain")][0]["createArgument"] = {**FakeLedger.contracts[("op::1", canton.CHAIN + "ZkChain")][0]["createArgument"], "contracts": registry}
        self.token.balances = dict(zip((VAULT_A, VAULT_B), vaults))

    def test_six_decimals(self):
        self.setup_twin(6, [holding(U, "2.5000000000"), holding(U, "0.0000010000"), holding(V, "1.0000000000")], [3_500_001, 0])
        got = twin.main(["balances", "0x" + TOKEN])
        self.assertEqual(got["holders"], {"u": {"party": U, "amount": "2.500001"}, "v": {"party": V, "amount": "1.0"}})
        self.assertEqual((got["supply"], got["vaultsTotal"], got["supplyMatches"]), ("3.500001", "3.500001", True))
        self.assertEqual(got["vaults"], [{"address": "0x" + VAULT_A, "baseUnits": "3500001", "amount": "3.500001"}, {"address": "0x" + VAULT_B, "baseUnits": "0", "amount": "0.0"}])
        self.assertEqual((got["token"], got["instrument"], got["admin"], got["decimals"]), ("0x" + TOKEN, "erc20:" + TOKEN, GW, 6))

    def test_ten_decimals_are_the_twin_amount(self):
        self.setup_twin(10, [holding(U, "12.3456789012")], [123_456_789_012, 0])
        got = twin.balances(self.net, TOKEN, [])
        self.assertEqual((got["supply"], got["vaultsTotal"], got["supplyMatches"]), ("12.3456789012", "12.3456789012", True))
        self.assertEqual(got["holders"]["v"]["amount"], "0.0")

    def test_eighteen_decimals_split_over_two_vaults(self):
        self.setup_twin(18, [holding(U, "7.0")], [5 * 10**18, 2 * 10**18 + 10**8])
        got = twin.balances(self.net, TOKEN, ["u"])
        self.assertEqual(list(got["holders"]), ["u"])
        self.assertEqual((got["supply"], got["vaultsTotal"]), ("7.0", "7.0000000001"))
        self.assertFalse(got["supplyMatches"])   # the second vault holds one twin unit more than the twin's supply

    def test_a_mismatch(self):
        self.setup_twin(6, [holding(U, "1.0")], [900_000, 0])
        got = twin.balances(self.net, TOKEN, ["u", "v"])
        self.assertEqual((got["supply"], got["vaultsTotal"], got["supplyMatches"]), ("1.0", "0.9", False))

    def test_the_supply_counts_allocations_and_other_parties_and_leaves_out_other_twins(self):
        other = holding(V, "5.0", token="cd" * 20)
        self.setup_twin(6, [holding(U, "1.0"), holding("w::1", "2.0"), other, holding(V, "9.0", admin="x::1")], [4_000_000, 0], locked=[allocation(V, "1.0"), allocation(V, "3.0", token="cd" * 20)])
        got = twin.balances(self.net, TOKEN, ["u", "v", "w::1"])
        self.assertEqual({k: v["amount"] for k, v in got["holders"].items()}, {"u": "1.0", "v": "0.0", "w::1": "2.0"})
        self.assertEqual((got["supply"], got["lockedInAllocations"], got["supplyMatches"]), ("4.0", "1.0", True))

    def test_only_vaults_count(self):
        self.setup_twin(6, [], [0, 1_000_000], kinds=("Gateway", "Vault"))
        got = twin.balances(self.net, TOKEN, [])
        self.assertEqual([v["address"] for v in got["vaults"]], ["0x" + VAULT_B])
        self.assertEqual((got["supply"], got["vaultsTotal"], got["supplyMatches"]), ("0.0", "1.0", False))

    def test_no_registry_and_no_twin_match_at_zero(self):
        self.setup_twin(6, [], [])
        chain = FakeLedger.contracts[("op::1", canton.CHAIN + "ZkChain")][0]["createArgument"]
        chain["contracts"] = None
        got = twin.balances(self.net, TOKEN, [])
        self.assertEqual((got["vaults"], got["supply"], got["vaultsTotal"], got["supplyMatches"]), ([], "0.0", "0.0", True))

    def test_a_vault_amount_a_twin_cannot_hold_stops_the_command(self):
        self.setup_twin(18, [], [10**8 + 1, 0])   # 10^-10 plus 10^-18: finer than a twin amount
        with self.assertRaisesRegex(canton.Fail, "finer than a twin amount"):
            twin.balances(self.net, TOKEN, [])
        self.setup_twin(6, [], [10**23, 0])   # 10^17 whole units
        with self.assertRaisesRegex(canton.Fail, "above 10"):
            twin.balances(self.net, TOKEN, [])

    def test_conversions_are_exact(self):
        self.assertEqual(twin.twin_units(1, 6, "x"), 10**4)
        self.assertEqual(twin.twin_units(1, 10, "x"), 1)
        self.assertEqual(twin.twin_units(10**8, 18, "x"), 1)
        self.assertEqual(twin.twin_units(10**17 * 10**6 - 1, 6, "x") % 10**4, 0)
        self.assertEqual(twin.twin_units(0, 36, "x"), 0)
        for base, decimals in ((10**17 * 10**6, 6), (10**27, 10), (10**17 * 10**18, 18), (10**8 - 1, 18)):
            with self.assertRaises(canton.Fail):
                twin.twin_units(base, decimals, "x")
        self.assertEqual(twin.ledger_units("0.0000000001"), 1)
        self.assertEqual(twin.ledger_units("10"), 10**11)
        for bad in ("-1.0", "0.00000000001"):
            with self.assertRaises(canton.Fail):
                twin.ledger_units(bad)

    def test_a_party_is_u_v_or_an_id(self):
        self.setup_twin(6, [], [0, 0])
        for who in (["x"], ["U"]):
            with self.assertRaises(SystemExit):
                twin.balances(self.net, TOKEN, who)
        with self.assertRaises(SystemExit):
            twin.main(["balances"])


if __name__ == "__main__":
    unittest.main()
