"""Tests for demo/twin.py with small fakes of Ostia (demo/evm.py's rpc and send) and the Ledger API. Run: python3 -m unittest tests/test_demo_twin.py"""
import hashlib, json, os, sys, unittest
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


class FakeEvm:
    """Ostia for the commands that send: the transactions that U's and V's keys sent (the nth has the hash 0x...n), their receipts, and the token's reads."""
    def __init__(self, token):
        self.token, self.sent, self.failing = token, [], set()

    def send(self, folder, who, to, data, gas, *rest):
        self.sent.append({"who": who, "to": to, "data": data, "gas": gas})
        return f"0x{len(self.sent):064x}"

    def rpc(self, method, params):
        if method == "eth_getTransactionReceipt":
            n = int(params[0], 16)
            return {"blockNumber": hex(100 + n), "blockHash": "0x" + "bb" * 32, "gasUsed": hex(50_000), "status": hex(0 if n in self.failing else 1)}
        return self.token.rpc(method, params)


GATEWAY = evm.gateway_address()
OTHER_VAULT = "c3" * 20
LOCK_ID_U = "3de42055cb6f3293c0ccfe04c71cf10d9ba24f0eb32b2ab404a8b553571d4a75"   # sha256 of the text lock,u::1,ref-1, worked out with shasum -a 256
LOCK_ID_UNICODE = "99d7e1661ca9e404504536505979a0fa093863ea1a4f89edeef1810637075e33"   # sha256 of the UTF-8 text lock,v::1220aa,\u00f6 ref
RELEASE_ID_A = "24b577158cdf638accf4c25056d4bc663fd56dc5cab917c656833dccc4fb764f"   # sha256 of the text vault-release,5a5a...5a,r-1 (the vault's 40 digits)
RELEASE_ID_B = "47c7cac8006bb2cfbc7ae7e3ae8182f40e20ab48e45fc6f55c5a382de5a96acd"   # sha256 of the text vault-release,a1a1...a1,0x0001


class ChainTestCase(TwinTestCase):
    """A twin of a 6-decimal token, a chain that has registered the vaults A and B, and Ostia that takes what is sent."""
    def setUp(self):
        super().setUp()
        self.evm = FakeEvm(self.token)
        for patcher in (mock.patch.object(evm, "rpc", self.evm.rpc), mock.patch.object(evm, "send", self.evm.send)):
            patcher.start()
            self.addCleanup(patcher.stop)
        chain = FakeLedger.contracts[("op::1", canton.CHAIN + "ZkChain")][0]
        chain["createArgument"] = {**chain["createArgument"], "contracts": [{"contractAddress": a, "contractCodeHash": "00" * 32, "contractKind": "Vault"} for a in (VAULT_A, VAULT_B)]}


def minted(owner, amount, reference, token=TOKEN, admin=GW, cid="minted-1"):
    """A TwinHolding as Mint makes it: the reference of the vault payment is in its metadata."""
    return {"contractId": cid, "offset": 1, "createArgument": {"admin": admin, "owner": owner, "token": token, "amount": amount,
                                                              "meta": {"values": {twin.MINT_REFERENCE: reference}}}}


class IdTests(unittest.TestCase):
    def test_lock_and_release_ids_match_vectors_worked_out_independently(self):
        self.assertEqual(twin.lock_id("u::1", "ref-1"), LOCK_ID_U)
        self.assertEqual(twin.lock_id("v::1220aa", "\u00f6 ref"), LOCK_ID_UNICODE)
        self.assertEqual(twin.release_id("5a" * 20, "r-1"), RELEASE_ID_A)
        self.assertEqual(twin.release_id(VAULT_A, "0x0001"), RELEASE_ID_B)

    def test_the_ids_are_of_different_domains(self):
        self.assertNotEqual(twin.lock_id("a", "b"), twin.release_id("a", "b"))
        self.assertEqual(len(LOCK_ID_U), 64)


