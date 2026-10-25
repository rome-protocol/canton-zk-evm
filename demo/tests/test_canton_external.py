"""Tests for demo/canton.py on an existing participant (CZE_CANTON=external): one Ledger API for every role, the user prefix, the token files, and
the upload of the test token alone. A fake participant answers (one server, which keeps what it was asked and with which token).
Run: python3 -m unittest discover -s demo/tests"""
import hashlib, io, json, os, subprocess, sys, tempfile, unittest, threading, http.server
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import canton
from test_canton import PARTIES, CHAIN_RECORD, FakeLedger, record

ROOT = canton.ROOT
MARK = "fake-bearer-"   # every token file holds MARK + the role: the tests look for this text in what is printed
TEST_TOKEN_PACKAGE = "da294b5651ed00af8565fd31351d0c1d8778f10393d250e32c9844311f681436"   # the main package of splice-test-token-v1-1.0.1.dar
EVM_TOKEN = "0x" + "AB" * 20


class FakeParticipant(FakeLedger):
    """The fake Ledger API of test_canton, with the calls of an existing participant: the participant id, its connected synchronizers, the
    package upload and the vetting list. Every call is kept with its path and its Authorization header."""
    calls: list = []         # (method, path, authorization header or None)
    uploads: list = []       # (path, SHA-256 of the body)
    vetted = False           # does this participant vet the package asked for?
    vetted_by = "part::1"    # the participant that vets it (another one's vetting does not count)
    vetting_status = 200

    def do_GET(self):
        FakeParticipant.calls.append(("GET", self.path, self.headers.get("authorization")))
        if self.path == "/v2/parties/participant-id":
            return self.reply({"participantId": "part::1"})
        if self.path == "/v2/state/connected-synchronizers":
            return self.reply({"connectedSynchronizers": [{"synchronizerId": "sync::1"}]})
        super().do_GET()

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["content-length"]))
        FakeParticipant.calls.append(("POST", self.path, self.headers.get("authorization")))
        if self.path.startswith("/v2/packages"):
            FakeParticipant.uploads.append((self.path, hashlib.sha256(raw).hexdigest()))
            FakeParticipant.vetted = True
            return self.reply({})
        if self.path == "/v2/package-vetting/list":
            if FakeParticipant.vetting_status != 200:
                return self.reply("", FakeParticipant.vetting_status)
            asked = json.loads(raw)["packageMetadataFilter"]["packageIds"]
            vetted = [{"synchronizerId": "sync::1", "participantId": FakeParticipant.vetted_by, "packages": [{"packageId": p} for p in asked]}] if FakeParticipant.vetted else []
            return self.reply({"vettedPackages": vetted})
        self.rfile = io.BytesIO(raw)
        super().do_POST()


