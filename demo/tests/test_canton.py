"""Tests for demo/canton.py with a fake Ledger API (one server for each participant). Run: python3 -m unittest discover -s demo/tests"""
import hashlib, http.server, importlib.util, json, os, subprocess, sys, tempfile, threading, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import canton

ROOT = canton.ROOT
PARTIES = {"OPERATOR": "op::1", "CONFIRMER": "co::1", "BUILDER": "bu::1", "GATEWAY": "gw::1", "READER": "re::1", "U": "u::1", "V": "v::1", "REGISTRY": "rg::1"}
CHAIN_RECORD = {"chainId": "770101", "operator": "op::1", "confirmer": "co::1", "gateway": "gw::1", "builder": "bu::1", "reader": "re::1",
                "headNumber": "3", "headHash": "ab" * 32}
EVM_TOKEN = "0x" + "AB" * 20
RULES = {"templateId": canton.RULES, "contractId": "rules-1", "createdEventBlob": "blob-1", "synchronizerId": "sync::1"}


class FakeLedger(http.server.BaseHTTPRequestHandler):
    node = ""
    contracts: dict = {}     # (party, template) -> created events, as the participants report them
    created: list = []       # the contracts the submitted commands made; every party sees them on every node
    submitted: list = []     # (node, request body) of each command
    asked: list = []         # (node, party, template) of each look at the active contracts
    updates: dict = {}       # offset -> (update id, contract ids created)
    refuse = None            # if set, the text of a refusal that every command gets

    def log_message(self, *args):
        pass

    def reply(self, body, status=200):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(status); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        self.reply({"offset": 99})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if self.path == "/v2/state/active-contracts":
            [(party, flt)] = body["eventFormat"]["filtersByParty"].items()
            template = flt["cumulative"][0]["identifierFilter"]["TemplateFilter"]["value"]["templateId"]
            FakeLedger.asked.append((self.node, party, template))
            events = FakeLedger.contracts.get((party, template), []) + [e for e in FakeLedger.created if e["templateId"] == template]
            self.reply([{"contractEntry": {"JsActiveContract": {"createdEvent": e, "synchronizerId": "sync::1"}}} for e in events])
        elif self.path == "/v2/commands/submit-and-wait":
            FakeLedger.submitted.append((self.node, body))
            if FakeLedger.refuse:
                return self.reply(FakeLedger.refuse, 400)
            [command] = body["commands"]
            n = len(FakeLedger.created) + 1
            if "CreateCommand" in command:
                c = command["CreateCommand"]
                FakeLedger.created.append({"contractId": f"cid-{n}", "templateId": c["templateId"], "createArgument": c["createArguments"], "offset": 100 + n,
                                           "createdEventBlob": f"blob-{n}"})
            elif command["ExerciseCommand"]["choice"] == "AllocationFactory_Allocate":   # the token makes the allocation
                FakeLedger.created.append({"contractId": f"cid-{n}", "templateId": canton.ALLOCATION_OF_TOKEN, "offset": 100 + n,
                                           "createArgument": {"allocation": command["ExerciseCommand"]["choiceArgument"]["allocation"]}})
            elif command["ExerciseCommand"]["choice"] == "Allocation_Withdraw":   # the sender takes the allocation back: it is gone for everyone
                gone = command["ExerciseCommand"]["contractId"]
                FakeLedger.created = [e for e in FakeLedger.created if e["contractId"] != gone]
                FakeLedger.contracts = {k: [e for e in v if e["contractId"] != gone] for k, v in FakeLedger.contracts.items()}
            self.reply({"updateId": f"update-{n}"})
        elif self.path == "/v2/updates/update-by-offset":
            found = FakeLedger.updates.get(body["offset"])
            if found is None:
                return self.reply("", 404)
            self.reply({"update": {"Transaction": {"value": {"updateId": found[0], "offset": body["offset"],
                                                              "events": [{"CreatedEvent": {"contractId": c}} for c in found[1]]}}}})
        else:
            self.reply("", 404)