class AmountTests(unittest.TestCase):
    def test_exact_conversions(self):
        for text, decimals, want in (("2.5", 6, 2_500_000), ("2.500000", 6, 2_500_000), ("2.50000000000", 6, 2_500_000), ("0.000001", 6, 1), ("7", 0, 7),
                                     ("1", 18, 10**18), ("0.0000000001", 18, 10**8), ("12", 10, 12 * 10**10), ("99999999999999999.999999", 6, 10**23 - 1)):
            self.assertEqual(twin.base_units(text, decimals), want, text)

    def test_a_fraction_of_a_base_unit_is_refused(self):
        for text, decimals in (("0.0000001", 6), ("1.5", 0), ("2.5000001", 6)):
            with self.assertRaisesRegex(canton.Fail, "not a whole number of base units"):
                twin.base_units(text, decimals)

    def test_zero_is_refused(self):
        for text in ("0", "0.0", "0.000000"):
            with self.assertRaisesRegex(canton.Fail, "more than zero"):
                twin.base_units(text, 6)

    def test_an_amount_that_is_not_a_twin_amount_is_refused(self):
        with self.assertRaisesRegex(canton.Fail, "finer than a twin amount"):
            twin.base_units("0.000000000000000001", 18)   # one base unit of 18 decimals
        with self.assertRaisesRegex(canton.Fail, "above 10"):
            twin.base_units("100000000000000000", 6)   # 10^17 whole units

    def test_what_is_not_a_decimal_number_is_refused(self):
        for text in ("", "-1", "+1", "1e3", "1,5", ".5", "5.", " 1", "1 ", "0x10", "1" * 81, "1.5.2", "\u0661"):
            with self.assertRaises(SystemExit, msg=text):
                twin.base_units(text, 6)


