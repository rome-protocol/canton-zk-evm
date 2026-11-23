"""Tests for demo/asset.py: the memo tools for any token-standard instrument, with a fake registry (a local HTTP server) and a fake Ledger API, as in test_demo_cc.py (Canton Coin's own tests).
Run: python3 -W error::ResourceWarning -m unittest tests/test_demo_asset.py"""
import json, os, sys, unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "demo"))
sys.path.insert(0, str(ROOT / "tests"))
import asset, canton, twin
import test_demo_cc as base
from test_demo_cc import FakeLedger, FakeScan, GW, PKG, U, V, REASON, MEMO_ADDRESS, held, instruction_view

ISSUER = "issuer::1220" + "9a" * 32
TKB = {"admin": ISSUER, "id": "TKB"}
INSTRUMENT = ISSUER + "/TKB"
FACTORY = "00" + "7a" * 34
INSTRUCTION = "00" + "3e" * 34
REGISTRY_TOKEN = "registry-secret-" + "4" * 20
ROOT_PATH = "/issuer-registry"
FACTORY_PATH = ROOT_PATH + "/registry/transfer-instruction/v1/transfer-factory"
WITHDRAW_PATH = ROOT_PATH + "/registry/transfer-instruction/v1/%s/choice-contexts/withdraw"
RULES = {**base.contract("rules", PKG + ":Issuer.Rules:TransferRules"), "contractId": FACTORY}


def factory_answer(kind="offer") -> dict:
    return {"factoryId": FACTORY, "transferKind": kind, "choiceContext": {"choiceContextData": {"values": {"rules": {"tag": "AV_ContractId", "value": FACTORY}}}, "disclosedContracts": [dict(RULES)]}}


class AssetCase(base.CcCase):
    def setUp(self):
        super().setUp()
        self.registry = self.scan_url.removesuffix(base.BASE + "/scan-proxy") + ROOT_PATH
        self.bearer_file = self.state / "registry.token"
        self.bearer_file.write_text(REGISTRY_TOKEN + "\n")
        self.bearer_file.chmod(0o600)
        self.mode = "pending"
        FakeScan.answers[FACTORY_PATH] = lambda body: factory_answer("offer" if body["choiceArguments"]["transfer"]["sender"] != body["choiceArguments"]["transfer"]["receiver"] else "self")
        self.context = {"choiceContextData": {"values": {"w": {"tag": "AV_Text", "value": "x"}}}, "disclosedContracts": [dict(RULES)]}
        FakeScan.answers[WITHDRAW_PATH % INSTRUCTION] = lambda body: self.context
        FakeLedger.holdings = {U: [held("00u1", "5.0", instrument=TKB), held("00u2", "2.5", instrument=TKB), held("00u3", "9.0", locked=True, instrument=TKB),
                                   held("00u4", "100.0"), held("00u5", "1.0", instrument={"admin": ISSUER, "id": "OTHER"})], GW: []}
        patcher = mock.patch.object(FakeLedger, "transaction", staticmethod(self.transaction))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.run_asset = lambda *argv: asset.main(list(argv))
        self.reg = ("--registry", f"{ISSUER}={self.registry}", "--registry-token-file", f"{ISSUER}={self.bearer_file}")

    def transaction(self, body):
        command = body["commands"]["commands"][0]["ExerciseCommand"]
        if command["choice"] == "TransferFactory_Transfer":
            output = {"tag": twin.TRANSFER_COMPLETED if self.mode == "completed" else asset.TRANSFER_PENDING, "value": {"transferInstructionCid": INSTRUCTION}}
        else:
            output = {"tag": "TransferInstructionResult_Failed", "value": {}}
        return {"transaction": {"updateId": "update-a", "events": [{"ExercisedEvent": {"contractId": command["contractId"], "choice": command["choice"], "exerciseResult": {"output": output}}}]}}

    def commands(self):
        return [c for c in FakeLedger.commands if not isinstance(c["commands"], list)]

    def registry_requests(self, path):
        return [(h, b) for m, p, h, b in FakeScan.seen if p == path]