def record(number, offset, cid):
    return {"contractId": cid, "offset": offset, "createArgument": {"number": str(number)}}


def holding(owner, amount, cid):
    return {"contractId": cid, "offset": 1, "createArgument": {"holding": {"owner": owner, "instrumentId": {"admin": "rg::1", "id": "TKB"}, "amount": amount}}}


class LedgerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        (self.state / "canton").mkdir()
        (self.state / "canton" / "parties.env").write_text("".join(f"{k}_PARTY={v}\n" for k, v in PARTIES.items()))
        os.environ["CZE_STATE_DIR"] = str(self.state)
        for node, variable in (("operator", "CZE_LEDGER_URL"), ("confirmer", "CZE_CONFIRMER_LEDGER_URL"), ("users", "CZE_USERS_LEDGER_URL")):
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), type(node, (FakeLedger,), {"node": node}))
            threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            os.environ[variable] = f"http://127.0.0.1:{server.server_address[1]}"
        FakeLedger.contracts = {("op::1", canton.CHAIN + "ZkChain"): [{"contractId": "chain-1", "offset": 5, "createArgument": CHAIN_RECORD}]}
        FakeLedger.created, FakeLedger.submitted, FakeLedger.asked, FakeLedger.updates, FakeLedger.refuse = [], [], [], {}, None
        (self.state / "demo").mkdir()
        (self.state / "demo" / "disclosed.json").write_text(json.dumps([{k: v for k, v in RULES.items()}]))

    def made(self, template):
        """The createArguments of the contracts of this template that the commands made."""
        return [e["createArgument"] for e in FakeLedger.created if e["templateId"] == template]

    def exercised(self, choice):
        """(node, body) of the commands that exercised this choice."""
        return [(n, b) for n, b in FakeLedger.submitted if b["commands"][0].get("ExerciseCommand", {}).get("choice") == choice]


class SettledTests(LedgerTestCase):
    def setUp(self):
        super().setUp()
        FakeLedger.contracts.update({("re::1", canton.CHAIN + "BlockRecord"): [record(7, 40, "rec7"), record(8, 50, "rec8")],
                                     ("v::1", canton.TOKEN): [record(0, 30, "hold-old"), record(0, 50, "hold-new")]})
        FakeLedger.updates = {40: ("upd-7", ["rec7"]), 50: ("upd-8", ["rec8", "hold-new"]), 30: ("upd-old", ["hold-old"])}

    def test_the_block_and_the_holding_come_from_one_update(self):
        got = canton.settled(canton.Network(), 8)
        self.assertEqual(got["record"], {"updateId": "upd-8", "offset": 50, "contract": "rec8"})
        self.assertEqual(got["holding"], {"updateId": "upd-8", "offset": 50, "contract": "hold-new"})

    def test_a_holding_made_elsewhere_gives_another_update(self):
        FakeLedger.contracts[("v::1", canton.TOKEN)] = [record(0, 30, "hold-old")]
        got = canton.settled(canton.Network(), 8)
        self.assertNotEqual(got["record"]["updateId"], got["holding"]["updateId"])

    def test_an_update_that_did_not_create_the_contract_is_refused(self):
        FakeLedger.updates[50] = ("upd-8", ["rec8"])
        with self.assertRaises(canton.Fail):
            canton.settled(canton.Network(), 8)

    def test_no_record_for_the_block_is_refused(self):
        with self.assertRaises(canton.Fail):
            canton.settled(canton.Network(), 9)

    def test_an_event_without_an_offset_is_refused(self):
        del FakeLedger.contracts[("re::1", canton.CHAIN + "BlockRecord")][1]["offset"]
        with self.assertRaises(canton.Fail):
            canton.settled(canton.Network(), 8)