class ExternalTestCase(unittest.TestCase):
    ROLES = ("admin", "demo", "operator", "confirmer", "reader", "builder")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "state"
        (self.state / "canton").mkdir(parents=True)
        (self.state / "demo").mkdir()
        (self.state / "canton" / "parties.env").write_text("".join(f"{k}_PARTY={v}\n" for k, v in PARTIES.items()))
        (self.state / "demo" / "disclosed.json").write_text(json.dumps([{"templateId": canton.RULES, "contractId": "rules-1", "createdEventBlob": "blob-1", "synchronizerId": "sync::1"}]))
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), type("participant", (FakeParticipant,), {"node": "participant"}))
        threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.tokens = Path(self.tmp.name) / "tokens"
        self.tokens.mkdir(mode=0o700)
        env = {k: v for k, v in os.environ.items() if not k.startswith("CZE_")}
        env.update({"CZE_STATE_DIR": str(self.state), "CZE_CANTON": "external", "CZE_LEDGER_URL": self.url, "CZE_USER_PREFIX": "ostia2-",
                    "CZE_CONFIRMER_LEDGER_URL": "http://127.0.0.1:1", "CZE_USERS_LEDGER_URL": "http://127.0.0.1:1"})   # not used on one participant
        for role in self.ROLES:
            env[f"CZE_TOKEN_FILE_{role.upper()}"] = str(self.token_file(role))
        patch = mock.patch.dict(os.environ, env, clear=True)
        patch.start()
        self.addCleanup(patch.stop)
        FakeLedger.contracts = {("op::1", canton.CHAIN + "ZkChain"): [{"contractId": "chain-1", "offset": 5, "createArgument": CHAIN_RECORD}]}
        FakeLedger.created, FakeLedger.submitted, FakeLedger.asked, FakeLedger.updates, FakeLedger.refuse = [], [], [], {}, None
        FakeLedger.update_reads = []
        FakeParticipant.calls, FakeParticipant.uploads, FakeParticipant.vetted, FakeParticipant.vetted_by, FakeParticipant.vetting_status = [], [], False, "part::1", 200

    def token_file(self, role, text=None, mode=0o600):
        path = self.tokens / role
        path.write_text((text or MARK + role) + "\n")
        path.chmod(mode)
        return path

    def auth_of(self, path_start):
        return [a for _, p, a in FakeParticipant.calls if p.startswith(path_start)]


class SettingsTests(ExternalTestCase):
    def test_every_role_uses_the_one_ledger_url(self):
        net = canton.Network()
        self.assertEqual(set(net.urls.values()), {self.url})
        self.assertEqual(set(net.urls), {"operator", "confirmer", "users"})

    def test_a_trailing_slash_is_dropped(self):
        os.environ["CZE_LEDGER_URL"] = self.url + "/"
        self.assertEqual(canton.Network().urls["operator"], self.url)

    def test_the_url_is_needed(self):
        del os.environ["CZE_LEDGER_URL"]
        with self.assertRaises(SystemExit) as why:
            canton.Network()
        self.assertIn("CZE_LEDGER_URL", str(why.exception))

    def test_a_token_does_not_go_over_a_network_in_the_clear(self):
        for bad in ("http://ledger.example:7575", "http://10.1.2.3:7575", "ftp://127.0.0.1"):
            os.environ["CZE_LEDGER_URL"] = bad
            with self.assertRaises(SystemExit, msg=bad):
                canton.Network()
        for good in ("https://ledger.example", "http://127.0.0.1:7575", "http://localhost:7575"):
            os.environ["CZE_LEDGER_URL"] = good
            canton.Network()

    def test_the_mode_is_local_or_external(self):
        os.environ["CZE_CANTON"] = "remote"
        with self.assertRaises(SystemExit):
            canton.Network()
        os.environ["CZE_CANTON"] = "local"
        os.environ["CZE_LEDGER_URL"] = "http://ledger.example:7575"   # on the local network the URL setting is as it always was
        self.assertEqual(canton.Network().urls["operator"], "http://ledger.example:7575")

    def test_the_local_defaults_do_not_change(self):
        for k in [k for k in os.environ if k.startswith("CZE_") and k != "CZE_STATE_DIR"]:
            del os.environ[k]
        net = canton.Network()
        self.assertEqual(net.urls, {"operator": "http://127.0.0.1:7575", "confirmer": "http://127.0.0.1:7576", "users": "http://127.0.0.1:7577"})
        self.assertEqual((net.user("demo"), net.user("builder"), net.token("demo")), ("demo", "builder", None))

    def test_the_user_ids_have_the_prefix_only_on_an_existing_participant(self):
        net = canton.Network()
        self.assertEqual((net.user("demo"), net.user("builder")), ("ostia2-demo", "ostia2-builder"))
        os.environ["CZE_USER_PREFIX"] = ""
        self.assertEqual(canton.Network().user("demo"), "demo")