class SendMemoTests(AssetCase):
    def test_u_sends_the_instrument_through_the_registrys_factory_with_the_memo(self):
        got = self.run_asset("send-memo", INSTRUMENT, "2.5", MEMO_ADDRESS, "--label", "t1", *self.reg)
        [(headers, asked)] = self.registry_requests(FACTORY_PATH)
        transfer = asked["choiceArguments"]["transfer"]
        self.assertEqual((asked["choiceArguments"]["expectedAdmin"], transfer["sender"], transfer["receiver"], transfer["amount"], transfer["instrumentId"]), (ISSUER, U, GW, "2.5", TKB))
        self.assertEqual(transfer["meta"], {"values": {REASON: MEMO_ADDRESS, asset.LABEL_KEY: "t1"}})
        self.assertEqual(transfer["inputHoldingCids"], ["00u1", "00u2"])   # unlocked holdings of this instrument only, the largest first
        self.assertEqual((headers["Authorization"], headers["User-Agent"]), ("Bearer " + REGISTRY_TOKEN, asset.USER_AGENT))
        [request] = self.commands()
        command = request["commands"]["commands"][0]["ExerciseCommand"]
        self.assertEqual((command["templateId"], command["contractId"], command["choice"]), (canton.TRANSFER_FACTORY, FACTORY, "TransferFactory_Transfer"))
        self.assertEqual(command["choiceArgument"]["expectedAdmin"], ISSUER)
        self.assertEqual(command["choiceArgument"]["extraArgs"]["context"], factory_answer()["choiceContext"]["choiceContextData"])
        self.assertEqual((request["commands"]["actAs"], request["commands"]["disclosedContracts"]), ([U], [RULES]))
        self.assertEqual(got, {"instrument": TKB, "updateId": "update-a", "from": U, "to": GW, "amount": "2.5", "meta": {REASON: MEMO_ADDRESS, asset.LABEL_KEY: "t1"}, "kind": "offer",
                               "result": asset.TRANSFER_PENDING, "instruction": INSTRUCTION,
                               "balance": {"before": {"party": U, "unlocked": "7.5", "locked": "9.0"}, "after": {"party": U, "unlocked": "7.5", "locked": "9.0"}}})

    def test_a_completed_transfer_has_no_instruction(self):
        self.mode = "completed"
        FakeLedger.transaction = staticmethod(lambda body: {"transaction": {"updateId": "u", "events": [{"ExercisedEvent": {"contractId": FACTORY, "choice": "TransferFactory_Transfer",
                                                              "exerciseResult": {"output": {"tag": twin.TRANSFER_COMPLETED, "value": {}}}}}]}})
        self.assertEqual(self.run_asset("send-memo", INSTRUMENT, "1", MEMO_ADDRESS, *self.reg)["instruction"], None)

    def test_a_token_with_no_registry_uses_the_registered_tokens_factory_and_the_disclosed_file(self):
        FakeLedger.events[canton.CHAIN + "GatewayToken"] = [{"contractId": "gt-1", "createArgument": {"evmToken": base.WRAPPED, "instrumentId": TKB, "factory": FACTORY}},
                                                           {"contractId": "gt-2", "createArgument": {"evmToken": "cd" * 20, "instrumentId": {"admin": ISSUER, "id": "OTHER"}, "factory": "00" + "11" * 34}}]
        disclosed = self.state / "disclosed.json"
        disclosed.write_text(json.dumps([{**RULES, "debug": "x"}]))
        got = self.run_asset("send-memo", INSTRUMENT, "1", MEMO_ADDRESS, "--disclosed", str(disclosed))
        [request] = self.commands()
        command = request["commands"]["commands"][0]["ExerciseCommand"]
        self.assertEqual((command["contractId"], command["choiceArgument"]["extraArgs"]["context"], request["commands"]["disclosedContracts"]), (FACTORY, {"values": {}}, [RULES]))
        self.assertEqual((got["kind"], FakeScan.seen), (None, []))   # no registry was asked

    def test_no_registry_and_no_registered_token_stops_before_anything_is_sent(self):
        with self.assertRaisesRegex(canton.Fail, "no registry"):
            self.run_asset("send-memo", INSTRUMENT, "1", MEMO_ADDRESS)
        self.assertEqual(self.commands(), [])

    def test_the_registry_comes_from_the_environment_too_and_the_option_wins(self):
        env = {asset.REGISTRIES: f"{V}={self.registry}x,{ISSUER}={self.registry}x", asset.REGISTRY_TOKEN_FILES: f"{ISSUER}={self.bearer_file}"}
        with mock.patch.dict(os.environ, env):
            self.run_asset("send-memo", INSTRUMENT, "1", MEMO_ADDRESS, "--registry", f"{ISSUER}={self.registry}")
        self.assertEqual(len(self.registry_requests(FACTORY_PATH)), 1)   # the option's URL, not the environment's

    def test_the_registry_options_can_be_given_more_than_once_as_the_builder_takes_them(self):
        self.run_asset("send-memo", INSTRUMENT, "1", MEMO_ADDRESS, "--registry", f"{V}={self.registry}x", "--registry", f"{ISSUER}={self.registry}",
                       "--registry-token-file", f"{V}={self.bearer_file}", "--registry-token-file", f"{ISSUER}={self.bearer_file}")
        self.assertEqual(len(self.registry_requests(FACTORY_PATH)), 1)

    def test_a_registry_url_with_a_query_or_a_user_is_refused(self):
        for url in (self.registry + "?x=1", self.registry.replace("://", "://user:pw@")):
            with self.subTest(url=url), self.assertRaises(SystemExit):
                self.run_asset("send-memo", INSTRUMENT, "1", MEMO_ADDRESS, "--registry", f"{ISSUER}={url}")
        self.assertEqual(self.commands(), [])

    def test_a_registry_with_no_token_file_gets_no_authorization(self):
        self.run_asset("send-memo", INSTRUMENT, "1", MEMO_ADDRESS, "--registry", f"{ISSUER}={self.registry}")
        [(headers, _)] = self.registry_requests(FACTORY_PATH)
        self.assertNotIn("Authorization", headers)

    def test_the_registrys_answer_is_checked_and_nothing_is_sent_on_a_bad_one(self):
        for change in (lambda a: a.pop("factoryId"), lambda a: a.update(factoryId="00" + "77" * 34), lambda a: a.update(transferKind="self"),
                       lambda a: a["choiceContext"]["disclosedContracts"][0].pop("createdEventBlob")):
            def answer(body, change=change):
                a = factory_answer()
                change(a)
                return a
            FakeScan.answers[FACTORY_PATH] = answer
            with self.subTest(), self.assertRaises(canton.Fail):
                self.run_asset("send-memo", INSTRUMENT, "1", MEMO_ADDRESS, *self.reg)
        self.assertEqual(self.commands(), [])

    def test_nothing_is_sent_for_a_bad_instrument_amount_address_or_too_little(self):
        for argv, error in (((ISSUER, "1", MEMO_ADDRESS), SystemExit), (("x/TKB", "1", MEMO_ADDRESS), SystemExit), ((INSTRUMENT, "0", MEMO_ADDRESS), SystemExit),
                            ((INSTRUMENT, "1", "0x12"), SystemExit), ((INSTRUMENT, "8", MEMO_ADDRESS), canton.Fail)):
            with self.subTest(argv=argv), self.assertRaises(error):
                self.run_asset("send-memo", *argv, *self.reg)
        self.assertEqual(self.commands(), [])

    def test_a_bad_command_line_prints_the_usage(self):
        for argv in (("send-memo", INSTRUMENT, "1"), ("send-memo", INSTRUMENT, "1", MEMO_ADDRESS, "--label"), ("send-memo", INSTRUMENT, "1", MEMO_ADDRESS, "--other", "x"),
                     ("instructions", INSTRUMENT, "x"), ("instructions", "--registry", "a=b"), ("take-back", INSTRUMENT), ("factory",), ("nothing",), ()):
            with self.subTest(argv=argv), self.assertRaises(SystemExit):
                self.run_asset(*argv)

    def test_the_registry_token_is_never_printed_even_when_the_server_echoes_it(self):
        FakeScan.answers[FACTORY_PATH] = (500, "boom " + REGISTRY_TOKEN)
        with self.assertRaises(canton.Fail) as why:
            self.run_asset("send-memo", INSTRUMENT, "1", MEMO_ADDRESS, *self.reg)
        self.assertNotIn(REGISTRY_TOKEN, str(why.exception))
        self.assertIn("500", str(why.exception))

    def test_a_token_file_that_others_can_read_stops_the_command_before_any_request(self):
        self.bearer_file.chmod(0o644)
        with self.assertRaises(SystemExit):
            self.run_asset("send-memo", INSTRUMENT, "1", MEMO_ADDRESS, *self.reg)
        self.assertEqual((FakeScan.seen, self.commands()), ([], []))