class SettledHolderTests(LedgerTestCase):
    """`settled <block> <holder>`: the update of the block's record and the one of the newest TKB holding of u, v or the gateway."""
    def setUp(self):
        super().setUp()
        FakeLedger.contracts.update({
            ("re::1", canton.CHAIN + "BlockRecord"): [record(8, 50, "rec8")],
            ("op::1", canton.CHAIN + "BlockRecord"): [record(8, 70, "rec8")],
            ("gw::1", canton.TOKEN): [record(0, 20, "gold"), record(0, 70, "gnew")],
            ("u::1", canton.TOKEN): [record(0, 30, "uold"), record(0, 50, "unew")]})
        FakeLedger.updates = {50: ("upd-8", ["rec8", "unew"]), 70: ("upd-8", ["rec8", "gnew"]), 30: ("upd-old", ["uold"]), 20: ("upd-g", ["gold"])}

    def test_the_gateways_holding_is_read_on_the_operators_participant_beside_the_record(self):
        got = canton.settled(canton.Network(), 8, "gateway")
        self.assertEqual(got["record"], {"updateId": "upd-8", "offset": 70, "contract": "rec8"})
        self.assertEqual(got["holding"], {"updateId": "upd-8", "offset": 70, "contract": "gnew"})
        # The two offsets are only comparable when one participant reports both.
        self.assertEqual({node for node, _, _ in FakeLedger.asked}, {"operator"})

    def test_us_newest_holding_is_read_on_the_users_participant(self):
        got = canton.settled(canton.Network(), 8, "u")
        self.assertEqual(got["holding"], {"updateId": "upd-8", "offset": 50, "contract": "unew"})
        self.assertEqual({node for node, _, _ in FakeLedger.asked}, {"users"})

    def test_a_holding_made_elsewhere_gives_another_update(self):
        FakeLedger.contracts[("gw::1", canton.TOKEN)] = [record(0, 20, "gold")]
        got = canton.settled(canton.Network(), 8, "gateway")
        self.assertNotEqual(got["record"]["updateId"], got["holding"]["updateId"])

    def test_v_is_the_default(self):
        FakeLedger.contracts[("v::1", canton.TOKEN)] = [record(0, 50, "vnew")]
        FakeLedger.updates[50] = ("upd-8", ["rec8", "vnew"])
        self.assertEqual(canton.settled(canton.Network(), 8)["holding"]["contract"], "vnew")

    def test_the_command_takes_the_holder_and_refuses_another_word(self):
        self.assertEqual(canton.main(["settled", "8", "gateway"])["holding"]["contract"], "gnew")
        with self.assertRaises(SystemExit):
            canton.main(["settled", "8", "reader"])

    def test_a_holder_without_a_holding_is_refused(self):
        FakeLedger.contracts[("gw::1", canton.TOKEN)] = []
        with self.assertRaises(canton.Fail):
            canton.settled(canton.Network(), 8, "gateway")