class LockTests(ChainTestCase):
    URL = "http://registry.example:8080"

    def setUp(self):
        super().setUp()
        self.posts, self.answer = [], {}
        FakeLedger.contracts[(GW, twin.TWIN_HOLDING)] = []
        patcher = mock.patch.object(twin, "post_json", self.post)
        patcher.start()
        self.addCleanup(patcher.stop)

    def post(self, url, body):
        self.posts.append((url, body))
        return {"lockId": twin.lock_id(body["receiver"], body["ref"]), "receiver": body["receiver"], "ref": body["ref"], "vaults": ["0x" + OTHER_VAULT], **self.answer}

    def lock(self, *args, **kw):
        return twin.lock(self.net, *(args or ("u", TOKEN, "2.5", "v", "ref-1")), self.URL, **kw)

    def holds(self, owner="v::1", amount="2.5", ref=None):
        FakeLedger.contracts[(GW, twin.TWIN_HOLDING)] = [minted(owner, amount, ref or twin.lock_id("v::1", "ref-1"))]

    def test_it_pays_the_lock_id_into_the_first_registered_vault_and_gives_the_holding(self):
        self.holds()
        got = self.lock()
        self.assertEqual(self.posts, [(self.URL + "/twin/v1/lock-parts", {"receiver": V, "ref": "ref-1", "token": TOKEN})])
        approve, pay = self.evm.sent
        self.assertEqual((approve["who"], approve["to"], approve["data"]), ("u", evm.address_of("0x" + TOKEN, "t"), evm.call_data("approve(address,uint256)", [GATEWAY, 2_500_000])))
        self.assertEqual((pay["who"], pay["to"]), ("u", GATEWAY))
        self.assertEqual(pay["data"], evm.call_data("pay(bytes32,address,address,uint256)", [bytes.fromhex(twin.lock_id(V, "ref-1")), evm.address_of("0x" + TOKEN, "t"), evm.address_of("0x" + VAULT_A, "v"), 2_500_000]))
        self.assertEqual(got, {"tx": f"0x{2:064x}", "block": 102, "approveTx": f"0x{1:064x}", "lockId": twin.lock_id(V, "ref-1"), "vault": "0x" + VAULT_A, "receiver": V,
                               "holding": "minted-1", "amount": "2.5"})

    def test_the_registrys_vaults_are_a_hint_and_the_ledgers_are_the_truth(self):
        self.holds()
        self.assertEqual(self.lock()["vault"], "0x" + VAULT_A)   # the registry's hint names OTHER_VAULT; it is not on the ledger
        self.assertNotIn(OTHER_VAULT, self.evm.sent[1]["data"])

    def test_a_vault_that_is_registered_can_be_named(self):
        self.holds()
        self.assertEqual(self.lock(vault="0x" + VAULT_B.upper())["vault"], "0x" + VAULT_B)
        self.assertIn(VAULT_B, self.evm.sent[1]["data"])

    def test_a_vault_that_is_not_registered_is_refused_and_nothing_is_sent_or_asked(self):
        for vault in (OTHER_VAULT, VAULT_A[:-2] + "00"):
            with self.assertRaisesRegex(canton.Fail, "not a Vault of the chain's registry"):
                self.lock(vault=vault)
        self.assertEqual((self.evm.sent, self.posts), ([], []))

    def test_only_vaults_count_and_there_must_be_one(self):
        chain = FakeLedger.contracts[("op::1", canton.CHAIN + "ZkChain")][0]["createArgument"]
        chain["contracts"] = [{**c, "contractKind": "Token"} for c in chain["contracts"]]
        with self.assertRaisesRegex(canton.Fail, "no Vault"):
            self.lock()
        with self.assertRaisesRegex(canton.Fail, "no Vault"):
            self.lock(vault="0x" + VAULT_A)
        chain["contracts"] = None
        with self.assertRaisesRegex(canton.Fail, "no Vault"):
            self.lock()
        self.assertEqual(self.evm.sent, [])

    def test_a_lock_id_that_is_not_the_hash_of_the_parts_is_refused_and_nothing_is_sent(self):
        for wrong in ("00" * 32, twin.lock_id(U, "ref-1"), twin.lock_id(V, "ref-2"), twin.lock_id(V, "ref-1").upper(), None, 5):
            self.answer = {"lockId": wrong}
            with self.assertRaisesRegex(canton.Fail, "nothing was sent"):
                self.lock()
        self.assertEqual(self.evm.sent, [])

    def test_the_receiver_is_u_v_or_a_party_id(self):
        self.holds("x::1220ab", ref=twin.lock_id("x::1220ab", "ref-1"))
        FakeLedger.contracts[(GW, twin.TWIN_HOLDING)][0]["createArgument"]["owner"] = "x::1220ab"
        self.assertEqual(self.lock("v", TOKEN, "2.5", "x::1220ab", "ref-1")["receiver"], "x::1220ab")
        self.assertEqual(self.posts[0][1]["receiver"], "x::1220ab")
        for receiver in ("x", "U", ""):
            with self.assertRaises(SystemExit):
                self.lock("u", TOKEN, "2.5", receiver, "ref-1")
        self.assertEqual(len(self.evm.sent), 2)   # only the one lock above

    def test_an_amount_that_does_not_convert_sends_and_asks_nothing(self):
        for amount in ("0.0000001", "0", "x", "2,5"):
            with self.assertRaises((canton.Fail, SystemExit)):
                self.lock("u", TOKEN, amount, "v", "ref-1")
        self.assertEqual((self.evm.sent, self.posts), ([], []))

    def test_a_token_with_no_code_or_an_empty_ref_or_another_sender_sends_nothing(self):
        self.token.decimals = None
        with self.assertRaisesRegex(canton.Fail, "no decimals"):
            self.lock()
        self.token.decimals = 6
        for args in (("u", TOKEN, "1", "v", ""), ("w", TOKEN, "1", "v", "r"), ("u", "0x12", "1", "v", "r")):
            with self.assertRaises(SystemExit):
                self.lock(*args)
        self.assertEqual((self.evm.sent, self.posts), ([], []))

    def test_a_reverted_approval_or_payment_stops_it(self):
        self.evm.failing = {1}
        with self.assertRaisesRegex(canton.Fail, "approval .* reverted"):
            self.lock()
        self.assertEqual(len(self.evm.sent), 1)   # no payment after a failed approval
        self.evm.sent.clear()
        self.evm.failing = {2}
        with self.assertRaisesRegex(canton.Fail, "lock payment .* reverted"):
            self.lock()

    def test_it_waits_for_the_receipt_before_it_goes_on(self):
        late = iter([None, None])   # the approval's receipt is not there for two reads
        real = self.evm.rpc
        reads = []

        def rpc(method, params):
            if method == "eth_getTransactionReceipt" and params[0] == f"0x{1:064x}":
                reads.append(params[0])
                if next(late, 1) is None:
                    return None
            return real(method, params)
        self.holds()
        with mock.patch.object(evm, "rpc", rpc), mock.patch.dict(os.environ, {"CZE_POLL_SECONDS": "0"}):
            got = self.lock()
        self.assertEqual((len(reads), got["approveTx"], len(self.evm.sent)), (4, f"0x{1:064x}", 2))

    def test_it_waits_for_the_mint_and_takes_only_the_holding_of_this_lock(self):
        for wrong in (minted("v::1", "2.5", twin.lock_id("v::1", "ref-2")), minted("u::1", "2.5", twin.lock_id("v::1", "ref-1")),
                      minted("v::1", "2.5", twin.lock_id("v::1", "ref-1"), token="cd" * 20), minted("v::1", "2.5", twin.lock_id("v::1", "ref-1"), admin="other::1"),
                      {**minted("v::1", "2.5", ""), "contractId": "plain"}):
            FakeLedger.contracts[(GW, twin.TWIN_HOLDING)] = [wrong]
            with mock.patch.object(twin, "WAIT_SECONDS", 0), self.assertRaisesRegex(canton.Fail, "timed out waiting for the twin to be minted"):
                self.lock()
        FakeLedger.contracts[(GW, twin.TWIN_HOLDING)] = [minted("v::1", "1.0", "x"), minted("v::1", "2.5", twin.lock_id("v::1", "ref-1"), cid="right")]
        self.assertEqual(self.lock()["holding"], "right")

    def test_the_mint_is_read_as_the_gateway_party(self):
        self.holds()
        FakeLedger.asked.clear()
        self.lock()
        self.assertIn(("operator", GW, twin.TWIN_HOLDING), FakeLedger.asked)

    def test_main_takes_the_options_and_the_registry_url_is_required(self):
        self.holds()
        got = twin.main(["lock", "u", "0x" + TOKEN, "2.5", "v", "ref-1", "--registry-url", self.URL + "/", "--vault", VAULT_B])
        self.assertEqual((got["vault"], self.posts[0][0]), ("0x" + VAULT_B, self.URL + "/twin/v1/lock-parts"))
        self.holds()
        for argv in (["lock", "u", TOKEN, "2.5", "v", "ref-1"], ["lock", "u", TOKEN, "2.5", "v", "--registry-url", self.URL],
                     ["lock", "u", TOKEN, "2.5", "v", "ref-1", "--registry-url"], ["lock", "u", TOKEN, "2.5", "v", "ref-1", "--registry-url", self.URL, "--registry-url", self.URL],
                     ["lock", "u", TOKEN, "2.5", "v", "ref-1", "--registry-url", self.URL, "--other", "x"]):
            with self.assertRaises(SystemExit, msg=argv):
                twin.main(argv)

    def test_the_registry_url_is_http_or_https(self):
        for url in ("file:///etc/passwd", "ftp://x", "registry:80", "", "http://", "http://a b"):
            with self.assertRaises(SystemExit, msg=url):
                twin.registry_url_of(url)
        self.assertEqual(twin.registry_url_of("https://r.example/base/"), "https://r.example/base")


