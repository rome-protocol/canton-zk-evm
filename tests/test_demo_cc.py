"""Tests for demo/cc.py with a fake scan proxy (a local HTTP server), a fake Ledger API (one participant, as on DevNet) and a fake Ostia (demo/evm.py's rpc and send).
Run: python3 -W error::ResourceWarning -m unittest tests/test_demo_cc.py"""
import contextlib, http.server, io, json, os, sys, tempfile, threading, unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "demo"))
import canton, cc, evm, twin

DSO = "DSO::1220" + "d5" * 32
VALIDATOR = "validator::1220" + "a1" * 32
U = "u::1220" + "b2" * 32
V = "v::1220" + "c3" * 32
GW = "gw::1220" + "e4" * 32
OP = "op::1220" + "f5" * 32
CO = "co::1220" + "07" * 32
OTHER = "other::1220" + "18" * 32
PARTIES = {"OPERATOR": OP, "CONFIRMER": CO, "BUILDER": "bu::1220" + "29" * 32, "GATEWAY": GW, "READER": "re::1220" + "3a" * 32, "U": U, "V": V, "REGISTRY": "rg::1220" + "4b" * 32}
FACTORY = "00" + "fa" * 34
TOKENS = {"SCAN": "scan-secret-" + "5" * 20, "DEMO": "demo-secret-" + "6" * 20, "OPERATOR": "operator-secret-" + "7" * 20, "CONFIRMER": "confirmer-secret-" + "8" * 20,
          "ADMIN": "admin-secret-" + "9" * 20, "SENDER": "sender-secret-" + "0" * 20}
WRAPPED = "ab" * 20
GATEWAY = evm.gateway_address()
SYNC = "global-domain::1220" + "66" * 32


def contract(name: str, template: str) -> dict:
    return {"templateId": template, "contractId": "00" + name.encode().hex().ljust(40, "0"), "createdEventBlob": "blob-" + name, "synchronizerId": SYNC}


PKG = "ab" * 32
DISCLOSED = [contract("amuletrules", PKG + ":Splice.AmuletRules:AmuletRules"), contract("round", PKG + ":Splice.Round:OpenMiningRound"),
             contract("config", PKG + ":Splice.ExternalPartyConfigState:ExternalPartyConfigState"),
             {**contract("factory", PKG + ":Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules"), "contractId": FACTORY}]


def factory_answer(kind="self") -> dict:
    return {"factoryId": FACTORY, "transferKind": kind, "choiceContext": {"choiceContextData": {"values": {"open-round": {"tag": "AV_ContractId", "value": DISCLOSED[1]["contractId"]}}},
                                                                          "disclosedContracts": [dict(d) for d in DISCLOSED]}}


class FakeScan(http.server.BaseHTTPRequestHandler):
    """The validator API's scan proxy. `answers` maps a path to (status, body) or a function of the request body; `seen` has (method, path, headers, body) of each request."""
    answers: dict = {}
    seen: list = []

    def log_message(self, *args):
        pass

    def respond(self, body):
        status, answer, *more = body if isinstance(body, tuple) else (200, body)
        data = answer if isinstance(answer, bytes) else json.dumps(answer).encode()
        self.send_response(status)
        for name, value in (more[0] if more else {}).items():
            self.send_header(name, value)
        self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def handle_any(self, method):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        FakeScan.seen.append((method, self.path, dict(self.headers), body))
        answer = FakeScan.answers.get(self.path)
        self.respond((404, "nothing here") if answer is None else (answer(body) if callable(answer) else answer))

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")


BASE = "/api/validator/v0"
ACCEPT = BASE + "/scan-proxy/registry/transfer-instruction/v1/%s/choice-contexts/accept"
FACTORY_PATH = BASE + "/scan-proxy/registry/transfer-instruction/v1/transfer-factory"


class FakeLedger(http.server.BaseHTTPRequestHandler):
    """One participant's Ledger API. `events` maps a template to its created events (what the operator sees); `requests` has (path, authorization header, body) of each call."""
    events: dict = {}
    holdings: dict = {}      # party -> [{cid, amount, lock}] of Canton Coin (instrument Amulet of the DSO)
    requests: list = []
    commands: list = []
    on_submit = None         # called with the body of each submit-and-wait: what the command makes on the ledger

    def log_message(self, *args):
        pass

    def reply(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        FakeLedger.requests.append((self.path, self.headers.get("authorization"), None))
        self.reply({"offset": 7})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        FakeLedger.requests.append((self.path, self.headers.get("authorization"), body))
        if self.path == "/v2/state/active-contracts":
            [(party, flt)] = body["eventFormat"]["filtersByParty"].items()
            identifier = flt["cumulative"][0]["identifierFilter"]
            if "TemplateFilter" in identifier:
                found = FakeLedger.events.get(identifier["TemplateFilter"]["value"]["templateId"], [])
                self.reply([{"contractEntry": {"JsActiveContract": {"createdEvent": e, "synchronizerId": SYNC}}} for e in found])
            else:
                value = identifier["InterfaceFilter"]["value"]
                assert value["includeInterfaceView"] and value["interfaceId"] == cc.HOLDING_INTERFACE
                self.reply([{"contractEntry": {"JsActiveContract": {"createdEvent": holding_event(party, h), "synchronizerId": SYNC}}} for h in FakeLedger.holdings.get(party, [])])
        elif self.path == "/v2/commands/submit-and-wait":
            FakeLedger.commands.append(body)
            if FakeLedger.on_submit:
                FakeLedger.on_submit(body)
            self.reply({"updateId": "update-x"})
        elif self.path == "/v2/commands/submit-and-wait-for-transaction":
            FakeLedger.commands.append(body)
            self.reply(FakeLedger.transaction(body))
        else:
            self.reply("", 404)

    transaction = staticmethod(lambda body: {"transaction": {"updateId": "update-t", "events": []}})


def holding_event(owner: str, h: dict) -> dict:
    view = {"owner": owner, "instrumentId": h.get("instrument", {"admin": DSO, "id": cc.AMULET}), "amount": h["amount"], "lock": h.get("lock"), "meta": {"values": {}}}
    return {"contractId": h["cid"], "templateId": PKG + ":Splice.Amulet:Amulet", "interfaceViews": [{"interfaceId": PKG + cc.HOLDING_VIEW, "viewStatus": {"code": 0}, "viewValue": view}]}


def serve(handler, name: str, test: unittest.TestCase) -> str:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), type(name, (handler,), {}))
    thread = threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True)
    thread.start()
    test.addCleanup(thread.join)
    test.addCleanup(server.server_close)
    test.addCleanup(server.shutdown)
    return f"http://127.0.0.1:{server.server_address[1]}"


class FakeOstia:
    """reth and the gateway: a token made by register(), `wrapped` (the tokens the gateway shows as its own), the transactions sent, and the supply of the wrapped token."""
    def __init__(self):
        self.sent, self.wrapped, self.supply, self.calls = [], set(), {}, []
        self.balances, self.on_send, self.status = {}, None, 1   # the wrapped token's balance of each holder (lowercase address), a hook for each send, the receipt's status

    def send(self, folder, who, to, data, gas, *rest):
        self.sent.append({"who": who, "to": to, "data": data, "gas": gas})
        if self.on_send:
            self.on_send(data)
        self.wrapped.add(WRAPPED)
        return "0x" + "cd" * 32

    def rpc(self, method, params):
        self.calls.append((method, params))
        if method == "eth_call":
            call, tag = params
            if "from" in call:   # register(string,string), asked before it is sent: the address it would make
                return "0x" + "00" * 12 + WRAPPED
            if call["to"].lower() == GATEWAY.lower():   # wrapped(address)
                return "0x" + "0" * 63 + ("1" if call["data"][-40:] in self.wrapped else "0")
            if call["data"].startswith("0x" + evm.SELECTOR_BALANCE_OF):
                return hex(self.balances.get("0x" + call["data"][-40:], 0))
            if call["data"] == "0x" + evm.SELECTOR_TOTAL_SUPPLY:
                return hex(self.supply.get(call["to"].lower().removeprefix("0x"), 0))
        if method == "eth_getTransactionReceipt":
            return {"blockNumber": hex(9), "blockHash": "0x" + "bb" * 32, "gasUsed": hex(1234), "status": hex(self.status), "contractAddress": None}
        if method == "eth_getBlockByNumber":
            return {"number": hex(12), "hash": "0x" + "bb" * 32, "gasUsed": hex(0)} if params[0] == "finalized" else {"number": params[0], "hash": "0x" + "bb" * 32, "gasUsed": hex(0)}
        if method == "eth_getTransactionCount":
            return hex(0)
        if method == "eth_chainId":
            return hex(770101)
        raise AssertionError(f"{method} {params}")


class CcCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name)
        (self.state / "canton").mkdir()
        (self.state / "demo").mkdir()
        (self.state / "canton" / "parties.env").write_text("".join(f"{k}_PARTY={v}\n" for k, v in PARTIES.items()))
        self.files = {}
        for role, token in TOKENS.items():
            path = self.state / f"{role.lower()}.token"
            path.write_text(token + "\n")
            path.chmod(0o600)
            self.files[role] = str(path)
        FakeScan.seen, FakeScan.answers = [], {
            BASE + "/scan-proxy/dso-party-id": {"dso_party_id": DSO}, BASE + "/validator-user": {"party_id": VALIDATOR}, FACTORY_PATH: lambda body: factory_answer("self" if body["choiceArguments"]["transfer"]["sender"] == body["choiceArguments"]["transfer"]["receiver"] else "direct")}
        FakeLedger.events, FakeLedger.holdings, FakeLedger.requests, FakeLedger.commands, FakeLedger.on_submit = {}, {}, [], [], None
        self.scan_url = serve(FakeScan, "scan", self) + BASE + "/scan-proxy"
        ledger = serve(FakeLedger, "ledger", self)
        environment = {"CZE_STATE_DIR": str(self.state), "CZE_CANTON": "external", "CZE_LEDGER_URL": ledger, "CZE_POLL_SECONDS": "0",
                       **{"CZE_TOKEN_FILE_" + k: v for k, v in self.files.items() if k not in ("SCAN",)}, "CZE_SCAN_PROXY_URL": self.scan_url, "CZE_SCAN_TOKEN_FILE": self.files["SCAN"]}
        patcher = mock.patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.ostia = FakeOstia()
        for p in (mock.patch.object(evm, "send", self.ostia.send), mock.patch.object(evm, "rpc", self.ostia.rpc), mock.patch.object(evm, "state_dir", lambda: self.state)):
            p.start()
            self.addCleanup(p.stop)
        self.run_cc = lambda *argv: cc.main(list(argv))

    def run_printed(self, *argv):
        """cc.main with what it printed: (result, stdout, stderr)."""
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = cc.main(list(argv))
        return result, out.getvalue(), err.getvalue()

    def assertNoSecrets(self, *texts):
        for text in texts:
            for role, token in TOKENS.items():
                self.assertNotIn(token, text, role)