class WithdrawAllocationTests(LedgerTestCase):
    def setUp(self):
        super().setUp()
        self.allocation = lambda label, cid: {"contractId": cid, "offset": 7, "createArgument": {"allocation": {"settlement": {"settlementRef": {"id": label}}}}}
        FakeLedger.contracts[("u::1", canton.ALLOCATION_OF_TOKEN)] = [self.allocation("dvp-1", "al-1"), self.allocation("dvp-2", "al-2")]

    def test_u_takes_back_the_allocation_with_that_label_and_no_other(self):
        out = canton.main(["withdraw-allocation", "dvp-2"])
        [(node, body)] = self.exercised("Allocation_Withdraw")
        self.assertEqual((node, body["actAs"], body["userId"]), ("users", ["u::1"], "demo"))
        command = body["commands"][0]["ExerciseCommand"]
        self.assertEqual(command["contractId"], "al-2")
        self.assertEqual(command["templateId"], canton.ALLOCATION_INTERFACE)
        self.assertEqual(command["choiceArgument"], {"extraArgs": canton.NO_EXTRA_ARGS})
        self.assertEqual(out, {"label": "dvp-2", "withdrawn": "al-2"})
        self.assertEqual(canton.main(["status"])["allocations"], ["dvp-1"])

    def test_no_allocation_with_that_label_is_a_failure_and_nothing_is_sent(self):
        with self.assertRaises(canton.Fail):
            canton.main(["withdraw-allocation", "dvp-9"])
        self.assertEqual(self.exercised("Allocation_Withdraw"), [])

    def test_two_allocations_with_one_label_are_refused(self):
        FakeLedger.contracts[("u::1", canton.ALLOCATION_OF_TOKEN)].append(self.allocation("dvp-2", "al-3"))
        with self.assertRaises(canton.Fail):
            canton.main(["withdraw-allocation", "dvp-2"])
        self.assertEqual(self.exercised("Allocation_Withdraw"), [])

    def test_canton_refusing_is_a_failure_with_its_words(self):
        FakeLedger.refuse = "NOT_ALLOWED"
        with self.assertRaises(canton.Refused) as why:
            canton.main(["withdraw-allocation", "dvp-1"])
        self.assertIn("NOT_ALLOWED", str(why.exception))

    def test_an_empty_label_is_refused(self):
        with self.assertRaisesRegex(SystemExit, "must not be empty"):
            canton.main(["withdraw-allocation", ""])

    def test_it_waits_until_the_operators_participant_no_longer_shows_the_allocation(self):
        # The operator is the allocation's executor and the builder submits there, so the block can only be refused for the missing
        # allocation once that participant has seen it go.
        # Here the operator's participant still shows the allocation on its first look, and no longer on its second.
        real = canton.Network.template
        looks = []

        def template(net, node, party, template, blob=False):
            found = real(net, node, party, template, blob)
            if node == "operator" and template == canton.ALLOCATION_OF_TOKEN:
                looks.append(party)
                if len(looks) == 1:
                    return found + [self.allocation("dvp-2", "al-2")]
            return found

        with mock.patch.object(canton.Network, "template", template), mock.patch.object(canton.time, "sleep"):
            canton.main(["withdraw-allocation", "dvp-2"])
        self.assertEqual(looks, ["operator", "operator"])


class PaymentIdTests(LedgerTestCase):
    def test_the_id_is_the_sha256_of_the_two_parties_and_the_label(self):
        # The same text and digest as Daml's paymentId: T.sha256 (u ++ "," ++ v ++ "," ++ label), in lowercase hex.
        self.assertEqual(canton.payment_id("u::1", "v::1", "dvp-1"), "2590ac193122c8505cf0de6ba11ebd0f1228c261cd3050468de3cf21c089dc47")
        self.assertEqual(canton.payment_id("u::1220aa", "v::1220bb", "dvp-1"), "9b789a3d4a81dc227aaecab53dadf27b02ccc5201d05ce2c51d826bd2331efe0")
        self.assertEqual(canton.payment_id("u::1", "v::1", "dvp-1"), hashlib.sha256("u::1,v::1,dvp-1".encode()).hexdigest())

    def test_a_label_with_non_ascii_text_is_hashed_as_utf8(self):
        self.assertEqual(canton.payment_id("u::1", "v::1", "zahlung-é"), hashlib.sha256("u::1,v::1,zahlung-é".encode("utf-8")).hexdigest())

    def test_the_id_depends_on_who_is_u_and_who_is_v(self):
        self.assertNotEqual(canton.payment_id("u::1", "v::1", "x"), canton.payment_id("v::1", "u::1", "x"))

    def test_the_command_gives_the_id_for_this_runs_parties(self):
        self.assertEqual(canton.main(["payment-id", "dvp-1"]), {"label": "dvp-1", "id": "2590ac193122c8505cf0de6ba11ebd0f1228c261cd3050468de3cf21c089dc47"})