class TokenTests(ExternalTestCase):
    def test_a_command_is_sent_as_the_prefixed_user_with_that_users_token(self):
        canton.main(["accept", "u"])
        [(_, body)] = FakeLedger.submitted
        self.assertEqual(body["userId"], "ostia2-demo")
        sent = [a for m, p, a in FakeParticipant.calls if p == "/v2/commands/submit-and-wait"]
        self.assertEqual(sent, ["Bearer " + MARK + "demo"])

    def test_every_read_uses_the_token_of_the_party_that_reads(self):
        FakeLedger.contracts[("re::1", canton.CHAIN + "BlockRecord")] = [{"contractId": "rec8", "offset": 50, "createArgument": {"number": "8", "blockHash": "00", "proofHex": "ab"}}]
        canton.status(canton.Network())
        by_party = {party: set() for _, party, _ in FakeLedger.asked}
        reads = [(p, a) for _, p, a in FakeParticipant.calls if p in ("/v2/state/ledger-end", "/v2/state/active-contracts")]
        self.assertTrue(reads)
        self.assertEqual({a for _, a in reads}, {"Bearer " + MARK + r for r in ("demo", "operator", "reader")})   # U and V; the operator and the gateway; the reader
        self.assertEqual(set(by_party), {"op::1", "re::1", "u::1", "v::1", "gw::1"})

    def test_the_gateway_is_read_with_the_operators_token(self):
        canton.balances(canton.Network())
        asked = [(party, a) for (party, _), (_, p, a) in zip([(party, t) for _, party, t in FakeLedger.asked],
                                                              [c for c in FakeParticipant.calls if c[1] == "/v2/state/active-contracts"])]
        self.assertIn(("gw::1", "Bearer " + MARK + "operator"), asked)
        self.assertIn(("u::1", "Bearer " + MARK + "demo"), asked)

    def test_the_token_is_read_at_every_call(self):
        net = canton.Network()
        net.get("operator", "/v2/state/ledger-end", "demo")
        self.token_file("demo", "second-token")
        net.get("operator", "/v2/state/ledger-end", "demo")
        self.assertEqual(self.auth_of("/v2/state/ledger-end"), ["Bearer " + MARK + "demo", "Bearer second-token"])

    def test_the_resubmit_goes_out_as_the_builder(self):
        advance = {k: "00" for k in canton.ADVANCE_FIELDS}
        advance["legs"] = [{"x": 1}]
        path = Path(self.tmp.name) / "advance.json"
        path.write_text(json.dumps(advance))
        canton.main(["resubmit", str(path)])
        [(_, body)] = FakeLedger.submitted
        self.assertEqual(body["userId"], "ostia2-builder")
        self.assertEqual(self.auth_of("/v2/commands/submit-and-wait"), ["Bearer " + MARK + "builder"])

    def test_a_token_file_that_others_can_read_is_refused_before_anything_is_sent(self):
        self.token_file("demo", mode=0o644)
        with self.assertRaises(SystemExit) as why:
            canton.main(["setup"])
        self.assertIn("can be read by others", str(why.exception))
        self.assertNotIn(MARK, str(why.exception))
        self.assertEqual(FakeParticipant.calls, [])

    def test_a_missing_or_empty_or_two_word_token_file_is_refused(self):
        os.environ["CZE_TOKEN_FILE_DEMO"] = str(self.tokens / "nothing")
        with self.assertRaises(SystemExit):
            canton.main(["setup"])
        self.token_file("demo", " ")
        os.environ["CZE_TOKEN_FILE_DEMO"] = str(self.tokens / "demo")
        with self.assertRaises(SystemExit):
            canton.main(["setup"])
        self.token_file("demo", "two words")
        with self.assertRaises(SystemExit) as why:
            canton.main(["setup"])
        self.assertNotIn("two words", str(why.exception))
        self.assertEqual(FakeParticipant.calls, [])

    def test_a_role_without_a_token_file_is_refused_unless_there_is_no_login(self):
        del os.environ["CZE_TOKEN_FILE_READER"]
        with self.assertRaises(canton.Fail) as why:
            canton.main(["balances"])
        self.assertIn("CZE_TOKEN_FILE_READER", str(why.exception))
        self.assertEqual(FakeParticipant.calls, [])
        os.environ["CZE_LEDGER_NO_AUTH"] = "1"
        for role in self.ROLES:
            os.environ.pop(f"CZE_TOKEN_FILE_{role.upper()}", None)
        canton.main(["balances"])
        self.assertEqual({a for _, _, a in FakeParticipant.calls}, {None})   # no login: no token is sent

    def test_a_command_asks_only_for_the_tokens_it_needs(self):
        for role in ("operator", "reader", "builder", "confirmer", "admin"):
            del os.environ[f"CZE_TOKEN_FILE_{role.upper()}"]
        canton.main(["setup"])   # U's, V's and the registry's user only
        self.assertEqual({a for _, _, a in FakeParticipant.calls}, {"Bearer " + MARK + "demo"})

    def test_a_refusal_does_not_show_the_token(self):
        FakeLedger.refuse = "no right to act as that party"
        with self.assertRaises(canton.Refused) as why:
            canton.main(["accept", "u"])
        self.assertIn("no right to act", str(why.exception))
        self.assertNotIn(MARK, str(why.exception))

    def test_the_command_line_never_prints_a_token(self):
        env = {**os.environ}
        done = subprocess.run([sys.executable, str(ROOT / "demo" / "canton.py"), "balances"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn(MARK, done.stdout + done.stderr)
        self.token_file("reader", mode=0o666)
        done = subprocess.run([sys.executable, str(ROOT / "demo" / "canton.py"), "balances"], capture_output=True, text=True, env=env, timeout=60)
        self.assertNotEqual(done.returncode, 0)
        self.assertNotIn(MARK, done.stdout + done.stderr)
        self.assertIn("can be read by others", done.stdout + done.stderr)


class UploadTests(ExternalTestCase):
    def test_only_the_test_token_dar_goes_up_once_and_the_vetting_is_confirmed(self):
        out = canton.main(["upload-dars"])
        sums = canton.read_sums(ROOT / "daml" / "dars")
        self.assertEqual(FakeParticipant.uploads, [(canton.UPLOAD_PATH, sums[canton.TEST_TOKEN_DAR])])
        self.assertEqual(out, {"uploaded": [canton.TEST_TOKEN_DAR], "vetted": True, "package": TEST_TOKEN_PACKAGE, "to": ["participant"]})
        self.assertEqual(self.auth_of("/v2/packages"), ["Bearer " + MARK + "admin"])
        self.assertTrue(self.auth_of("/v2/package-vetting/list"))
        self.assertEqual(set(self.auth_of("/v2")), {"Bearer " + MARK + "admin"})   # all of it is the admin's: no other user is used

    def test_none_of_the_token_standards_packages_is_uploaded(self):
        canton.main(["upload-dars"])
        others = {hashlib.sha256((ROOT / "daml" / "dars" / n).read_bytes()).hexdigest() for n in canton.EXTRA_DARS if n != canton.TEST_TOKEN_DAR}
        self.assertFalse(others & {h for _, h in FakeParticipant.uploads})

    def test_a_package_the_participant_vets_already_is_not_uploaded_again(self):
        FakeParticipant.vetted = True
        out = canton.main(["upload-dars"])
        self.assertEqual(FakeParticipant.uploads, [])
        self.assertEqual((out["uploaded"], out["vetted"]), ([], True))

    def test_the_vetting_of_another_participant_does_not_count(self):
        FakeParticipant.vetted, FakeParticipant.vetted_by = True, "someone-else::1"
        with mock.patch.object(canton.Network, "wait_for", side_effect=canton.Fail("timed out waiting for the test token to be vetted")):
            with self.assertRaises(canton.Fail):
                canton.main(["upload-dars"])
        self.assertEqual(len(FakeParticipant.uploads), 1)   # it was not found vetted, so it was uploaded, and then the wait did not see it either

    def test_a_dar_that_is_not_the_one_in_sha256sums_is_refused_before_anything_is_sent(self):
        with mock.patch.object(canton, "read_sums", return_value={canton.TEST_TOKEN_DAR: "00" * 32}):
            with self.assertRaises(canton.Fail) as why:
                canton.main(["upload-dars"])
        self.assertIn("SHA256SUMS", str(why.exception))
        self.assertEqual(FakeParticipant.calls, [])

    def test_a_participant_with_no_vetting_list_is_a_failure(self):
        FakeParticipant.vetting_status = 404
        with self.assertRaises(canton.Fail) as why:
            canton.main(["upload-dars"])
        self.assertIn("vetting", str(why.exception))
        self.assertEqual(FakeParticipant.uploads, [])

    def test_the_package_id_is_the_one_the_dar_names(self):
        data = (ROOT / "daml" / "dars" / canton.TEST_TOKEN_DAR).read_bytes()
        self.assertEqual(canton.dar_package_id(data, "x"), TEST_TOKEN_PACKAGE)
        with self.assertRaises(canton.Fail):
            canton.dar_package_id(b"not a zip", "x")

    def test_the_local_network_still_gets_all_three_dars_on_all_three_participants(self):
        os.environ["CZE_CANTON"] = "local"
        os.environ["CZE_CONFIRMER_LEDGER_URL"] = os.environ["CZE_USERS_LEDGER_URL"] = self.url
        out = canton.main(["upload-dars"])
        self.assertEqual(out["uploaded"], canton.EXTRA_DARS)
        self.assertEqual(len(FakeParticipant.uploads), 9)
        self.assertEqual(set(self.auth_of("/v2/packages")), {None})   # the local network has no login


class RegisterTokenTests(ExternalTestCase):
    def stub(self, body):
        path = Path(self.tmp.name) / "propose-stub.py"
        path.write_text(body)
        patch = mock.patch.object(canton, "PROPOSE", path)
        patch.start()
        self.addCleanup(patch.stop)

    def test_propose_py_gets_the_one_participant_for_both_ledger_apis_and_the_prefix_and_the_token_files(self):
        self.stub("import json, os, sys\nprint(json.dumps({k: v for k, v in os.environ.items() if k.startswith('CZE_')}))\n")
        out = canton.main(["register-token", EVM_TOKEN])
        self.assertEqual(out["CZE_LEDGER_URL"], self.url)
        self.assertEqual(out["CZE_CONFIRMER_LEDGER_URL"], self.url)
        self.assertEqual(out["CZE_USER_PREFIX"], "ostia2-")
        self.assertEqual(out["CZE_TOKEN_FILE_OPERATOR"], str(self.tokens / "operator"))
        self.assertEqual(out["CZE_TOKEN_FILE_CONFIRMER"], str(self.tokens / "confirmer"))

    def test_the_chains_rpc_is_given_to_propose_py_when_it_is_set(self):
        self.assertNotIn("--reth-url", canton.propose_arguments(canton.Network(), EVM_TOKEN))
        os.environ["CZE_RPC_URL"] = "https://rpc.example"
        argv = canton.propose_arguments(canton.Network(), EVM_TOKEN)
        self.assertEqual(argv[-2:], ["--reth-url", "https://rpc.example"])
        sys.path.insert(0, str(ROOT / "network" / "canton"))
        import propose
        mode, args = propose.parse(argv, {"CHAIN_ID": "770101", "GAS_CAP": "30000000", "GATEWAY_ADDRESS": "0x" + "a7" + "00" * 19})
        self.assertEqual((mode, args.reth_url), ("token", "https://rpc.example"))


class NewCommandTests(ExternalTestCase):
    def test_setup_run_again_makes_nothing_new(self):
        first = canton.main(["setup"])
        made = len(FakeLedger.submitted)
        self.assertEqual(made, 2)   # the rules, then U's holding
        second = canton.main(["setup"])
        self.assertEqual(len(FakeLedger.submitted), made)
        self.assertEqual(first["rules"], second["rules"])

    def test_setup_finishes_what_a_stopped_run_left(self):
        FakeLedger.created.append({"contractId": "rules-0", "templateId": canton.RULES, "createArgument": {}, "offset": 7, "createdEventBlob": "b", "synchronizerId": "s"})
        out = canton.main(["setup"])
        self.assertEqual(out["rules"], "rules-0")
        self.assertEqual([b["commands"][0]["CreateCommand"]["templateId"] for _, b in FakeLedger.submitted], [canton.TOKEN])

    def test_two_sets_of_rules_are_refused(self):
        for n in (1, 2):
            FakeLedger.created.append({"contractId": f"rules-{n}", "templateId": canton.RULES, "createArgument": {}, "offset": n, "createdEventBlob": "b", "synchronizerId": "s"})
        with self.assertRaises(canton.Fail):
            canton.main(["setup"])
        self.assertEqual(FakeLedger.submitted, [])

    def test_registered_says_whether_the_gateway_has_the_token(self):
        self.assertEqual(canton.main(["registered", EVM_TOKEN]), {"evmToken": "ab" * 20, "registered": False, "proposed": False})
        FakeLedger.contracts[("op::1", canton.CHAIN + "GatewayToken")] = [{"contractId": "t1", "offset": 3, "createArgument": {"evmToken": "ab" * 20}}]
        self.assertTrue(canton.main(["registered", EVM_TOKEN.lower()])["registered"])
        with self.assertRaises(SystemExit):
            canton.main(["registered", "nobody"])

    def test_registered_says_when_the_proposal_is_waiting_for_the_confirmer(self):
        FakeLedger.contracts[("op::1", canton.CHAIN + "GatewayTokenProposal")] = [{"contractId": "p1", "offset": 3, "createArgument": {"evmToken": "ab" * 20}}]
        out = canton.main(["registered", EVM_TOKEN])
        self.assertEqual((out["registered"], out["proposed"]), (False, True))

    def left_proposal(self):
        proposal = {"contractId": "p1", "offset": 3, "createArgument": {"evmToken": "ab" * 20, "instrumentId": {"admin": "rg::1", "id": "TKB"}, "factory": "rules-1"}}
        FakeLedger.contracts[("op::1", canton.CHAIN + "GatewayTokenProposal")] = [proposal]
        FakeLedger.contracts[("co::1", canton.CHAIN + "GatewayTokenProposal")] = [proposal]

    def test_register_token_accepts_the_proposal_an_earlier_run_left(self):
        self.left_proposal()
        os.environ.pop("RETH_HTTP_PORT", None)
        with mock.patch.object(canton.propose, "gateway_made", return_value=True) as asked:
            out = canton.main(["register-token", EVM_TOKEN])
        asked.assert_called_once_with("http://127.0.0.1:8545", "a7" + "00" * 19, "ab" * 20)
        self.assertEqual(out["evmToken"], "ab" * 20)
        [(node, body)] = FakeLedger.submitted
        command = body["commands"][0]["ExerciseCommand"]
        self.assertEqual((command["choice"], command["contractId"], body["actAs"], body["userId"]), ("AcceptToken", "p1", ["co::1"], "ostia2-confirmer"))

    def test_a_left_proposal_is_not_accepted_when_the_gateway_did_not_make_the_token(self):
        self.left_proposal()
        with mock.patch.object(canton.propose, "gateway_made", return_value=False):
            with self.assertRaises(canton.Fail) as why:
                canton.main(["register-token", EVM_TOKEN])
        self.assertIn("did not make the token", str(why.exception))
        self.assertEqual(FakeLedger.submitted, [])

    def test_the_gateway_is_asked_at_the_chains_rpc_when_it_is_set(self):
        self.left_proposal()
        os.environ["CZE_RPC_URL"] = "https://rpc.example"
        with mock.patch.object(canton.propose, "gateway_made", return_value=True) as asked:
            canton.main(["register-token", EVM_TOKEN])
        self.assertEqual(asked.call_args.args[0], "https://rpc.example")

    def test_the_gateway_is_asked_at_the_reth_port_otherwise(self):
        self.left_proposal()
        os.environ["RETH_HTTP_PORT"] = "9999"
        with mock.patch.object(canton.propose, "gateway_made", return_value=True) as asked:
            canton.main(["register-token", EVM_TOKEN])
        self.assertEqual(asked.call_args.args[0], "http://127.0.0.1:9999")

    def test_a_left_proposal_for_another_instrument_is_refused(self):
        proposal = {"contractId": "p1", "offset": 3, "createArgument": {"evmToken": "ab" * 20, "instrumentId": {"admin": "other::1", "id": "TKB"}, "factory": "rules-0"}}
        FakeLedger.contracts[("op::1", canton.CHAIN + "GatewayTokenProposal")] = [proposal]
        with self.assertRaises(canton.Fail):
            canton.main(["register-token", EVM_TOKEN])
        self.assertEqual(FakeLedger.submitted, [])

    def test_block_with_a_party_reads_the_holdings_update_and_not_every_record(self):
        proof = "ab" * 1344
        rec = {"contractId": "r8", "offset": 50, "createArgument": {"number": "8", "blockHash": f"{8:064x}", "proofHex": proof}}
        FakeLedger.contracts[("re::1", canton.CHAIN + "BlockRecord")] = [rec]
        FakeLedger.contracts[("v::1", canton.TOKEN)] = [{"contractId": "h", "offset": 50, "createArgument": {}}]
        FakeLedger.updates = {50: ("upd-8", ["r8", "h"])}
        out = canton.main(["block", "8", "v"])
        self.assertEqual(out["record"]["blockHash"], f"{8:064x}")
        self.assertEqual(out["record"]["proofHex"], proof)
        self.assertNotIn(canton.CHAIN + "BlockRecord", [t for _, _, t in FakeLedger.asked])
        with self.assertRaises(canton.Fail):
            canton.main(["block", "9", "v"])
        with self.assertRaises(SystemExit):
            canton.main(["block", "8", "reader"])

    def test_block_gives_the_head_and_one_record_without_the_others(self):
        proof = "ab" * 1344
        rec = lambda n: {"contractId": f"r{n}", "offset": n, "createArgument": {"number": str(n), "blockHash": f"{n:064x}", "proofHex": proof}}
        FakeLedger.contracts[("re::1", canton.CHAIN + "BlockRecord")] = [rec(7), rec(8)]
        out = canton.main(["block", "8"])
        self.assertEqual(out["record"], {"number": 8, "blockHash": f"{8:064x}", "proofSha256": hashlib.sha256(bytes.fromhex(proof)).hexdigest(), "proofHex": proof})
        self.assertEqual(out["chain"], [{"headNumber": 3, "headHash": "ab" * 32}])
        with self.assertRaises(canton.Fail):
            canton.main(["block", "9"])

    def test_balances_is_status_without_the_chain_and_the_records(self):
        FakeLedger.contracts[("re::1", canton.CHAIN + "BlockRecord")] = [{"contractId": "r1", "offset": 1, "createArgument": {"number": "1", "blockHash": "00", "proofHex": "ab"}}]
        status, balances = canton.main(["status"]), canton.main(["balances"])
        self.assertEqual({k: v for k, v in status.items() if k not in ("chain", "blockRecords")}, balances)
        self.assertEqual(set(balances), {"tkb", "custody", "allocations", "terms", "deposits", "acceptances"})


if __name__ == "__main__":
    unittest.main()