class InstructionsTests(AssetCase):
    def test_the_instructions_are_the_gateways_and_one_instrument_can_be_asked_for(self):
        other = instruction_view()
        mine = instruction_view(meta={REASON: MEMO_ADDRESS})
        mine["transfer"]["instrumentId"] = TKB
        FakeLedger.instruction_views = {GW: [("00i1", mine), ("00i2", other), ("00i3", instruction_view(sender=GW, receiver=U))]}
        [only] = self.run_asset("instructions", INSTRUMENT)["instructions"]
        self.assertEqual((only["instruction"], only["instrumentId"], only["memo"], only["status"]["tag"]), ("00i1", TKB, MEMO_ADDRESS, "TransferPendingReceiverAcceptance"))
        self.assertEqual([i["instruction"] for i in self.run_asset("instructions")["instructions"]], ["00i1", "00i2"])
        self.assertEqual({a for p, a, b in FakeLedger.requests if p == "/v2/state/active-contracts"}, {"Bearer " + base.TOKENS["OPERATOR"]})


class TakeBackTests(AssetCase):
    def test_u_withdraws_with_the_registrys_withdraw_context(self):
        got = self.run_asset("take-back", INSTRUMENT, INSTRUCTION, *self.reg)
        [request] = self.commands()
        command = request["commands"]["commands"][0]["ExerciseCommand"]
        self.assertEqual((command["templateId"], command["contractId"], command["choice"]), (canton.TRANSFER_INSTRUCTION, INSTRUCTION, "TransferInstruction_Withdraw"))
        self.assertEqual(command["choiceArgument"], {"extraArgs": {"context": self.context["choiceContextData"], "meta": {"values": {}}}})
        self.assertEqual((request["commands"]["actAs"], request["commands"]["disclosedContracts"]), ([U], [RULES]))
        self.assertEqual((got["instrument"], got["result"], got["balance"]), (TKB, "TransferInstructionResult_Failed", {"party": U, "unlocked": "7.5", "locked": "9.0"}))

    def test_a_token_with_no_registry_withdraws_with_no_context(self):
        self.run_asset("take-back", INSTRUMENT, INSTRUCTION)
        [request] = self.commands()
        self.assertEqual((request["commands"]["commands"][0]["ExerciseCommand"]["choiceArgument"]["extraArgs"]["context"], request["commands"]["disclosedContracts"]), ({"values": {}}, []))
        self.assertEqual(FakeScan.seen, [])

    def test_a_cid_that_is_not_one_or_a_malformed_context_sends_nothing(self):
        with self.assertRaises(canton.Fail):
            self.run_asset("take-back", INSTRUMENT, "not-a-contract", *self.reg)
        self.context = {"choiceContextData": {"values": {}}}
        with self.assertRaises(canton.Fail):
            self.run_asset("take-back", INSTRUMENT, INSTRUCTION, *self.reg)
        self.assertEqual(self.commands(), [])


class FactoryTests(AssetCase):
    def test_the_factory_that_the_registry_names_for_the_instrument_is_printed(self):
        got = self.run_asset("factory", INSTRUMENT, *self.reg)
        self.assertEqual(got, {"instrument": TKB, "factory": FACTORY, "template": RULES["templateId"], "kind": "self"})
        [(_, asked)] = self.registry_requests(FACTORY_PATH)
        self.assertEqual((asked["choiceArguments"]["expectedAdmin"], asked["choiceArguments"]["transfer"]["instrumentId"]), (ISSUER, TKB))
        self.assertEqual(self.commands(), [])

    def test_a_token_with_no_registry_has_nothing_to_ask(self):
        with self.assertRaises(SystemExit):
            self.run_asset("factory", INSTRUMENT)


if __name__ == "__main__":
    unittest.main()