class SetupTests(LedgerTestCase):
    def test_setup_makes_the_rules_and_the_holding_and_writes_the_disclosed_file(self):
        (self.state / "demo" / "disclosed.json").unlink()
        out = canton.main(["setup"])
        [rules] = [e for e in FakeLedger.created if e["templateId"] == canton.RULES]
        self.assertEqual(out["rules"], rules["contractId"])
        self.assertEqual(self.made(canton.TOKEN)[0]["holding"]["owner"], "u::1")
        self.assertEqual(out["uHolds"], [100])
        written = json.loads(Path(out["disclosed"]).read_text())
        self.assertEqual(written, [{"templateId": canton.RULES, "contractId": rules["contractId"], "createdEventBlob": rules["createdEventBlob"], "synchronizerId": "sync::1"}])

    def test_the_builder_takes_the_file_setup_wrote(self):
        sys.path.insert(0, str(ROOT / "builder"))   # builder.py imports keccak from its own folder
        spec = importlib.util.spec_from_file_location("builder_under_test", ROOT / "builder" / "builder.py")
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        (self.state / "demo" / "disclosed.json").unlink()
        out = canton.main(["setup"])
        found = builder.read_disclosed(out["disclosed"])
        self.assertEqual([c["contractId"] for c in found], [out["rules"]])
        self.assertEqual(sorted(found[0]), ["contractId", "createdEventBlob", "synchronizerId", "templateId"])


class RegisterTokenTests(LedgerTestCase):
    def stub(self, body):
        """A stand-in for propose.py: the code it runs."""
        path = self.state / "propose-stub.py"
        path.write_text(body)
        self.addCleanup(setattr, canton, "PROPOSE", canton.PROPOSE)
        canton.PROPOSE = path

    def test_the_arguments_are_the_ones_propose_py_takes(self):
        sys.path.insert(0, str(ROOT / "network" / "canton"))
        import propose
        argv = canton.propose_arguments(canton.Network(), EVM_TOKEN)
        mode, args = propose.parse(argv, {"CHAIN_ID": "770101", "GAS_CAP": "30000000", "GATEWAY_ADDRESS": "0x" + "a7" + "00" * 19})
        self.assertEqual(mode, "token")
        self.assertEqual((args.evm_token, args.instrument_admin, args.instrument_id, args.factory), ("ab" * 20, "rg::1", "TKB", "rules-1"))

    def test_the_command_runs_propose_py_and_gives_its_answer(self):
        self.stub("import json, sys\nprint(json.dumps({'argv': sys.argv[1:]}))\n")
        out = canton.main(["register-token", EVM_TOKEN])
        self.assertEqual(out["argv"], canton.propose_arguments(canton.Network(), EVM_TOKEN))
        self.assertEqual(out["argv"][0], "token")

    def test_propose_py_stopping_is_a_failure_with_its_words(self):
        self.stub("import sys\nprint('the gateway did not make the token', file=sys.stderr)\nsys.exit(1)\n")
        with self.assertRaises(canton.Fail) as why:
            canton.main(["register-token", EVM_TOKEN])
        self.assertIn("the gateway did not make the token", str(why.exception))

    def test_a_token_that_is_not_an_address_is_refused(self):
        for bad in ("0x12", "nobody", "0x" + "zz" * 20, EVM_TOKEN + "\n"):
            with self.assertRaises(SystemExit, msg=bad):
                canton.main(["register-token", bad])


class AcceptTests(LedgerTestCase):
    def test_a_party_makes_a_standing_acceptance_for_this_chain(self):
        out = canton.main(["accept", "u"])
        [acceptance] = self.made(canton.CHAIN + "WithdrawalAcceptance")
        self.assertEqual(acceptance, {"party": "u::1", "chainId": "770101", "operator": "op::1", "confirmer": "co::1", "gateway": "gw::1", "builder": "bu::1"})
        [(node, body)] = FakeLedger.submitted
        self.assertEqual((node, body["actAs"], body["userId"]), ("users", ["u::1"], "demo"))
        self.assertEqual(out["party"], "u::1")
        # The operator's participant sees it, which is where the builder looks for it.
        self.assertIn(("operator", "op::1", canton.CHAIN + "WithdrawalAcceptance"), FakeLedger.asked)

    def test_each_party_gets_its_own_acceptance(self):
        u, v = canton.main(["accept", "u"]), canton.main(["accept", "v"])
        self.assertEqual((u["party"], v["party"]), ("u::1", "v::1"))
        self.assertNotEqual(u["acceptance"], v["acceptance"])
        self.assertEqual(sorted(a["party"] for a in self.made(canton.CHAIN + "WithdrawalAcceptance")), ["u::1", "v::1"])

    def test_only_u_and_v_can_accept(self):
        for who in ("reader", "registry", "gateway", "x"):
            with self.assertRaises(SystemExit, msg=who):
                canton.main(["accept", who])
        self.assertEqual(FakeLedger.submitted, [])

    def test_no_chain_is_a_failure(self):
        FakeLedger.contracts.clear()
        with self.assertRaises(canton.Fail):
            canton.main(["accept", "u"])