class HoldingsTests(unittest.TestCase):
    def test_the_fewest_largest_holdings_that_cover_the_amount(self):
        held = [("a", 10), ("b", 50), ("c", 30), ("d", 5)]
        self.assertEqual(twin.pick_holdings(held, 50, "u"), ["b"])
        self.assertEqual(twin.pick_holdings(held, 51, "u"), ["b", "c"])
        self.assertEqual(twin.pick_holdings(held, 95, "u"), ["b", "c", "a", "d"])
        self.assertEqual(twin.pick_holdings(held, 1, "u"), ["b"])

    def test_short_is_refused_and_says_how_much_there_is(self):
        with self.assertRaisesRegex(canton.Fail, "u holds 0.0000000095 of the twin, less than 0.0000000096"):
            twin.pick_holdings([("a", 10), ("b", 50), ("c", 30), ("d", 5)], 96, "u")
        with self.assertRaisesRegex(canton.Fail, "holds 0.0 of the twin"):
            twin.pick_holdings([], 1, "v")


class SendTests(ChainTestCase):
    URL = "http://registry.example:8080"
    DISCLOSED = {"templateId": twin.TWIN_RULES, "contractId": "rules-1", "createdEventBlob": "blob", "synchronizerId": "sync::1"}

    def setUp(self):
        super().setUp()
        self.posts, self.exercises, self.reply = [], [], None
        self.answer = {"factoryId": "rules-1", "transferKind": "direct", "choiceContext": {"choiceContextData": {"values": {"k": {"tag": "AV_Bool", "value": True}}},
                                                                                       "disclosedContracts": [self.DISCLOSED]}}
        self.result = {"output": {"tag": twin.TRANSFER_COMPLETED, "value": {"receiverHoldingCids": ["new-1"]}}, "senderChangeCids": [], "meta": {"values": {}}}
        FakeLedger.contracts[(U, twin.TWIN_HOLDING)] = [holding(U, "1.5"), holding(U, "2.0"), holding(U, "0.25"), holding(V, "9.0"), holding(U, "5.0", token="cd" * 20),
                                                        holding(U, "7.0", admin="other::1")]
        FakeLedger.contracts[(GW, twin.TWIN_RULES)] = [{"contractId": "rules-1", "offset": 1, "templateId": twin.TWIN_RULES,
                                                        "createArgument": {"admin": GW, "token": TOKEN, "name": "n", "symbol": "s", "decimals": "6"}}]
        real = canton.Network.post

        def post(net, node, path, body, role, content_type="application/json"):
            if path != "/v2/commands/submit-and-wait-for-transaction":
                return real(net, node, path, body, role, content_type)
            self.exercises.append((node, body, role))
            if self.reply:
                return self.reply()
            return {"transaction": {"updateId": "upd-9", "events": [{"ExercisedEvent": {"contractId": "rules-1", "choice": "TransferFactory_Transfer", "exerciseResult": self.result}},
                                                                    {"CreatedEvent": {"contractId": "new-1"}}]}}
        for patcher in (mock.patch.object(canton.Network, "post", post), mock.patch.object(twin, "post_json", self.post)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def post(self, url, body):
        self.posts.append((url, body))
        return self.answer

    def send(self, *args):
        return twin.send(self.net, *(args or ("u", "v", TOKEN, "1.75")), self.URL)

    def test_the_transfer_is_asked_of_the_registry_and_exercised_as_the_sender(self):
        got = self.send()
        [(url, body)] = self.posts
        args = body["choiceArguments"]
        self.assertEqual(url, self.URL + "/registry/transfer-instruction/v1/transfer-factory")
        self.assertEqual(args["expectedAdmin"], GW)
        t = args["transfer"]
        self.assertEqual((t["sender"], t["receiver"], t["amount"], t["instrumentId"], t["meta"]), (U, V, "1.75", {"admin": GW, "id": "erc20:" + TOKEN}, {"values": {}}))
        self.assertEqual(t["inputHoldingCids"], ["h-u::1-2.0"])
        self.assertLess(t["requestedAt"], t["executeBefore"])
        [(node, request, role)] = self.exercises
        command = request["commands"]["commands"][0]["ExerciseCommand"]
        self.assertEqual((node, role, request["commands"]["actAs"], request["commands"]["userId"]), ("users", "demo", [U], "demo"))
        self.assertEqual((command["templateId"], command["contractId"], command["choice"]), (canton.TRANSFER_FACTORY, "rules-1", "TransferFactory_Transfer"))
        self.assertEqual(command["choiceArgument"]["extraArgs"], {"context": self.answer["choiceContext"]["choiceContextData"], "meta": {"values": {}}})
        self.assertEqual({k: v for k, v in command["choiceArgument"].items() if k != "extraArgs"}, {"expectedAdmin": GW, "transfer": t})
        self.assertEqual(request["commands"]["disclosedContracts"], [self.DISCLOSED])
        self.assertEqual(request["transactionFormat"]["transactionShape"], "TRANSACTION_SHAPE_LEDGER_EFFECTS")
        self.assertEqual(got["updateId"], "upd-9")
        self.assertEqual((got["from"], got["to"], got["amount"], got["result"]), ("u", V, "1.75", twin.TRANSFER_COMPLETED))

    def test_the_inputs_are_the_senders_own_holdings_of_this_twin_that_cover_the_amount(self):
        self.send("u", V, TOKEN, "3.5")   # 2.0 and 1.5; not V's 9.0, not another token's, not another admin's
        self.assertEqual(self.posts[0][1]["choiceArguments"]["transfer"]["inputHoldingCids"], ["h-u::1-2.0", "h-u::1-1.5"])
        self.assertEqual(self.send("u", "v", TOKEN, "3.75")["inputs"], ["h-u::1-2.0", "h-u::1-1.5", "h-u::1-0.25"])

    def test_short_is_refused_before_the_registry_is_asked(self):
        with self.assertRaisesRegex(canton.Fail, "u holds 3.75 of the twin, less than 3.8"):
            self.send("u", "v", TOKEN, "3.8")
        self.assertEqual((self.posts, self.exercises), ([], []))

    def test_the_receiver_may_be_a_party_id_and_the_sender_is_u_or_v(self):
        self.send("u", "x::1220ab", TOKEN, "1")
        self.assertEqual(self.posts[0][1]["choiceArguments"]["transfer"]["receiver"], "x::1220ab")
        FakeLedger.contracts[(V, twin.TWIN_HOLDING)] = [holding(V, "9.0")]
        self.assertEqual(self.send("v", "u", TOKEN, "9")["from"], "v")
        for args in (("gw", V, TOKEN, "1"), ("u", "x", TOKEN, "1"), ("U", V, TOKEN, "1")):
            with self.assertRaises(SystemExit):
                self.send(*args)

    def test_an_amount_that_does_not_convert_asks_nothing(self):
        for amount in ("0", "0.0000001", "1e1", "-1"):
            with self.assertRaises((canton.Fail, SystemExit)):
                self.send("u", "v", TOKEN, amount)
        self.assertEqual((self.posts, self.exercises), ([], []))

    def test_a_factory_that_is_not_the_ledgers_rules_is_refused_and_nothing_is_submitted(self):
        for factory in ("rules-2", None, 7):
            self.answer = {**self.answer, "factoryId": factory}
            with self.assertRaisesRegex(canton.Fail, "factory|factoryId"):
                self.send()
        FakeLedger.contracts[(GW, twin.TWIN_RULES)] = []
        self.answer["factoryId"] = "rules-1"
        with self.assertRaisesRegex(canton.Fail, "not a TwinRules"):
            self.send()
        self.assertEqual(self.exercises, [])

    def test_an_answer_without_the_disclosure_or_with_a_broken_one_is_refused(self):
        context = self.answer["choiceContext"]
        for bad in ({**context, "disclosedContracts": []}, {**context, "disclosedContracts": [{**self.DISCLOSED, "contractId": "rules-9"}]},
                    {**context, "disclosedContracts": [{**self.DISCLOSED, "createdEventBlob": ""}]}, {**context, "disclosedContracts": [{**self.DISCLOSED, "synchronizerId": None}]},
                    {**context, "disclosedContracts": ["x"]}, {**context, "disclosedContracts": None}, {**context, "choiceContextData": None}, None, "x"):
            self.answer = {**self.answer, "choiceContext": bad}
            with self.assertRaises(canton.Fail):
                self.send()
        self.assertEqual(self.exercises, [])

    def test_only_the_four_disclosure_fields_are_passed_on(self):
        self.answer["choiceContext"]["disclosedContracts"] = [{**self.DISCLOSED, "extra": "x"}]
        self.send()
        self.assertEqual(self.exercises[0][1]["commands"]["disclosedContracts"], [self.DISCLOSED])

    def test_a_result_that_is_not_completed_is_refused(self):
        for result in ({"output": {"tag": "TransferInstructionResult_Pending", "value": {}}}, {"output": {"tag": "TransferInstructionResult_Failed", "value": {}}},
                       {"output": None}, {}, None, "Completed"):
            self.result = result
            with self.assertRaisesRegex(canton.Fail, "upd-9 did not complete"):
                self.send()

    def test_no_exercised_event_of_the_factory_is_refused(self):
        self.reply = lambda: {"transaction": {"updateId": "upd-9", "events": []}}
        with self.assertRaisesRegex(canton.Fail, "did not complete: its result is not there"):
            self.send()
        self.reply = lambda: {}
        with self.assertRaisesRegex(canton.Fail, "no transaction"):
            self.send()

    def test_the_ledger_refusing_the_command_stops_it(self):
        def refuse():
            raise canton.Refused("/v2/commands: 400 nope")
        self.reply = refuse
        with self.assertRaisesRegex(canton.Fail, "nope"):
            self.send()
        self.assertEqual(len(self.posts), 1)

    def test_main_takes_four_arguments_and_the_registry_url(self):
        self.assertEqual(twin.main(["send", "u", "v", "0x" + TOKEN, "1", "--registry-url", self.URL])["updateId"], "upd-9")
        for argv in (["send", "u", "v", TOKEN, "1"], ["send", "u", "v", TOKEN, "--registry-url", self.URL], ["send", "u", "v", TOKEN, "1", "2", "--registry-url", self.URL],
                     ["send", "u", "v", TOKEN, "1", "--vault", VAULT_A, "--registry-url", self.URL]):
            with self.assertRaises(SystemExit, msg=argv):
                twin.main(argv)


class PostJsonTests(unittest.TestCase):
    def serve(self, status, body):
        import http.server, threading

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                self.rfile.read(int(self.headers["content-length"]))
                self.send_response(status); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/x"

    def test_an_object_comes_back(self):
        self.assertEqual(twin.post_json(self.serve(200, b'{"a": 1}'), {}), {"a": 1})

    def test_an_error_status_a_non_object_and_a_big_answer_stop_it(self):
        with self.assertRaisesRegex(canton.Fail, "404 .*no twin"):
            twin.post_json(self.serve(404, b'{"error": "no twin"}'), {})
        for body in (b"[1]", b"not json", b'"x"'):
            with self.assertRaises(canton.Fail):
                twin.post_json(self.serve(200, body), {})
        with mock.patch.object(twin, "MAX_ANSWER", 10), self.assertRaisesRegex(canton.Fail, "more than 10 bytes"):
            twin.post_json(self.serve(200, b'{"a": "' + b"x" * 20 + b'"}'), {})
        with self.assertRaises(canton.Fail):
            twin.post_json("http://127.0.0.1:1/x", {})


if __name__ == "__main__":
    unittest.main()