class RegisterCase(CcCase):
    def setUp(self):
        super().setUp()
        self.propose = self.state / "propose.py"
        self.propose.write_text("import json, os, sys\nopen(os.environ['PROPOSE_LOG'], 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n"
                                "a = sys.argv[1:]\nprint(json.dumps({'contractId': 'gt-1', 'evmToken': a[a.index('--evm-token') + 1], "
                                "'instrumentId': {'admin': a[a.index('--instrument-admin') + 1], 'id': a[a.index('--instrument-id') + 1]}}))\n")
        self.log = self.state / "propose.log"
        for p in (mock.patch.object(canton, "PROPOSE", self.propose), mock.patch.dict(os.environ, {"PROPOSE_LOG": str(self.log)})):
            p.start()
            self.addCleanup(p.stop)

    def proposed(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def made_token(self, factory=FACTORY):
        FakeLedger.events[canton.CHAIN + "GatewayToken"] = [{"contractId": "gt-1", "createArgument": {"evmToken": WRAPPED, "instrumentId": {"admin": DSO, "id": "Amulet"}, "factory": factory}}]


class RegisterTests(RegisterCase):
    def test_the_first_run_makes_the_wrapped_token_and_registers_it_with_the_scan_proxys_factory(self):
        got, out, err = self.run_printed("register")
        self.assertEqual(got, {"created": True, "evmToken": "0x" + WRAPPED, "gatewayToken": "gt-1", "instrumentId": {"admin": DSO, "id": "Amulet"}, "factory": FACTORY,
                               "factoryIsScanProxys": True, "registerTx": "0x" + "cd" * 32})
        [sent] = self.ostia.sent   # as evm.py register: U calls register(name, symbol) on the gateway
        self.assertEqual((sent["who"], sent["to"].lower()), ("u", GATEWAY.lower()))
        self.assertEqual(sent["data"], evm.call_data("register(string,string)", ["Canton Coin", "CC"]))
        [argv] = self.proposed()
        self.assertEqual(argv[:1], ["token"])
        self.assertEqual({argv[i]: argv[i + 1] for i in range(1, len(argv), 2)}, {"--evm-token": WRAPPED, "--instrument-admin": DSO, "--instrument-id": "Amulet", "--factory": FACTORY})
        self.assertEqual(json.loads((self.state / "demo" / "cc.json").read_text())["evmToken"], WRAPPED)
        self.assertNoSecrets(out, err, json.dumps(got), *map(json.dumps, self.proposed()))

    def test_the_scan_proxy_is_asked_for_the_dso_the_validator_and_a_self_transfer_with_the_token_and_the_contact(self):
        self.run_cc("register")
        paths = [(m, p) for m, p, _, _ in FakeScan.seen]
        self.assertEqual(paths, [("GET", BASE + "/scan-proxy/dso-party-id"), ("GET", BASE + "/validator-user"), ("POST", FACTORY_PATH)])
        for _, _, headers, _ in FakeScan.seen:
            self.assertEqual(headers["User-Agent"], "Rome Protocol rome@romeprotocol.com")
            self.assertEqual(headers["Authorization"], "Bearer " + TOKENS["SCAN"])
        body = FakeScan.seen[2][3]
        self.assertTrue(body["excludeDebugFields"])
        args = body["choiceArguments"]
        t = args["transfer"]
        self.assertEqual((args["expectedAdmin"], t["sender"], t["receiver"], t["instrumentId"], t["inputHoldingCids"], t["meta"]), (DSO, VALIDATOR, VALIDATOR, {"admin": DSO, "id": "Amulet"}, [], {"values": {}}))
        self.assertLess(t["requestedAt"], t["executeBefore"])
        self.assertEqual(args["extraArgs"], {"context": {"values": {}}, "meta": {"values": {}}})

    def test_a_second_run_changes_nothing_and_prints_what_exists(self):
        self.made_token()
        got = self.run_cc("register")
        self.assertEqual(got, {"created": False, "evmToken": "0x" + WRAPPED, "gatewayToken": "gt-1", "instrumentId": {"admin": DSO, "id": "Amulet"}, "factory": FACTORY,
                               "factoryIsScanProxys": True, "registerTx": None})
        self.assertEqual((self.ostia.sent, self.proposed(), FakeLedger.commands), ([], [], []))

    def test_a_registered_factory_that_the_scan_proxy_no_longer_names_is_said_so(self):
        self.made_token(factory="00" + "11" * 34)
        got = self.run_cc("register")
        self.assertEqual((got["created"], got["factory"], got["factoryIsScanProxys"]), (False, "00" + "11" * 34, False))
        self.assertEqual((self.ostia.sent, self.proposed()), ([], []))

    def test_only_the_gateway_token_of_canton_coin_counts(self):
        FakeLedger.events[canton.CHAIN + "GatewayToken"] = [{"contractId": "gt-9", "createArgument": {"evmToken": "cd" * 20, "instrumentId": {"admin": DSO, "id": "TKB"}, "factory": FACTORY}}]
        self.assertTrue(self.run_cc("register")["created"])
        FakeLedger.events[canton.CHAIN + "GatewayToken"] = [{"contractId": f"gt-{i}", "createArgument": {"evmToken": WRAPPED, "instrumentId": {"admin": DSO, "id": "Amulet"}, "factory": FACTORY}} for i in (1, 2)]
        with self.assertRaisesRegex(canton.Fail, "2 GatewayTokens"):
            self.run_cc("register")

    def test_a_run_that_stopped_after_ostia_makes_no_second_token(self):
        (self.state / "demo" / "cc.json").write_text(json.dumps({"gateway": GATEWAY, "evmToken": WRAPPED, "tx": "0x01"}))
        self.ostia.wrapped.add(WRAPPED)
        got = self.run_cc("register")
        self.assertEqual((got["created"], got["evmToken"], got["registerTx"], self.ostia.sent), (True, "0x" + WRAPPED, None, []))
        self.assertEqual(self.proposed()[0][self.proposed()[0].index("--evm-token") + 1], WRAPPED)

    def test_a_recorded_token_that_the_gateway_does_not_show_is_not_used(self):
        (self.state / "demo" / "cc.json").write_text(json.dumps({"gateway": GATEWAY, "evmToken": "cd" * 20, "tx": "0x01"}))
        self.run_cc("register")
        self.assertEqual(len(self.ostia.sent), 1)
        (self.state / "demo" / "cc.json").write_text(json.dumps({"gateway": "0x" + "99" * 20, "evmToken": WRAPPED, "tx": "0x01"}))   # another gateway's
        self.ostia.wrapped.add(WRAPPED)
        self.run_cc("register")
        self.assertEqual(len(self.ostia.sent), 2)

    def test_a_token_that_the_gateway_did_not_make_stops_before_canton(self):
        self.ostia.send = lambda *a, **k: "0x" + "cd" * 32   # the transaction made nothing the gateway shows
        with mock.patch.object(evm, "send", self.ostia.send), self.assertRaisesRegex(canton.Fail, "did not make the token"):
            self.run_cc("register")
        self.assertEqual(self.proposed(), [])

    def test_a_proposal_that_is_left_is_finished_with_its_own_token_and_this_factory(self):
        FakeLedger.events[canton.CHAIN + "GatewayTokenProposal"] = [{"contractId": "p-1", "createArgument": {"evmToken": "cd" * 20, "instrumentId": {"admin": DSO, "id": "Amulet"}, "factory": FACTORY}}]
        done = {"contractId": "gt-2", "evmToken": "cd" * 20, "instrumentId": {"admin": DSO, "id": "Amulet"}}
        with mock.patch.object(canton, "register_token", return_value=done) as register:
            got = self.run_cc("register")
        self.assertEqual(register.call_args.args[1:], ("cd" * 20, {"admin": DSO, "id": "Amulet"}, FACTORY))
        self.assertEqual((got["gatewayToken"], got["evmToken"], self.ostia.sent), ("gt-2", "0x" + "cd" * 20, []))

    def test_options_override_the_environment_and_a_bad_command_line_prints_the_usage(self):
        with mock.patch.dict(os.environ, {"CZE_SCAN_PROXY_URL": "http://elsewhere.example/api/validator/v0/scan-proxy"}):
            self.assertTrue(self.run_cc("register", "--scan-proxy", self.scan_url + "/", "--scan-token-file", self.files["SCAN"])["created"])
        for argv in (["register", "x"], ["register", "--other", "x"], ["register", "--scan-proxy"], ["register", "--scan-proxy", "a", "--scan-proxy", "b"], ["nothing"], []):
            with self.assertRaises(SystemExit, msg=argv) as why:
                self.run_cc(*argv)
            self.assertIn("cc.py register", str(why.exception))


class ScanAnswerTests(RegisterCase):
    """What a scan proxy answers is not trusted: a bad answer stops the command before anything goes to Ostia or Canton."""
    def refuses(self, why, **answers):
        FakeScan.answers.update(answers)
        with self.assertRaisesRegex(canton.Fail, why):
            self.run_cc("register")
        self.assertEqual((self.ostia.sent, self.proposed(), FakeLedger.commands), ([], [], []))

    def bad_factory(self, why, change):
        def answer(body):
            a = factory_answer()
            change(a)
            return a
        self.refuses(why, **{FACTORY_PATH: answer})

    def test_the_dso_and_the_validator_are_party_ids(self):
        for bad in ({}, {"dso_party_id": 5}, {"dso_party_id": "no-fingerprint"}, {"dso_party_id": "DSO::1220" + "d5" * 32 + "\n"}, {"dso_party_id": ""}):
            self.refuses("DSO party", **{BASE + "/scan-proxy/dso-party-id": bad})
        FakeScan.answers[BASE + "/scan-proxy/dso-party-id"] = {"dso_party_id": DSO}
        self.refuses("validator's party", **{BASE + "/validator-user": {"party_id": ["x"]}})

    def test_a_redirect_is_not_followed_and_the_token_goes_nowhere_else(self):
        class Other(http.server.BaseHTTPRequestHandler):
            seen: list = []
            def log_message(self, *args):
                pass
            def do_GET(self):
                Other.seen.append(dict(self.headers))
                data = json.dumps({"dso_party_id": DSO}).encode()
                self.send_response(200); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
        other = serve(Other, "other", self)
        for status in (301, 302, 303, 307):
            with self.subTest(status):
                self.refuses("redirect", **{BASE + "/scan-proxy/dso-party-id": lambda body: (status, b"", {"location": other + "/anywhere"})})
                self.assertEqual(Other.seen, [])   # nothing reached the other server, so no token either

    def test_an_answer_that_is_not_a_json_object_or_is_an_error_is_refused(self):
        self.refuses("did not answer with JSON", **{FACTORY_PATH: b"<html>"})
        self.refuses("not answer with a JSON object", **{FACTORY_PATH: [1]})
        self.refuses("500", **{FACTORY_PATH: (500, "boom")})
        self.refuses("404", **{FACTORY_PATH: (404, "no")})

    def test_an_answer_over_the_size_cap_is_refused(self):
        big = factory_answer()
        big["choiceContext"]["disclosedContracts"][0]["createdEventBlob"] = "x" * 5000
        with mock.patch.object(twin, "MAX_ANSWER", 4000):
            self.refuses("more than 4000 bytes", **{FACTORY_PATH: big})
        with mock.patch.object(cc, "MAX_BLOB", 1000):   # a blob over the cap inside an answer that is small enough for the reader
            self.refuses("without templateId", **{FACTORY_PATH: big})

    def test_the_factory_must_be_a_contract_id_that_is_disclosed_and_an_external_party_amulet_rules(self):
        self.bad_factory("no factoryId", lambda a: a.pop("factoryId"))
        self.bad_factory("no factoryId", lambda a: a.update(factoryId="not-a-cid"))
        self.bad_factory("did not disclose the factory", lambda a: a.update(factoryId="00" + "77" * 34))
        self.bad_factory("not an ExternalPartyAmuletRules", lambda a: a["choiceContext"]["disclosedContracts"][3].update(templateId=PKG + ":Splice.AmuletRules:AmuletRules"))
        self.bad_factory("not an ExternalPartyAmuletRules", lambda a: a["choiceContext"]["disclosedContracts"][3].update(templateId=PKG + ":Evil.Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules"))

    def test_the_disclosed_contracts_carry_the_four_fields_and_only_those_go_on(self):
        for key in twin.DISCLOSED_KEYS:
            self.bad_factory("without templateId", lambda a, key=key: a["choiceContext"]["disclosedContracts"][0].pop(key))
        self.bad_factory("without templateId", lambda a: a["choiceContext"]["disclosedContracts"][0].update(createdEventBlob=""))
        self.bad_factory("without templateId", lambda a: a["choiceContext"]["disclosedContracts"].append("x"))
        self.bad_factory("not one", lambda a: a["choiceContext"]["disclosedContracts"][0].update(templateId="no template"))
        self.bad_factory("not one", lambda a: a["choiceContext"]["disclosedContracts"][0].update(contractId="zz"))
        self.bad_factory("twice", lambda a: a["choiceContext"]["disclosedContracts"].append(dict(a["choiceContext"]["disclosedContracts"][0])))
        self.bad_factory("too many, or none", lambda a: a["choiceContext"].update(disclosedContracts=[]))
        self.bad_factory("too many, or none", lambda a: a["choiceContext"].update(disclosedContracts=[dict(DISCLOSED[3])] + [contract(str(i), PKG + ":A:B") for i in range(cc.MAX_DISCLOSED)]))
        data, contracts = cc.checked_context({"choiceContextData": {"values": {}}, "disclosedContracts": [{**DISCLOSED[0], "debug": "x"}]})
        self.assertEqual(contracts, [DISCLOSED[0]])
        self.assertEqual(data, {"values": {}})

    def test_the_choice_context_data_is_a_bounded_map_of_values(self):
        self.bad_factory("no choiceContextData", lambda a: a["choiceContext"].pop("choiceContextData"))
        self.bad_factory("no choiceContextData", lambda a: a["choiceContext"].update(choiceContextData={"values": [1]}))
        self.bad_factory("no choiceContextData", lambda a: a.update(choiceContext=[]))
        self.bad_factory("too many", lambda a: a["choiceContext"]["choiceContextData"].update(values={str(i): {} for i in range(cc.MAX_CONTEXT_VALUES + 1)}))

    def test_the_transfer_kind_fits_the_parties(self):
        self.bad_factory("transferKind", lambda a: a.update(transferKind="direct"))   # a transfer to oneself is "self"
        self.bad_factory("transferKind", lambda a: a.update(transferKind="burn"))
        self.bad_factory("transferKind", lambda a: a.pop("transferKind"))


class TokenTests(RegisterCase):
    def test_the_scan_token_is_never_printed_even_when_the_server_echoes_it(self):
        FakeScan.answers[FACTORY_PATH] = lambda body: (500, "denied for Bearer " + TOKENS["SCAN"])
        with self.assertRaises(canton.Fail) as why:
            self.run_cc("register")
        self.assertIn("denied for Bearer <token>", str(why.exception))
        self.assertNoSecrets(str(why.exception))
        FakeScan.answers[FACTORY_PATH] = lambda body: factory_answer()
        result, out, err = self.run_printed("register")
        self.assertNoSecrets(out, err, json.dumps(result))

    def test_the_main_program_prints_the_result_or_a_failure_without_a_token(self):
        import subprocess
        env = {**os.environ, "CZE_SCAN_PROXY_URL": self.scan_url}
        FakeScan.answers[FACTORY_PATH] = (500, "denied for Bearer " + TOKENS["SCAN"])
        done = subprocess.run([sys.executable, str(ROOT / "demo" / "cc.py"), "register"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(done.returncode, 1)
        self.assertTrue(done.stderr.startswith("FAIL: "), done.stderr)
        self.assertNoSecrets(done.stdout, done.stderr)

    def test_a_token_file_that_others_can_read_stops_the_command_before_any_request(self):
        os.chmod(self.files["SCAN"], 0o644)
        with self.assertRaises(SystemExit) as why:
            self.run_cc("register")
        self.assertIn("chmod 600", str(why.exception))
        self.assertNoSecrets(str(why.exception))
        self.assertEqual(FakeScan.seen, [])

    def test_no_scan_token_file_or_url_is_refused(self):
        for variable in ("CZE_SCAN_TOKEN_FILE", "CZE_SCAN_PROXY_URL"):
            with mock.patch.dict(os.environ):
                del os.environ[variable]
                with self.assertRaises(SystemExit):
                    self.run_cc("register")

    def test_the_scan_proxy_url_is_https_or_loopback_and_ends_in_scan_proxy(self):
        for url in ("http://validator.example/api/validator/v0/scan-proxy", "ftp://x/scan-proxy", "https://v.example/api/validator/v0", "", "https://v.example/api/validator/v0/scan-proxy-x"):
            with self.assertRaises(SystemExit, msg=url):
                self.run_cc("register", "--scan-proxy", url)
        self.assertEqual(FakeScan.seen, [])
        self.assertEqual(cc.Scan("https://v.example/api/validator/v0/scan-proxy/", self.files["SCAN"]).root, "https://v.example/api/validator/v0")

    def test_the_ledger_users_tokens_are_checked_before_anything_is_sent(self):
        os.chmod(self.files["CONFIRMER"], 0o644)
        with self.assertRaises(SystemExit):
            self.run_cc("register")
        self.assertEqual((FakeScan.seen, self.ostia.sent), ([], []))


def held(cid, amount, locked=False, **more):
    return {"cid": cid, "amount": amount, "lock": {"holders": [OP], "expiresAt": None, "context": "x"} if locked else None, **more}


class BalancesTests(CcCase):
    def setUp(self):
        super().setUp()
        FakeLedger.holdings = {U: [held("00u1", "5.0"), held("00u2", "2.5"), held("00u3", "1.25", locked=True), held("00u4", "100.0", instrument={"admin": DSO, "id": "TKB"}),
                                   held("00u5", "7.0", instrument={"admin": OTHER, "id": "Amulet"})],
                               V: [], GW: [held("00g1", "10.0"), held("00g2", "3.0000000001", locked=True)], VALIDATOR: [held("00x1", "4000.5")], OTHER: [held("00o1", "0.0000000001")]}
        FakeLedger.events[canton.CHAIN + "GatewayToken"] = [{"contractId": "gt-1", "createArgument": {"evmToken": WRAPPED, "instrumentId": {"admin": DSO, "id": "Amulet"}, "factory": FACTORY}}]
        self.ostia.supply[WRAPPED] = 115 * 10**9

    def read_as(self):
        """(authorization header, party) of each look at the active contracts."""
        out = []
        for path, auth, body in FakeLedger.requests:
            if path == "/v2/state/active-contracts" and "InterfaceFilter" in json.dumps(body):
                out.append((auth, next(iter(body["eventFormat"]["filtersByParty"]))))
        return out

    def test_each_partys_unlocked_and_locked_canton_coin_only_of_the_instrument_amulet_of_the_dso(self):
        got = self.run_cc("balances")
        self.assertEqual(got["instrument"], {"admin": DSO, "id": "Amulet"})
        self.assertEqual(got["parties"], {"u": {"party": U, "unlocked": "7.5", "locked": "1.25"}, "v": {"party": V, "unlocked": "0.0", "locked": "0.0"}})
        self.assertEqual(got["gatewayCustody"], {"party": GW, "unlocked": "10.0", "locked": "3.0000000001"})

    def test_the_wrapped_tokens_supply_is_read_at_the_finalized_block(self):
        got = self.run_cc("balances")
        self.assertEqual(got["wrapped"], {"registered": True, "evmToken": "0x" + WRAPPED, "totalSupply": "11.5", "block": 12})
        [(_, params)] = [(m, p) for m, p in self.ostia.calls if m == "eth_call"]
        self.assertEqual((params[0], params[1]), ({"to": "0x" + WRAPPED, "data": "0x" + evm.SELECTOR_TOTAL_SUPPLY}, hex(12)))   # the finalized block's number, not "latest"

    def test_no_gateway_token_means_no_wrapped_token_to_read(self):
        FakeLedger.events[canton.CHAIN + "GatewayToken"] = []
        self.assertEqual(self.run_cc("balances")["wrapped"], {"registered": False})
        self.assertEqual([m for m, _ in self.ostia.calls if m == "eth_call"], [])

    def test_a_named_party_is_u_v_or_a_party_id_and_others_are_read_with_the_admin_token(self):
        got = self.run_cc("balances", "v", OTHER, VALIDATOR)
        self.assertEqual(list(got["parties"]), ["v", OTHER, VALIDATOR])
        self.assertEqual((got["parties"][OTHER]["unlocked"], got["parties"][VALIDATOR]["unlocked"]), ("0.0000000001", "4000.5"))
        reads = self.read_as()
        self.assertEqual(reads, [("Bearer " + TOKENS["DEMO"], V), ("Bearer " + TOKENS["ADMIN"], OTHER), ("Bearer " + TOKENS["ADMIN"], VALIDATOR), ("Bearer " + TOKENS["OPERATOR"], GW)])

    def test_the_token_file_option_reads_the_other_parties_with_that_token(self):
        self.run_cc("balances", OTHER, "--token-file", self.files["SENDER"])
        self.assertEqual(self.read_as()[0], ("Bearer " + TOKENS["SENDER"], OTHER))

    def test_a_name_that_is_not_a_party_is_refused_before_anything_is_read(self):
        for bad in ("gateway", "w", "u::", "x::1220", ""):
            with self.assertRaises(SystemExit, msg=bad):
                self.run_cc("balances", bad)
        self.assertEqual(FakeLedger.requests, [])

    def test_an_amount_that_is_not_a_canton_decimal_stops_the_command(self):
        for bad in ("1.00000000001", "-1.0", "abc", "", 5, None):
            FakeLedger.holdings[V] = [held("00v1", bad)]
            with self.assertRaises(canton.Fail, msg=bad):
                self.run_cc("balances")

    def test_a_holding_without_the_view_of_the_standard_is_not_counted_and_a_broken_view_stops_the_command(self):
        real = holding_event
        with mock.patch.object(sys.modules[__name__], "holding_event", lambda owner, h: {**real(owner, h), "interfaceViews": []}):
            self.assertEqual(self.run_cc("balances")["parties"]["u"]["unlocked"], "0.0")
        with mock.patch.object(sys.modules[__name__], "holding_event", lambda owner, h: {**real(owner, h), "interfaceViews": [{"interfaceId": "x:Other:Iface", "viewValue": {}}]}):
            self.assertEqual(self.run_cc("balances")["parties"]["u"]["unlocked"], "0.0")
        with mock.patch.object(sys.modules[__name__], "holding_event", lambda owner, h: {**real(owner, h), "interfaceViews": [{"interfaceId": PKG + cc.HOLDING_VIEW, "viewValue": "x"}]}):
            with self.assertRaisesRegex(canton.Fail, "Holding view"):
                self.run_cc("balances")

    def test_no_token_is_printed(self):
        result, out, err = self.run_printed("balances", OTHER)
        self.assertNoSecrets(out, err, json.dumps(result))

    def test_the_main_program_prints_one_json_line(self):
        import subprocess
        FakeLedger.events[canton.CHAIN + "GatewayToken"] = []   # no wrapped token: nothing is asked of Ostia, which the other process has no fake of
        done = subprocess.run([sys.executable, str(ROOT / "demo" / "cc.py"), "balances"], capture_output=True, text=True, env=os.environ, timeout=60)
        self.assertEqual((done.returncode, done.stderr.count("\n")), (0, 0), done.stderr)
        self.assertEqual(json.loads(done.stdout)["parties"]["u"]["unlocked"], "7.5")
        self.assertEqual(done.stdout.count("\n"), 1)


class FundCase(CcCase):
    """The validator's party holds Canton Coin; the transfer's result is `mode`: completed, pending (an offer to accept) or failed."""
    INSTRUCTION = "00" + "1c" * 34

    def setUp(self):
        super().setUp()
        FakeLedger.holdings = {VALIDATOR: [held("00x1", "40.0"), held("00x2", "100.5"), held("00x3", "9.0", locked=True), held("00x4", "500.0", instrument={"admin": DSO, "id": "TKB"})],
                               U: [held("00u1", "1.0")], V: [], OTHER: []}
        self.mode, self.kind, self.counter = "completed", None, 0
        patcher = mock.patch.object(FakeLedger, "transaction", staticmethod(self.transaction))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.accept_answer = {"choiceContextData": {"values": {"round": {"tag": "AV_ContractId", "value": "r1"}}}, "disclosedContracts": [dict(DISCLOSED[0]), dict(DISCLOSED[1])]}
        FakeScan.answers[FACTORY_PATH] = lambda body: factory_answer(self.kind or ("self" if body["choiceArguments"]["transfer"]["sender"] == body["choiceArguments"]["transfer"]["receiver"]
                                                                                    else ("offer" if self.mode == "pending" else "direct")))
        FakeScan.answers[ACCEPT % self.INSTRUCTION] = lambda body: self.accept_answer

    def transaction(self, body):
        command = body["commands"]["commands"][0]["ExerciseCommand"]
        self.counter += 1
        if command["choice"] == "TransferFactory_Transfer":
            transfer = command["choiceArgument"]["transfer"]
            gone = set(transfer["inputHoldingCids"])
            FakeLedger.holdings[VALIDATOR] = [h for h in FakeLedger.holdings[VALIDATOR] if h["cid"] not in gone]
            self.offer = transfer
            if self.mode == "completed":
                FakeLedger.holdings.setdefault(transfer["receiver"], []).append(held("00new", transfer["amount"]))
                output = {"tag": twin.TRANSFER_COMPLETED, "value": {"receiverHoldingCids": ["00new"]}}
            elif self.mode == "pending":
                output = {"tag": cc.TRANSFER_PENDING, "value": {"transferInstructionCid": self.INSTRUCTION}}
            else:
                output = {"tag": "TransferInstructionResult_Failed", "value": {}}
            return {"transaction": {"updateId": "update-transfer", "events": [{"ExercisedEvent": {"contractId": command["contractId"], "choice": command["choice"], "exerciseResult": {"output": output}}}]}}
        assert command["choice"] == "TransferInstruction_Accept"
        FakeLedger.holdings.setdefault(self.offer["receiver"], []).append(held("00acc", self.offer["amount"]))
        return {"transaction": {"updateId": "update-accept", "events": [{"ExercisedEvent": {"contractId": command["contractId"], "choice": command["choice"],
                                                                                         "exerciseResult": {"output": {"tag": twin.TRANSFER_COMPLETED, "value": {}}}}}]}}

    def fund(self, who="u", amount="2.5", *more):
        return self.run_cc("fund", who, amount, "--sender-token-file", self.files["SENDER"], *more)

    def commands(self):
        return [(c["commands"]["commands"][0]["ExerciseCommand"], c) for c in FakeLedger.commands]


class FundTests(FundCase):
    def test_a_completed_transfer_is_asked_of_the_scan_proxy_and_exercised_as_the_validators_party_with_its_token(self):
        got = self.fund()
        [asked] = [b for m, p, _, b in FakeScan.seen if p == FACTORY_PATH]
        transfer = asked["choiceArguments"]["transfer"]
        self.assertEqual((asked["choiceArguments"]["expectedAdmin"], transfer["sender"], transfer["receiver"], transfer["amount"], transfer["instrumentId"], transfer["meta"]),
                         (DSO, VALIDATOR, U, "2.5", {"admin": DSO, "id": "Amulet"}, {"values": {}}))
        self.assertEqual(transfer["inputHoldingCids"], ["00x2", "00x1"])   # the unlocked Canton Coin only, the largest first
        [(command, request)] = self.commands()
        self.assertEqual((command["templateId"], command["contractId"], command["choice"]), (canton.TRANSFER_FACTORY, FACTORY, "TransferFactory_Transfer"))
        self.assertEqual(command["choiceArgument"]["transfer"]["inputHoldingCids"], ["00x2", "00x1"])
        self.assertEqual(command["choiceArgument"]["extraArgs"], {"context": factory_answer()["choiceContext"]["choiceContextData"], "meta": {"values": {}}})
        self.assertEqual(command["choiceArgument"]["expectedAdmin"], DSO)
        self.assertEqual(request["commands"]["actAs"], [VALIDATOR])
        self.assertNotIn("userId", request["commands"])   # the ledger takes the user from the token
        self.assertEqual(request["commands"]["disclosedContracts"], DISCLOSED)   # all four, with the four fields only
        self.assertEqual([a for p, a, b in FakeLedger.requests if p == "/v2/commands/submit-and-wait-for-transaction"], ["Bearer " + TOKENS["SENDER"]])
        self.assertEqual(got, {"transferUpdateId": "update-transfer", "acceptUpdateId": None, "from": VALIDATOR, "to": U, "amount": "2.5", "kind": "direct", "result": twin.TRANSFER_COMPLETED,
                               "instruction": None, "balance": {"unlocked": "3.5", "locked": "0.0"}})

    def test_a_pending_transfer_is_accepted_by_the_receiver_as_the_demo_user_with_the_scan_proxys_accept_context(self):
        self.mode = "pending"
        got = self.fund("v", "7")
        [(_, first), (command, second)] = self.commands()
        self.assertEqual(first["commands"]["actAs"], [VALIDATOR])
        self.assertEqual((command["templateId"], command["contractId"], command["choice"]), (canton.TRANSFER_INSTRUCTION, self.INSTRUCTION, "TransferInstruction_Accept"))
        self.assertEqual(command["choiceArgument"], {"extraArgs": {"context": self.accept_answer["choiceContextData"], "meta": {"values": {}}}})
        self.assertEqual((second["commands"]["actAs"], second["commands"]["userId"]), ([V], "demo"))
        self.assertEqual(second["commands"]["disclosedContracts"], DISCLOSED[:2])
        [asked] = [(m, b) for m, p, _, b in FakeScan.seen if p == ACCEPT % self.INSTRUCTION]
        self.assertEqual(asked[0], "POST")
        tokens = [a for p, a, b in FakeLedger.requests if p == "/v2/commands/submit-and-wait-for-transaction"]
        self.assertEqual(tokens, ["Bearer " + TOKENS["SENDER"], "Bearer " + TOKENS["DEMO"]])
        self.assertEqual((got["kind"], got["result"], got["transferUpdateId"], got["acceptUpdateId"], got["instruction"]), ("offer", cc.TRANSFER_PENDING, "update-transfer", "update-accept", self.INSTRUCTION))
        self.assertEqual(got["balance"], {"unlocked": "7.0", "locked": "0.0"})

    def test_it_waits_for_the_receiver_to_hold_the_coin(self):
        real = FakeLedger.transaction
        def late(body):
            out = real(body)
            self.late = FakeLedger.holdings[U].pop()   # the receiver's participant shows it a moment later
            return out
        looks = []
        def sleep(seconds):
            looks.append(seconds)
            if len(looks) == 2:
                FakeLedger.holdings[U].append(self.late)
        with mock.patch.object(FakeLedger, "transaction", staticmethod(late)), mock.patch.object(canton.time, "sleep", sleep):
            self.assertEqual(self.fund()["balance"]["unlocked"], "3.5")
        self.assertEqual(len(looks), 2)

    def test_a_party_id_receives_directly_and_is_read_with_the_senders_token(self):
        got = self.fund(OTHER, "0.0000000001")
        self.assertEqual((got["to"], got["balance"]["unlocked"]), (OTHER, "0.0000000001"))
        self.assertIn(("Bearer " + TOKENS["SENDER"]), [a for p, a, b in FakeLedger.requests if b and OTHER in json.dumps(b)])

    def test_an_offer_to_a_party_that_is_not_u_or_v_is_refused_before_anything_is_sent(self):
        self.mode = "pending"
        with self.assertRaisesRegex(canton.Fail, "only u and v accept"):
            self.fund(OTHER)
        self.assertEqual(FakeLedger.commands, [])
        self.mode = "completed"
        self.kind = "direct"   # the scan proxy says direct, the ledger says pending: the offer is there and only the receiver can accept it
        self.mode = "pending"
        with self.assertRaisesRegex(canton.Fail, self.INSTRUCTION):
            self.fund(OTHER)
        self.assertEqual(len(FakeLedger.commands), 1)

    def test_a_result_that_is_not_completed_or_pending_stops_the_command(self):
        self.mode = "failed"
        with self.assertRaisesRegex(canton.Fail, "did not complete: its result is TransferInstructionResult_Failed"):
            self.fund()
        self.assertEqual(len(FakeLedger.commands), 1)

    def test_a_missing_exercise_result_stops_the_command(self):
        with mock.patch.object(FakeLedger, "transaction", staticmethod(lambda body: {"transaction": {"updateId": "u-1", "events": []}})):
            with self.assertRaisesRegex(canton.Fail, "its result is not there"):
                self.fund()

    def test_the_validator_must_hold_enough_unlocked_canton_coin_of_the_instrument(self):
        for amount in ("140.51", "1000"):   # 40.0 + 100.5 unlocked; the locked 9.0 and the TKB do not count
            with self.assertRaisesRegex(canton.Fail, "holds 140.5 Canton Coin, less than"):
                self.fund("u", amount)
        self.assertEqual((FakeLedger.commands, [p for _, p, _, _ in FakeScan.seen if p == FACTORY_PATH]), ([], []))
        self.assertEqual(self.fund("u", "140.5")["balance"]["unlocked"], "141.5")

    def test_the_inputs_are_at_most_fifty_of_the_largest(self):
        FakeLedger.holdings[VALIDATOR] = [held(f"00y{i:02d}", f"{i + 1}.0") for i in range(60)]
        self.fund("u", "1")
        [asked] = [b for m, p, _, b in FakeScan.seen if p == FACTORY_PATH]
        inputs = asked["choiceArguments"]["transfer"]["inputHoldingCids"]
        self.assertEqual((len(inputs), inputs[0], inputs[-1]), (50, "00y59", "00y10"))

    def test_an_amount_that_is_not_more_than_zero_with_at_most_ten_decimals_is_refused_before_anything_is_asked(self):
        for bad in ("0", "0.0", "1.00000000001", "-1", "abc", "1e3", "", " 1", "1.", ".5"):
            with self.assertRaises(SystemExit, msg=bad):
                self.fund("u", bad)
        for bad in ("w", "gateway", "x::"):
            with self.assertRaises(SystemExit, msg=bad):
                self.fund(bad)
        self.assertEqual((FakeScan.seen, FakeLedger.requests, FakeLedger.commands), ([], [], []))
        with self.assertRaisesRegex(SystemExit, "is the sender"):
            self.fund(VALIDATOR)
        self.assertEqual(FakeLedger.commands, [])

    def test_a_malformed_factory_answer_stops_before_the_command_is_sent(self):
        for change in (lambda a: a.update(factoryId="00" + "77" * 34), lambda a: a.update(transferKind="self"), lambda a: a["choiceContext"]["disclosedContracts"][3].pop("createdEventBlob")):
            def answer(body, change=change):
                a = factory_answer("direct")
                change(a)
                return a
            FakeScan.answers[FACTORY_PATH] = answer
            with self.assertRaises(canton.Fail):
                self.fund()
        self.assertEqual(FakeLedger.commands, [])

    def test_a_malformed_accept_context_or_instruction_stops_the_receivers_command(self):
        self.mode = "pending"
        for bad in ({"choiceContextData": {"values": {}}, "disclosedContracts": []}, {"choiceContextData": {"values": {}}, "disclosedContracts": [{"contractId": "x"}]}, {}):
            self.accept_answer = bad
            FakeLedger.holdings[VALIDATOR] = [held("00x1", "40.0")]
            with self.assertRaises(canton.Fail):
                self.fund("u")
            self.assertEqual(len(FakeLedger.commands), 1)   # the transfer is made; only its acceptance is refused
            FakeLedger.commands.clear()
        with self.assertRaisesRegex(canton.Fail, "not a contract id"):
            cc.Scan(self.scan_url, self.files["SCAN"]).accept_context("../x")

    def test_the_senders_token_file_is_needed_and_checked_before_any_request(self):
        with self.assertRaises(SystemExit) as why:
            self.run_cc("fund", "u", "1")
        self.assertIn("cc.py fund", str(why.exception))
        os.chmod(self.files["SENDER"], 0o644)
        with self.assertRaises(SystemExit) as why:
            self.fund()
        self.assertIn("chmod 600", str(why.exception))
        self.assertNoSecrets(str(why.exception))
        self.assertEqual((FakeScan.seen, FakeLedger.requests), ([], []))

    def test_no_token_is_printed_and_a_server_that_echoes_one_is_scrubbed(self):
        result, out, err = self.run_printed("fund", "u", "1", "--sender-token-file", self.files["SENDER"])
        self.assertNoSecrets(out, err, json.dumps(result))
        FakeLedger.holdings[VALIDATOR] = [held("00x1", "40.0")]
        real = canton.Network.post

        def refuse(net, node, path, body, role, content_type="application/json"):
            if path == "/v2/commands/submit-and-wait-for-transaction":
                raise canton.Refused(f"{path}: 401 Bearer {net.token(role)}")
            return real(net, node, path, body, role, content_type)
        with mock.patch.object(canton.Network, "post", refuse), self.assertRaises(canton.Fail) as why:
            self.fund("u", "1")
        self.assertIn("Bearer <token>", str(why.exception))
        self.assertNoSecrets(str(why.exception))


ALLOCATION_FACTORY = "00" + "af" * 34
ALLOCATION_FACTORY_PATH = BASE + "/scan-proxy/registry/allocation-instruction/v1/allocation-factory"
ALLOCATION = "00" + "a1" * 34
LABEL = "cc-demo-1"
LABEL_ID = "b2382284fe21d9061096a175dfe757ab2f81b2a6fc940c6a4ad121190906ea4a"   # sha256 of "deposit,<U>,cc-demo-1", computed outside this code
RECIPIENT = "0x" + "9c" * 20
CHAIN = {"chainId": 770101, "operator": OP, "confirmer": CO, "gateway": GW, "builder": PARTIES["BUILDER"]}


class Clock:
    """Time that only the sleeps move: each sleep is `step` seconds, so a wait that never ends is over in a few looks."""
    def __init__(self, step):
        self.now, self.step, self.sleeps = 0, step, 0

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.now += self.step
        self.sleeps += 1


def allocation_answer():
    answer = factory_answer("direct")
    answer["factoryId"] = ALLOCATION_FACTORY
    answer["choiceContext"]["disclosedContracts"] = [dict(DISCLOSED[0]), dict(DISCLOSED[1]), {**contract("allocfactory", PKG + ":Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules"), "contractId": ALLOCATION_FACTORY}]
    del answer["transferKind"]
    return answer


class DepositCase(CcCase):
    """U holds Canton Coin, the chain and the Canton Coin token are on the operator's participant, and the scan proxy has an allocation factory."""
    def setUp(self):
        super().setUp()
        FakeLedger.holdings = {U: [held("00u1", "5.0"), held("00u2", "2.5"), held("00u3", "9.0", locked=True), held("00u4", "100.0", instrument={"admin": DSO, "id": "TKB"})]}
        FakeLedger.events[canton.CHAIN + "ZkChain"] = [{"contractId": "chain-1", "createArgument": dict(CHAIN)}]
        FakeLedger.events[canton.CHAIN + "GatewayToken"] = [{"contractId": "gt-1", "createArgument": {"evmToken": WRAPPED, "instrumentId": {"admin": DSO, "id": "Amulet"}, "factory": FACTORY}}]
        FakeLedger.events[canton.DEPOSIT_REQUEST] = []
        self.mode, self.exercised = "completed", []
        FakeScan.answers[ALLOCATION_FACTORY_PATH] = lambda body: self.answer
        self.answer = allocation_answer()
        for patcher in (mock.patch.object(FakeLedger, "transaction", staticmethod(self.transaction)),):
            patcher.start()
            self.addCleanup(patcher.stop)
        FakeLedger.on_submit = self.submitted

    def transaction(self, body):
        command = body["commands"]["commands"][0]["ExerciseCommand"]
        assert command["choice"] == "AllocationFactory_Allocate"
        self.exercised.append(body)
        output = {"tag": canton_allocation_completed(), "value": {"allocationCid": ALLOCATION, "senderChangeCids": [], "meta": {"values": {}}}} if self.mode == "completed" \
            else {"tag": "AllocationInstructionResult_Pending", "value": {"allocationInstructionCid": "00" + "b9" * 34}}
        return {"transaction": {"updateId": "update-alloc", "events": [{"ExercisedEvent": {"contractId": command["contractId"], "choice": command["choice"], "exerciseResult": {"output": output}}}]}}

    def submitted(self, body):
        [command] = body["commands"]
        create = command["CreateCommand"]
        assert create["templateId"] == canton.DEPOSIT_REQUEST
        FakeLedger.events[canton.DEPOSIT_REQUEST].append({"contractId": "request-1", "createArgument": create["createArguments"]})

    def deposit(self, label=LABEL, address=RECIPIENT, amount="2.5"):
        return self.run_cc("deposit", label, address, amount)

    def created(self):
        """The commands that made a contract (submit-and-wait; the allocation goes by submit-and-wait-for-transaction, whose commands are wrapped in an object)."""
        return [c for c in FakeLedger.commands if isinstance(c["commands"], list)]

    def allocation_requests(self):
        return [r for r in FakeScan.seen if r[1] == ALLOCATION_FACTORY_PATH]


def canton_allocation_completed():
    return cc.ALLOCATION_COMPLETED


class DepositTests(DepositCase):
    def test_u_allocates_to_the_gateway_through_the_scan_proxys_allocation_factory_with_the_operator_as_executor(self):
        self.deposit()
        [(method, path, headers, body)] = self.allocation_requests()
        self.assertEqual(method, "POST")
        self.assertEqual(headers["User-Agent"], "Rome Protocol rome@romeprotocol.com")
        self.assertEqual(headers["Authorization"], "Bearer " + TOKENS["SCAN"])
        arguments = body["choiceArguments"]
        self.assertEqual(body["excludeDebugFields"], True)
        self.assertEqual(arguments["expectedAdmin"], DSO)
        self.assertEqual(arguments["extraArgs"], {"context": {"values": {}}, "meta": {"values": {}}})
        self.assertEqual(arguments["inputHoldingCids"], ["00u1", "00u2"])   # unlocked Canton Coin of U only, the largest first
        spec = arguments["allocation"]
        self.assertEqual(spec["settlement"]["executor"], OP)
        self.assertEqual(spec["settlement"]["settlementRef"], {"id": LABEL, "cid": None})
        self.assertEqual(spec["settlement"]["meta"], {"values": {}})
        self.assertEqual(spec["transferLegId"], "leg-" + LABEL)
        self.assertEqual(spec["transferLeg"], {"sender": U, "receiver": GW, "amount": "2.5", "instrumentId": {"admin": DSO, "id": "Amulet"}, "meta": {"values": {}}})
        self.assertEqual(arguments["requestedAt"], spec["settlement"]["requestedAt"])
        self.assertLess(spec["settlement"]["requestedAt"], spec["settlement"]["allocateBefore"])
        self.assertLess(spec["settlement"]["allocateBefore"], spec["settlement"]["settleBefore"])

    def test_the_allocation_is_exercised_as_u_with_the_factorys_context_and_only_the_four_fields_of_each_disclosed_contract(self):
        self.deposit(amount="3")
        [body] = self.exercised
        [command] = body["commands"]["commands"]
        exercise = command["ExerciseCommand"]
        self.assertEqual((exercise["templateId"], exercise["contractId"], exercise["choice"]), (canton.ALLOCATION_FACTORY, ALLOCATION_FACTORY, "AllocationFactory_Allocate"))
        argument = exercise["choiceArgument"]
        self.assertEqual(argument["extraArgs"]["context"], self.answer["choiceContext"]["choiceContextData"])
        self.assertEqual(argument["expectedAdmin"], DSO)
        self.assertEqual(argument["allocation"]["transferLeg"]["amount"], "3.0")   # a whole amount is written as a Decimal
        self.assertEqual(body["commands"]["actAs"], [U])
        self.assertEqual(sorted(d["contractId"] for d in body["commands"]["disclosedContracts"]), sorted([DISCLOSED[0]["contractId"], DISCLOSED[1]["contractId"], ALLOCATION_FACTORY]))
        self.assertTrue(all(set(d) == set(twin.DISCLOSED_KEYS) for d in body["commands"]["disclosedContracts"]))
        auth = [a for path, a, b in FakeLedger.requests if path == "/v2/commands/submit-and-wait-for-transaction"]
        self.assertEqual(auth, ["Bearer " + TOKENS["DEMO"]])

    def test_the_request_is_signed_with_the_label_and_the_id_derived_from_u_and_the_label(self):
        result = self.deposit()
        self.assertEqual(result["depositId"], LABEL_ID)
        self.assertEqual(canton.deposit_id_of(U, LABEL), LABEL_ID)
        [made] = self.created()
        self.assertEqual(made["commands"][0]["CreateCommand"]["createArguments"], {**CHAIN, "depositor": U, "depositId": LABEL_ID, "recipient": "9c" * 20, "allocation": ALLOCATION, "label": LABEL})
        self.assertEqual(made["actAs"], [U])
        self.assertEqual(made["userId"], "demo")
        self.assertEqual(result, {"label": LABEL, "depositId": LABEL_ID, "recipient": RECIPIENT, "amount": "2.5", "evmToken": "0x" + WRAPPED, "allocationUpdateId": "update-alloc",
                                  "allocation": ALLOCATION, "request": "request-1", "claim": f"evm.py claim <u or v> {LABEL_ID} 0x{WRAPPED} 2.5"})

    def test_another_label_makes_another_id_and_a_label_that_is_open_is_refused(self):
        self.assertNotEqual(self.deposit("cc-demo-2")["depositId"], LABEL_ID)
        self.deposit()
        with self.assertRaises(SystemExit) as why:
            self.deposit()
        self.assertIn("already has an open deposit request", str(why.exception))

    def test_nothing_is_sent_before_the_amount_the_address_the_label_the_token_and_the_holdings_are_right(self):
        for args, text in ((("", RECIPIENT, "1"), "label"), ((LABEL, "0x12", "1"), "not an EVM address"), ((LABEL, RECIPIENT, "0"), "more than zero"), ((LABEL, RECIPIENT, "1.00000000001"), "10 decimals"),
                           ((LABEL, RECIPIENT, "-1"), "10 decimals"), ((LABEL, RECIPIENT, "7.6"), "less than 7.6")):
            with self.subTest(args), self.assertRaises((SystemExit, canton.Fail)) as why:
                self.deposit(*args)
            self.assertIn(text, str(why.exception))
        FakeLedger.events[canton.CHAIN + "GatewayToken"] = []
        with self.assertRaises(canton.Fail) as why:
            self.deposit()
        self.assertIn("cc.py register", str(why.exception))
        self.assertEqual((self.allocation_requests(), FakeLedger.commands, self.exercised), ([], [], []))

    def test_a_result_that_is_not_a_completed_allocation_stops_before_the_request(self):
        self.mode = "pending"
        with self.assertRaises(canton.Fail) as why:
            self.deposit()
        self.assertIn("AllocationInstructionResult_Pending", str(why.exception))
        self.assertEqual(self.created(), [])

    def test_the_factory_must_be_a_disclosed_contract_of_the_splice_amulet_packages(self):
        def refused(why, change):
            self.answer = allocation_answer()
            change(self.answer)
            with self.assertRaises(canton.Fail) as got:
                self.deposit()
            self.assertIn(why, str(got.exception))
        refused("factoryId", lambda a: a.update(factoryId="x"))
        refused("did not disclose", lambda a: a.update(factoryId="00" + "ee" * 34))
        refused("not an ExternalPartyAmuletRules", lambda a: a["choiceContext"]["disclosedContracts"][2].update(templateId=PKG + ":Evil.Rules:Rules"))
        refused("not an ExternalPartyAmuletRules", lambda a: a["choiceContext"]["disclosedContracts"][2].update(templateId=PKG + ":Splice.AmuletRules:AmuletRules"))
        refused("choice context", lambda a: a.update(choiceContext={}))
        self.assertEqual((self.exercised, FakeLedger.commands), ([], []))

    def test_the_request_is_waited_for_at_most_a_minute(self):
        FakeLedger.on_submit = None   # the ledger never shows the request
        clock = Clock(25)
        with mock.patch.object(canton.time, "time", clock.time), mock.patch.object(canton.time, "sleep", clock.sleep), self.assertRaises(canton.Fail) as why:
            self.deposit()
        self.assertIn("timed out waiting for the deposit request", str(why.exception))
        self.assertTrue(60 <= clock.now <= 120, clock.now)

    def test_a_bad_command_line_prints_the_usage_and_no_token_is_printed(self):
        for argv in (("deposit",), ("deposit", LABEL, RECIPIENT), ("deposit", LABEL, RECIPIENT, "1", "2"), ("withdraw",), ("withdraw", "1", "2")):
            with self.subTest(argv), self.assertRaises(SystemExit) as why:
                self.run_cc(*argv)
            self.assertIn("cc.py deposit <label> <evm address> <amount>", str(why.exception))
            self.assertIn("evm.py claim", str(why.exception))
        result, out, err = self.run_printed("deposit", LABEL, RECIPIENT, "1")
        self.assertNoSecrets(out, err, json.dumps(result))


class WithdrawCase(CcCase):
    ADDRESS = None

    def setUp(self):
        super().setUp()
        FakeLedger.holdings = {U: [held("00u1", "5.0")]}
        FakeLedger.events[canton.CHAIN + "GatewayToken"] = [{"contractId": "gt-1", "createArgument": {"evmToken": WRAPPED, "instrumentId": {"admin": DSO, "id": "Amulet"}, "factory": FACTORY}}]
        FakeLedger.events[canton.ACCEPTANCE] = [{"contractId": "acc-1", "createArgument": {"party": U}}, {"contractId": "acc-2", "createArgument": {"party": V}}]
        self.address = evm.make_keys(self.state)["u"]
        self.ostia.balances[self.address.lower()] = 40 * 10**10
        self.arrives = lambda data: FakeLedger.holdings[U].append(held("00new", "1.5"))
        self.ostia.on_send = self.burn

    def burn(self, data):
        self.ostia.balances[self.address.lower()] -= 15 * 10**9
        self.arrives(data)

    def withdraw(self, amount="1.5"):
        return self.run_cc("withdraw", amount)


class WithdrawTests(WithdrawCase):
    def test_u_burns_the_wrapped_coin_through_the_gateway_for_its_party_and_both_sides_are_printed(self):
        result = self.withdraw()
        [sent] = self.ostia.sent
        self.assertEqual((sent["who"], sent["to"].lower(), sent["data"]), ("u", GATEWAY.lower(), evm.call_data("withdraw(address,uint256,string)", ["0x" + WRAPPED, 15 * 10**9, U])))
        self.assertEqual(result, {"amount": "1.5", "ostia": {"tx": "0x" + "cd" * 32, "block": 9, "address": self.address, "wrapped": {"before": "40.0", "after": "38.5"}},
                                  "canton": {"party": U, "before": {"unlocked": "5.0", "locked": "0.0"}, "after": {"unlocked": "6.5", "locked": "0.0"}}})

    def test_without_a_withdrawal_acceptance_nothing_is_sent(self):
        FakeLedger.events[canton.ACCEPTANCE] = [{"contractId": "acc-2", "createArgument": {"party": V}}]   # only V accepted
        with self.assertRaises(canton.Fail) as why:
            self.withdraw()
        self.assertIn("no WithdrawalAcceptance", str(why.exception))
        self.assertIn("canton.py accept u", str(why.exception))
        self.assertEqual(self.ostia.sent, [])

    def test_without_the_wrapped_coin_or_the_token_or_a_good_amount_nothing_is_sent(self):
        self.ostia.balances[self.address.lower()] = 10**10
        with self.assertRaises(canton.Fail) as why:
            self.withdraw()
        self.assertIn("less than 1.5", str(why.exception))
        for amount, text in (("0", "more than zero"), ("1.00000000001", "10 decimals"), ("-1", "10 decimals"), ("x", "10 decimals")):
            with self.subTest(amount), self.assertRaises(SystemExit) as why:
                self.withdraw(amount)
            self.assertIn(text, str(why.exception))
        FakeLedger.events[canton.CHAIN + "GatewayToken"] = []
        with self.assertRaises(canton.Fail) as why:
            self.withdraw("1")
        self.assertIn("cc.py register", str(why.exception))
        self.assertEqual(self.ostia.sent, [])

    def test_a_withdrawal_that_fails_on_ostia_is_not_waited_for(self):
        self.ostia.status = 0
        clock = Clock(1000)
        with mock.patch.object(canton.time, "time", clock.time), mock.patch.object(canton.time, "sleep", clock.sleep), self.assertRaises(canton.Fail) as why:
            self.withdraw()
        self.assertIn("failed on Ostia", str(why.exception))
        self.assertEqual(clock.sleeps, 0)

    def test_it_waits_for_the_coin_to_reach_u(self):
        self.arrives = lambda data: None
        looks = []

        def sleep(seconds):
            looks.append(seconds)
            if len(looks) == 3:
                FakeLedger.holdings[U].append(held("00new", "1.5"))
        with mock.patch.object(canton.time, "sleep", sleep):
            self.assertEqual(self.withdraw()["canton"]["after"]["unlocked"], "6.5")
        self.assertEqual(len(looks), 3)

    def test_less_than_the_amount_is_not_enough_and_the_wait_ends_after_ten_minutes(self):
        self.arrives = lambda data: FakeLedger.holdings[U].append(held("00part", "1.4999999999"))
        clock = Clock(100)
        with mock.patch.object(canton.time, "time", clock.time), mock.patch.object(canton.time, "sleep", clock.sleep), self.assertRaises(canton.Fail) as why:
            self.withdraw()
        self.assertIn("timed out waiting for U to hold the Canton Coin", str(why.exception))
        self.assertTrue(600 <= clock.now <= 700, clock.now)

    def test_no_token_is_printed(self):
        result, out, err = self.run_printed("withdraw", "1.5")
        self.assertNoSecrets(out, err, json.dumps(result))


if __name__ == "__main__":
    unittest.main()