class DepositTests(LedgerTestCase):
    def setUp(self):
        super().setUp()
        FakeLedger.contracts[("u::1", canton.TOKEN)] = [holding("u::1", "100.0", "hold-1")]

    def test_u_allocates_to_the_gateway_and_signs_the_request(self):
        out = canton.main(["deposit", "deposit-1", EVM_TOKEN, "10"])
        [(node, body)] = self.exercised("AllocationFactory_Allocate")
        self.assertEqual((node, body["actAs"], body["disclosedContracts"]), ("users", ["u::1"], [RULES]))
        command = body["commands"][0]["ExerciseCommand"]
        self.assertEqual(command["contractId"], "rules-1")
        argument = command["choiceArgument"]
        leg = argument["allocation"]
        self.assertEqual((argument["expectedAdmin"], argument["inputHoldingCids"]), ("rg::1", ["hold-1"]))
        self.assertEqual((leg["settlement"]["executor"], leg["settlement"]["settlementRef"]["id"]), ("op::1", "deposit-1"))
        self.assertEqual(leg["transferLeg"], {"sender": "u::1", "receiver": "gw::1", "amount": "10.0", "instrumentId": {"admin": "rg::1", "id": "TKB"}, "meta": {"values": {}}})
        [request] = self.made(canton.CHAIN + "DepositRequest")
        [allocation] = [e for e in FakeLedger.created if e["templateId"] == canton.ALLOCATION_OF_TOKEN]
        self.assertEqual(request["allocation"], allocation["contractId"])
        self.assertEqual({k: v for k, v in request.items() if k not in ("depositId", "allocation")},
                         {"operator": "op::1", "confirmer": "co::1", "gateway": "gw::1", "builder": "bu::1", "chainId": "770101", "depositor": "u::1", "recipient": "ab" * 20})
        self.assertRegex(request["depositId"], r"^[0-9a-f]{64}$")
        self.assertEqual(out["depositId"], request["depositId"])        # the id the EVM claim must carry
        self.assertEqual(out["recipient"], "0x" + "ab" * 20)
        request_event = [b for n, b in FakeLedger.submitted if "DepositRequest" in b["commands"][0].get("CreateCommand", {}).get("templateId", "")]
        self.assertEqual(request_event[0]["actAs"], ["u::1"])           # the depositor alone signs it
        self.assertIn(("operator", "op::1", canton.CHAIN + "DepositRequest"), FakeLedger.asked)   # and the operator's participant sees it

    def test_each_deposit_gets_a_new_id(self):
        first = canton.main(["deposit", "deposit-1", EVM_TOKEN, "10"])["depositId"]
        second = canton.main(["deposit", "deposit-2", EVM_TOKEN, "10"])["depositId"]
        self.assertNotEqual(first, second)

    def test_amounts_keep_their_decimals_and_are_written_as_daml_does(self):
        canton.main(["deposit", "d", EVM_TOKEN, "0.5"])
        canton.main(["deposit", "e", EVM_TOKEN, "1234.0000000001"])
        amounts = [b["commands"][0]["ExerciseCommand"]["choiceArgument"]["allocation"]["transferLeg"]["amount"] for _, b in self.exercised("AllocationFactory_Allocate")]
        self.assertEqual(amounts, ["0.5", "1234.0000000001"])

    def test_bad_arguments_and_a_missing_holding_are_refused(self):
        for argv in (["deposit", "d", "0x12", "10"], ["deposit", "d", EVM_TOKEN, "0"], ["deposit", "d", EVM_TOKEN, "-1"],
                     ["deposit", "d", EVM_TOKEN, "1.00000000001"], ["deposit", "d", EVM_TOKEN, "ten"], ["deposit", "", EVM_TOKEN, "1"]):
            with self.assertRaises(SystemExit, msg=str(argv)):
                canton.main(argv)
        self.assertEqual(FakeLedger.submitted, [])
        FakeLedger.contracts[("u::1", canton.TOKEN)] = []
        with self.assertRaises(canton.Fail):
            canton.main(["deposit", "d", EVM_TOKEN, "10"])


class DvpTests(LedgerTestCase):
    def setUp(self):
        super().setUp()
        FakeLedger.contracts[("u::1", canton.TOKEN)] = [holding("u::1", "100.0", "hold-1")]

    def test_u_allocates_to_v_and_both_sign_terms_with_the_payment_id(self):
        out = canton.main(["dvp", "dvp-1", EVM_TOKEN, "0x" + "CD" * 20, "10"])
        [(_, body)] = self.exercised("AllocationFactory_Allocate")
        leg = body["commands"][0]["ExerciseCommand"]["choiceArgument"]["allocation"]
        self.assertEqual((leg["transferLeg"]["sender"], leg["transferLeg"]["receiver"], leg["transferLeg"]["amount"], leg["settlement"]["executor"]),
                         ("u::1", "v::1", "10.0", "op::1"))
        [terms] = self.made(canton.CHAIN + "DvpTerms")
        [allocation] = [e for e in FakeLedger.created if e["templateId"] == canton.ALLOCATION_OF_TOKEN]
        self.assertEqual(terms, {"u": "u::1", "v": "v::1", "operator": "op::1", "confirmer": "co::1", "builder": "bu::1", "chainId": "770101",
                                 "label": "dvp-1", "dvpId": canton.payment_id("u::1", "v::1", "dvp-1"), "token": "ab" * 20, "payee": "cd" * 20,
                                 "amount": f"{10 * 10**18:064x}", "allocation": allocation["contractId"]})
        [signed] = [b for _, b in FakeLedger.submitted if "DvpTerms" in b["commands"][0].get("CreateCommand", {}).get("templateId", "")]
        self.assertEqual(signed["actAs"], ["u::1", "v::1"])
        self.assertEqual(out["id"], terms["dvpId"])                      # the id V's EVM payment must carry
        self.assertEqual((out["label"], out["allocation"]), ("dvp-1", allocation["contractId"]))

    def test_two_labels_give_two_ids(self):
        a = canton.main(["dvp", "dvp-1", EVM_TOKEN, EVM_TOKEN, "10"])["id"]
        b = canton.main(["dvp", "dvp-2", EVM_TOKEN, EVM_TOKEN, "10"])["id"]
        self.assertNotEqual(a, b)

    def test_bad_arguments_are_refused(self):
        for argv in (["dvp", "dvp-1", "0x12", EVM_TOKEN, "10"], ["dvp", "dvp-1", EVM_TOKEN, "nobody", "10"], ["dvp", "dvp-1", EVM_TOKEN, EVM_TOKEN, "0"],
                     ["dvp", "dvp-1", EVM_TOKEN, EVM_TOKEN, "1.5"], ["dvp", "", EVM_TOKEN, EVM_TOKEN, "10"], ["dvp", "dvp-1", EVM_TOKEN, EVM_TOKEN]):
            with self.assertRaises(SystemExit, msg=str(argv)):
                canton.main(argv)
        self.assertEqual(FakeLedger.submitted, [])


class StatusTests(LedgerTestCase):
    def test_status_shows_the_gateways_custody_as_the_gateway_sees_it(self):
        FakeLedger.contracts.update({("gw::1", canton.TOKEN): [holding("gw::1", "6.0", "g1"), holding("gw::1", "4.0", "g2")],
                                     ("u::1", canton.TOKEN): [holding("u::1", "90.0", "u1")], ("v::1", canton.TOKEN): []})
        got = canton.main(["status"])
        self.assertEqual(got["custody"], [4, 6])
        self.assertEqual(got["tkb"], {"u": [90], "v": []})
        self.assertEqual(got["chain"], [{"headNumber": 3, "headHash": "ab" * 32}])
        self.assertIn(("operator", "gw::1", canton.TOKEN), FakeLedger.asked)   # the gateway is hosted on the operator's participant

    def test_status_counts_deposit_requests_and_acceptances(self):
        FakeLedger.contracts.update({("op::1", canton.CHAIN + "DepositRequest"): [record(0, 1, "d1")], ("op::1", canton.CHAIN + "WithdrawalAcceptance"): [record(0, 1, "a1"), record(0, 2, "a2")]})
        got = canton.main(["status"])
        self.assertEqual((got["deposits"], got["acceptances"]), (1, 2))


class ResubmitTests(LedgerTestCase):
    ARGUMENT = {"headerHex": "01", "txsHex": "", "proofHex": "ab" * 4, "gatewayAccountNodes": ["aa"], "gatewayStorageNodes": ["bb"],
                "legs": [{"tag": "PaymentLeg", "value": {"terms": "terms-1"}}]}

    def file(self, argument=None):
        path = self.state / "advance.json"
        path.write_text(json.dumps(self.ARGUMENT if argument is None else argument))
        return str(path)

    def test_the_block_is_sent_again_without_its_legs(self):
        path = self.file()
        out = canton.main(["resubmit", path])
        self.assertEqual(out, {"committed": True})
        [(node, body)] = FakeLedger.submitted
        self.assertEqual((node, body["actAs"], body["userId"]), ("operator", ["bu::1"], "builder"))
        command = body["commands"][0]["ExerciseCommand"]
        self.assertEqual((command["contractId"], command["choice"], command["templateId"]), ("chain-1", "Advance", canton.CHAIN + "ZkChain"))
        self.assertEqual(command["choiceArgument"], {**self.ARGUMENT, "legs": []})   # everything else is as it was sent
        self.assertEqual(json.loads(Path(path).read_text()), self.ARGUMENT)           # the saved file is not changed

    def test_canton_refusing_it_is_an_answer_not_a_crash(self):
        FakeLedger.refuse = '{"cause":"the legs are not the ones the block recorded: no"}'
        out = canton.main(["resubmit", self.file()])
        self.assertIs(out["committed"], False)
        self.assertIn("the legs are not the ones the block recorded", out["reason"])

    def run_script(self):
        return subprocess.run([sys.executable, str(ROOT / "demo" / "canton.py"), "resubmit", self.file()], capture_output=True, text=True, env=os.environ)

    def test_the_script_exits_2_when_canton_refuses_the_block(self):
        FakeLedger.refuse = '{"cause":"the legs are not the ones the block recorded: no"}'
        done = self.run_script()
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIs(json.loads(done.stdout)["committed"], False)

    def test_the_script_exits_0_when_canton_commits_it(self):
        done = self.run_script()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIs(json.loads(done.stdout)["committed"], True)

    def test_a_file_that_is_not_an_advance_argument_is_refused(self):
        for bad in ({}, [], {"legs": "x"}, {"headerHex": "01"}, {**self.ARGUMENT, "legs": []}):
            with self.assertRaises(canton.Fail, msg=str(bad)):
                canton.main(["resubmit", self.file(bad)])
        with self.assertRaises(canton.Fail):
            canton.main(["resubmit", str(self.state / "missing.json")])
        self.assertEqual(FakeLedger.submitted, [])


class BadArgumentsTests(LedgerTestCase):
    def test_unknown_commands_print_the_help(self):
        for argv in ([], ["nothing"], ["payment-id"], ["accept"], ["resubmit"], ["register-token"], ["status", "x"]):
            with self.assertRaises(SystemExit, msg=str(argv)):
                canton.main(argv)


if __name__ == "__main__":
    unittest.main()
