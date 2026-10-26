"""network/external/setup.py against a fake participant (a stateful JSON Ledger API). Run: python3 -m unittest discover -s tests -p 'test_external_setup.py'"""
import contextlib, io, json, os, re, sys, tempfile, threading, unittest, urllib.error, urllib.parse, zipfile
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "network" / "canton"))
sys.path.insert(0, str(ROOT / "network" / "external"))
import propose, setup

REAL_DAR_PACKAGE_IDS = setup.dar_package_ids   # the tests below replace it on the module with a fixed list

PKG = "ab" * 32
DEP = "cd" * 32   # a dependency the DAR carries, in the tests that say so
H = "ab" * 32
CHAIN_ARGS = ["--genesis-hash", H, "--genesis-state-root", "55" * 32, "--program-vk", "cd" * 32, "--root-c", "ef" * 32, "--rules-hash", "12" * 32]
FAKE_TOKENS = {"admin": "tok-admin-1", "operator": "tok-operator-2", "confirmer": "tok-confirmer-3"}


class FakeParticipant:
    """What setup.py touches: packages, parties, users and their rights, the chain's two templates. `calls` lists (method, path, authorization)."""
    def __init__(self, packages=(), vetting=True):
        self.packages, self.vetting, self.parties, self.users, self.contracts, self.calls = list(packages), vetting, [], {}, {"ZkChain": [], "ChainProposal": [], "GasCapProposal": [], "ProgramProposal": [], "ChangeDelayProposal": []}, []
        self.dep, self.dep_vetted, self.ignores_query = None, True, False   # a dependency of the package, whether it is vetted; a participant that ignores vetAllPackages
        self.invalid_dar, self.updates = False, []   # a DAR that /v2/dars/validate refuses; the bodies of /v2/package-vetting/update
        self.remote, self.vetted_by, self.unknown_is_404 = [], "PAR::ostia-test::1220fp", False   # parties hosted elsewhere; who vetted the package; how an unknown party is answered
        node = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, body, status=200):
                data = json.dumps(body).encode()
                self.send_response(status); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(data)

            def handle_any(self, method):
                raw = self.rfile.read(int(self.headers.get("content-length") or 0))
                node.calls.append((method, self.path, self.headers.get("authorization")))
                body = json.loads(raw) if raw and self.headers["content-type"] == "application/json" else None
                answer = node.route(method, self.path, body, raw)   # the query string stays in the path: a test reads it
                self.send(*answer) if isinstance(answer, tuple) else self.send(answer)

            def do_GET(self): self.handle_any("GET")
            def do_POST(self): self.handle_any("POST")

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown(); self.server.server_close()

    def mutations(self):
        return [c for c in self.calls if c[0] == "POST" and c[1] not in ("/v2/state/active-contracts", "/v2/package-vetting/list") and not c[1].startswith("/v2/dars/validate")]

    def route(self, method, path, body, raw):
        if (method, path) == ("GET", "/v2/packages"):
            return {"packageIds": self.packages}
        if method == "POST" and path.split("?")[0] == "/v2/packages":
            self.packages.append(PKG)
            if path.endswith("?vetAllPackages=false") and not self.ignores_query:
                self.vetting = False   # the participant keeps the package and vets nothing
            return {}
        if method == "POST" and path.split("?")[0] == "/v2/dars/validate":
            return ({"code": "DAR_VALIDATION_FAILED", "cause": "not a valid upgrade"}, 400) if self.invalid_dar else {}
        if (method, path) == ("POST", "/v2/package-vetting/update"):
            self.updates.append(body)
            asked = [r["packageId"] for r in body["changes"][0]["operation"]["Vet"]["value"]["packages"]]
            if any(a not in self.packages for a in asked):
                return {"code": "PACKAGE_NOT_FOUND"}, 400
            if self.dep and PKG in asked and DEP not in asked and not self.dep_vetted:
                return {"code": "TOPOLOGY_DEPENDENCIES_NOT_VETTED"}, 400
            if not body["dryRun"]:
                self.vetting = self.vetting or PKG in asked
                self.dep_vetted = self.dep_vetted or DEP in asked
            return {"newVettedPackages": {"participantId": self.vetted_by, "synchronizerId": body["synchronizerId"], "topologySerial": 2, "packages": [{"packageId": a} for a in asked]}}
        if path == "/v2/state/connected-synchronizers":
            return {"connectedSynchronizers": [{"synchronizerAlias": "global", "synchronizerId": "global::1220"}]}
        if path == "/v2/parties/participant-id":
            return {"participantId": "PAR::ostia-test::1220fp"}
        if path == "/v2/package-vetting/list":
            if self.vetting is None:
                return {}, 404
            asked = body["topologyStateFilter"]["participantIds"]
            if asked and self.vetted_by not in asked:
                return {"vettedPackages": []}
            return {"vettedPackages": [{"participantId": self.vetted_by, "synchronizerId": "global::1220", "packages": [{"packageId": i} for i, on in ((PKG, self.vetting), (DEP, self.dep and self.dep_vetted)) if on and i in body["packageMetadataFilter"]["packageIds"]]}]}
        m = re.fullmatch(r"/v2/parties/([^/?]+)", path)
        if method == "GET" and m:
            # One party by id (url-encoded): the participant knows the remote ones too, with isLocal false. A party it has never heard of is 200 with an empty
            # list on the pinned Canton 3.6.3 (measured by tests/canton_external.sh); a participant may answer 404 instead.
            party = urllib.parse.unquote(m[1])
            if party in self.parties or party in self.remote:
                return {"partyDetails": [{"party": party, "isLocal": party in self.parties}]}
            return ({}, 404) if self.unknown_is_404 else {"partyDetails": []}
        if (method, path) == ("POST", "/v2/parties"):
            self.parties.append(body["partyIdHint"] + "::1220fp")
            return {"partyDetails": {"party": self.parties[-1]}}
        m = re.fullmatch(r"/v2/users/([^/]+)/rights", path)
        if m and method == "GET":
            return {"rights": self.users[m[1]]["rights"]} if m[1] in self.users else ({}, 404)
        if m and method == "POST":
            self.users[m[1]]["rights"] += body["rights"]
            return {}
        if (method, path) == ("POST", "/v2/users"):
            self.users[body["user"]["id"]] = {"user": body["user"], "rights": body["rights"]}
            return {}
        if path == "/v2/state/ledger-end":
            return {"offset": 5}
        if path == "/v2/state/active-contracts":
            name = body["eventFormat"]["filtersByParty"].popitem()[1]["cumulative"][0]["identifierFilter"]["TemplateFilter"]["value"]["templateId"].split(":")[-1]
            return [{"contractEntry": {"JsActiveContract": {"createdEvent": {"contractId": c["contractId"], "createArgument": c["args"]}}}} for c in self.contracts.get(name, [])]
        if path == "/v2/commands/submit-and-wait":
            command = body["commands"][0]
            self.submitted = getattr(self, "submitted", []) + [(command, body["actAs"])]
            self.submitted_users = getattr(self, "submitted_users", []) + [body.get("userId")]
            if "ExerciseCommand" in command and command["ExerciseCommand"]["choice"].startswith("Withdraw"):
                exercise = command["ExerciseCommand"]
                name = exercise["templateId"].split(":")[-1]
                self.contracts[name] = [c for c in self.contracts[name] if c["contractId"] != exercise["contractId"]]
                return {}
            if "ExerciseCommand" in command and command["ExerciseCommand"]["templateId"].split(":")[-1] in ("GasCapProposal", "ProgramProposal", "ChangeDelayProposal"):
                # an accept: the chain refuses it until the wait that its changeDelay names has passed since the proposal's ledger time (the Daml's waitedOut)
                exercise = command["ExerciseCommand"]
                [proposal] = [c for c in self.contracts[exercise["templateId"].split(":")[-1]] if c["contractId"] == exercise["contractId"]]
                [chain] = [c for c in self.contracts["ZkChain"] if c["contractId"] == exercise["choiceArgument"]["chain"]]
                delay = int((chain["args"].get("changeDelay") or {"microseconds": "0"})["microseconds"])
                ready = datetime.fromisoformat(proposal["args"]["proposedAt"].replace("Z", "+00:00")) + timedelta(microseconds=delay)
                if datetime.now(timezone.utc) < ready:
                    return {"code": "INTERPRETATION_ERROR", "cause": f"the change may be accepted from {ready.isoformat()}"}, 400
            if "ExerciseCommand" in command and command["ExerciseCommand"]["templateId"].endswith("ChangeDelayProposal"):
                self.contracts["ChangeDelayProposal"].remove(proposal)
                chain["args"]["changeDelay"] = proposal["args"]["newDelay"]
            elif "ExerciseCommand" in command and command["ExerciseCommand"]["templateId"].endswith("GasCapProposal"):
                [chain] = [c for c in self.contracts["ZkChain"] if c["contractId"] == exercise["choiceArgument"]["chain"]]
                self.contracts["GasCapProposal"].remove(proposal)
                chain["args"]["gasCap"] = proposal["args"]["newCap"]
            elif "ExerciseCommand" in command and command["ExerciseCommand"]["templateId"].endswith("ProgramProposal"):
                exercise = command["ExerciseCommand"]
                [proposal] = [c for c in self.contracts["ProgramProposal"] if c["contractId"] == exercise["contractId"]]
                [chain] = [c for c in self.contracts["ZkChain"] if c["contractId"] == exercise["choiceArgument"]["chain"]]
                self.contracts["ProgramProposal"].remove(proposal)
                for field in ("programVK", "rootC", "rulesHash"):
                    chain["args"][field] = proposal["args"]["new" + field[0].upper() + field[1:]]
            elif "ExerciseCommand" in command and command["ExerciseCommand"]["choice"] in ("ProposeGasCap", "ProposeProgram", "ProposeChangeDelay"):
                # ZkChain.ProposeGasCap / ProposeProgram / ProposeChangeDelay make the proposal, from the chain's fields and the choice's arguments,
                # and stamp it with the ledger time (here the clock of this machine, or `ledger_time` when a test sets it)
                exercise = command["ExerciseCommand"]
                [chain] = [c for c in self.contracts["ZkChain"] if c["contractId"] == exercise["contractId"]]
                name = {"ProposeGasCap": "GasCapProposal", "ProposeProgram": "ProgramProposal", "ProposeChangeDelay": "ChangeDelayProposal"}[exercise["choice"]]
                keys = ("operator", "confirmer", "chainId") if name == "GasCapProposal" else ("operator", "confirmer", "gateway", "chainId")
                now = getattr(self, "ledger_time", None) or datetime.now(timezone.utc)
                self.contracts[name].append({"contractId": {"GasCapProposal": "g1", "ProgramProposal": "q1", "ChangeDelayProposal": "d1"}[name],
                                             "args": {**{k: chain["args"][k] for k in keys}, **exercise["choiceArgument"], "proposedAt": now.isoformat(timespec="microseconds").replace("+00:00", "Z")}})
            elif "CreateCommand" in command:
                self.contracts["ChainProposal"].append({"contractId": "p1", "args": command["CreateCommand"]["createArguments"]})
            else:
                proposal, = self.contracts["ChainProposal"]
                self.contracts["ChainProposal"] = []
                # The chain has the head and no genesis: the fields of the real ZkChain template.
                genesis = {k: proposal["args"][k] for k in ("genesisHash", "genesisStateRoot")}
                chain = {k: v for k, v in proposal["args"].items() if k not in genesis}
                self.contracts["ZkChain"].append({"contractId": "c1", "args": {**chain, "headNumber": "0", "headHash": genesis["genesisHash"], "headStateRoot": genesis["genesisStateRoot"]}})
            return {}
        raise AssertionError(f"unexpected {method} {path}")


class Setup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name) / "state"
        self.tokens = {}
        for role, fake_token in FAKE_TOKENS.items():
            path = Path(self.tmp.name) / role
            path.write_text(fake_token + "\n"); path.chmod(0o600)
            self.tokens[role] = path
        env = {"CZE_STATE_DIR": str(self.state), "CZE_USER_PREFIX": "ostia-", **{f"CZE_TOKEN_FILE_{r.upper()}": str(p) for r, p in self.tokens.items()}}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start(); self.addCleanup(patcher.stop)
        patcher = mock.patch.object(setup, "package_id_of", lambda dar: PKG)
        patcher.start(); self.addCleanup(patcher.stop)
        self.dar_packages = [PKG]   # the packages the DAR carries: the main one, then its dependencies
        patcher = mock.patch.object(setup, "dar_package_ids", lambda dar: self.dar_packages)
        patcher.start(); self.addCleanup(patcher.stop)
        self.dar = Path(self.tmp.name) / "stand-in.dar"
        self.dar.write_bytes(b"PK stand-in")
        self.node = FakeParticipant()
        self.addCleanup(self.node.close); self.addCleanup(self.tmp.cleanup)

    def run_setup(self, *extra, chain=True):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = setup.main(["--ledger-url", self.node.url, "--dar", str(self.dar), *extra, *(["--", *CHAIN_ARGS] if chain else [])])
        return code, out.getvalue(), err.getvalue()

    def rights(self, user):
        return {(k, b["value"]["party"]) for r in self.node.users[user]["rights"] for k, b in r["kind"].items()}

    def test_a_new_participant_gets_the_package_the_parties_the_users_and_the_chain(self):
        _, out, err = self.run_setup()
        self.assertEqual(self.node.packages, [PKG])
        self.assertEqual(sorted(self.node.parties), sorted(f"ostia-{n}::1220fp" for n in setup.CHAIN_PARTIES))
        chain = json.loads(out)
        self.assertEqual((chain["created"], chain["headNumber"], chain["headHash"]), (True, "0", H))
        env = propose.read_env_file(self.state / "canton" / "parties.env")
        self.assertEqual(env["OPERATOR_PARTY"], "ostia-operator::1220fp")
        self.assertNotIn("U_PARTY", env)
        self.assertEqual(oct(self.state.joinpath("canton", "parties.env").stat().st_mode & 0o777), "0o600")

    def test_every_user_has_exactly_the_rights_of_its_role(self):
        self.run_setup()
        p = lambda n: f"ostia-{n}::1220fp"
        self.assertEqual(self.rights("ostia-operator"), {("CanActAs", p("operator")), ("CanActAs", p("gateway"))})
        self.assertEqual(self.rights("ostia-builder"), {("CanActAs", p("builder")), ("CanReadAs", p("operator")), ("CanReadAs", p("gateway"))})
        self.assertEqual(self.rights("ostia-confirmer"), {("CanActAs", p("confirmer"))})
        self.assertEqual(self.rights("ostia-reader"), {("CanReadAs", p("reader"))})
        self.assertEqual(self.node.users["ostia-builder"]["user"]["primaryParty"], p("builder"))
        self.assertNotIn("ostia-demo", self.node.users)

    def test_the_demo_parties_and_users_come_only_on_request(self):
        self.run_setup("--demo", chain=False)
        self.assertEqual(self.rights("ostia-demo"), {("CanActAs", f"ostia-{n}::1220fp") for n in ("u", "v", "registry")})
        self.assertIn("ostia-u::1220fp", self.node.parties)
        self.assertEqual(propose.read_env_file(self.state / "canton" / "parties.env")["REGISTRY_PARTY"], "ostia-registry::1220fp")

    def test_a_second_run_changes_nothing(self):
        _, first, _ = self.run_setup("--demo")
        before = (self.state / "canton" / "parties.env").stat().st_mtime_ns
        self.node.calls.clear()
        _, second, err = self.run_setup("--demo")
        self.assertEqual(self.node.mutations(), [])
        self.assertEqual((self.state / "canton" / "parties.env").stat().st_mtime_ns, before)
        self.assertEqual(json.loads(second), {**json.loads(first), "created": False})
        self.assertIn("the chain is there already", err)

    def test_each_call_carries_the_token_of_its_role_and_no_token_is_printed(self):
        _, out, err = self.run_setup()
        by_path = lambda prefix: {c[2] for c in self.node.calls if c[1].startswith(prefix)}
        self.assertEqual(by_path("/v2/users"), {"Bearer tok-admin-1"})
        self.assertEqual(by_path("/v2/parties"), {"Bearer tok-admin-1"})
        submits = [c[2] for c in self.node.calls if c[1] == "/v2/commands/submit-and-wait"]
        self.assertEqual(submits, ["Bearer tok-operator-2", "Bearer tok-confirmer-3"])
        for fake_token in FAKE_TOKENS.values():
            self.assertNotIn(fake_token, out + err)

    def test_without_token_files_no_authorization_header_is_sent(self):
        with mock.patch.dict(os.environ):
            for r in FAKE_TOKENS:
                os.environ.pop(f"CZE_TOKEN_FILE_{r.upper()}")
            os.environ["CZE_LEDGER_NO_AUTH"] = "1"
            self.run_setup()
        self.assertEqual({c[2] for c in self.node.calls}, {None})

    def test_a_token_file_that_others_can_read_is_refused_without_showing_the_token(self):
        self.tokens["admin"].chmod(0o644)
        with self.assertRaises(SystemExit) as ctx:
            self.run_setup()
        self.assertIn("chmod 600", str(ctx.exception))
        self.assertNotIn(FAKE_TOKENS["admin"], str(ctx.exception))
        self.assertEqual(self.node.calls, [])

    def test_without_token_files_and_without_the_no_login_setting_it_stops_before_any_call(self):
        with mock.patch.dict(os.environ):
            os.environ.pop("CZE_TOKEN_FILE_CONFIRMER")
            os.environ.pop("CZE_LEDGER_NO_AUTH", None)
            with self.assertRaises(SystemExit) as ctx:
                self.run_setup()
        self.assertIn("CZE_TOKEN_FILE_CONFIRMER is not set", str(ctx.exception))
        self.assertEqual(self.node.calls, [])

    def test_a_token_file_that_others_can_read_stops_the_run_before_any_call_whatever_its_role(self):
        # The confirmer's token is first used after the participant has been changed: it is checked up front, with every other file.
        for role in ("operator", "confirmer"):
            self.tokens[role].chmod(0o640)
            with self.subTest(role=role), self.assertRaises(SystemExit) as ctx:
                self.run_setup()
            self.assertIn("chmod 600", str(ctx.exception))
            self.assertNotIn(FAKE_TOKENS[role], str(ctx.exception))
            self.assertEqual(self.node.calls, [])
            self.tokens[role].chmod(0o600)

    def test_a_builder_token_file_that_others_can_read_is_refused_too(self):
        builder = Path(self.tmp.name) / "builder"
        builder.write_text("tok-builder-4\n"); builder.chmod(0o604)
        with mock.patch.dict(os.environ, {"CZE_TOKEN_FILE_BUILDER": str(builder)}), self.assertRaises(SystemExit) as ctx:
            self.run_setup()
        self.assertIn("chmod 600", str(ctx.exception))
        self.assertEqual(self.node.calls, [])

    def test_a_ledger_url_on_another_host_over_plain_http_is_refused_before_any_token_is_read(self):
        for url in ("http://10.1.2.3:7575", "http://ledger.example", "http://127.0.0.1.evil.example:7575"):
            with self.subTest(url=url), self.assertRaises(SystemExit) as ctx:
                setup.main(["--ledger-url", url, "--dar", str(self.dar)])
            self.assertIn("in the clear", str(ctx.exception))
        for fake_token in FAKE_TOKENS.values():
            self.assertNotIn(fake_token, str(ctx.exception))

    def test_https_and_loopback_urls_pass_the_url_rule(self):
        for url in ("https://ledger.example", "https://ledger.example:7575/api", "http://127.0.0.1:7575", "http://localhost:7575", "http://[::1]:7575"):
            with self.subTest(url=url):
                setup.check_settings(url)

    def test_a_token_file_with_two_words_is_refused(self):
        self.tokens["admin"].write_text("two words\n")
        with self.assertRaises(SystemExit) as ctx:
            self.run_setup()
        self.assertIn("one token", str(ctx.exception))
        self.assertNotIn("two words", str(ctx.exception))

    def test_a_user_with_more_rights_than_its_role_needs_is_refused(self):
        self.node.parties = [f"ostia-{n}::1220fp" for n in setup.CHAIN_PARTIES]
        self.node.users["ostia-reader"] = {"user": {}, "rights": [setup.right_json("CanActAs", "ostia-operator::1220fp")]}
        with self.assertRaises(SystemExit) as ctx:
            self.run_setup()
        self.assertIn("rights that reader does not need", str(ctx.exception))

    def test_a_user_that_misses_a_right_is_granted_it(self):
        self.node.parties = [f"ostia-{n}::1220fp" for n in setup.CHAIN_PARTIES]
        self.node.users["ostia-builder"] = {"user": {}, "rights": [setup.right_json("CanActAs", "ostia-builder::1220fp")]}
        self.run_setup(chain=False)
        self.assertEqual(len(self.rights("ostia-builder")), 3)

    def leave_proposal(self, **different):
        """A proposal that an earlier run left, as the real template has it, with some fields changed."""
        self.run_setup(chain=False)
        parties = {n.upper() + "_PARTY": f"ostia-{n}::1220fp" for n in setup.CHAIN_PARTIES}
        _, args = propose.parse(CHAIN_ARGS, propose.read_env_file(ROOT / "PINS"))
        fields = {**propose.proposal_arguments(args, parties), **different}
        propose.operator_ledger(self.node.url, parties).submit({"CreateCommand": {"templateId": propose.PKG + "ChainProposal", "createArguments": fields}})

    def test_a_proposal_that_an_earlier_run_left_is_accepted(self):
        self.leave_proposal()
        _, out, _ = self.run_setup()
        self.assertEqual(len(self.node.contracts["ZkChain"]), 1)
        self.assertTrue(json.loads(out)["created"])

    def test_a_proposal_of_another_chain_is_not_accepted(self):
        for field, value in {"genesisHash": "00" * 32, "programVK": "00" * 32, "gatewayAddress": "11" * 20, "gasCap": "5", "rulesHash": "00" * 32}.items():
            with self.subTest(field=field):
                self.setUp()
                self.leave_proposal(**{field: value})
                with self.assertRaises(SystemExit) as ctx:
                    self.run_setup()
                self.assertIn(field, str(ctx.exception))
                self.assertEqual(self.node.contracts["ZkChain"], [])
                self.assertEqual(len(self.node.contracts["ChainProposal"]), 1)

    def test_a_chain_at_block_0_with_another_genesis_is_refused(self):
        self.run_setup()
        self.node.contracts["ZkChain"][0]["args"]["headHash"] = "00" * 32
        with self.assertRaises(SystemExit) as ctx:
            self.run_setup()
        self.assertIn("headHash", str(ctx.exception))

    def test_the_chain_template_has_no_genesis_field(self):
        self.run_setup()
        self.assertFalse({"genesisHash", "genesisStateRoot"} & set(self.node.contracts["ZkChain"][0]["args"]))

    def test_a_chain_past_block_0_is_found_whatever_its_head(self):
        self.run_setup()
        self.node.contracts["ZkChain"][0]["args"].update({"headNumber": "1", "headHash": "99" * 32, "headStateRoot": "98" * 32})
        _, out, _ = self.run_setup()
        self.assertEqual(json.loads(out)["headNumber"], "1")

    def raise_step(self, step, new_cap, *extra):
        """setup.py --gas-cap-step: only the operator's or the confirmer's token; returns the JSON line it printed."""
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = setup.main(["--ledger-url", self.node.url, "--gas-cap-step", step, "--new-gas-cap", str(new_cap), *extra])
        self.assertEqual(code, 0)
        return json.loads(out.getvalue())

    def sent(self):
        return getattr(self.node, "submitted", [])

    def test_a_proposed_gas_cap_is_accepted_and_the_chain_check_takes_the_raised_cap(self):
        self.run_setup()
        before = len(self.sent())
        proposed = self.raise_step("propose", 50_000_000)
        self.assertEqual((proposed["submitted"], proposed["currentGasCap"], proposed["newGasCap"]), (True, "30000000", "50000000"))
        [(command, acts)] = self.sent()[before:]
        self.assertEqual(acts, ["ostia-operator::1220fp"])
        self.assertEqual((command["ExerciseCommand"]["choice"], command["ExerciseCommand"]["choiceArgument"]), ("ProposeGasCap", {"newCap": "50000000"}))
        self.assertEqual(self.node.contracts["GasCapProposal"][0]["args"]["newCap"], "50000000")
        self.assertEqual(self.node.contracts["ZkChain"][0]["args"]["gasCap"], "30000000")   # the proposal alone changes nothing
        accepted = self.raise_step("accept", 50_000_000)
        self.assertTrue(accepted["submitted"])
        self.assertEqual(self.sent()[-1][1], ["ostia-confirmer::1220fp"])
        self.assertEqual(self.sent()[-1][0]["ExerciseCommand"]["choiceArgument"], {"chain": "c1"})
        self.assertEqual(self.node.contracts["ZkChain"][0]["args"]["gasCap"], "50000000")
        self.assertEqual(self.node.contracts["GasCapProposal"], [])
        _, out, _ = self.run_setup()   # the chain check: the live cap is above PINS' and passes
        self.assertFalse(json.loads(out)["created"])

    def test_a_dry_run_submits_nothing_and_says_what_it_would_do(self):
        self.run_setup()
        before = len(self.sent())
        dry = self.raise_step("propose", 40_000_000, "--dry-run")
        self.assertEqual((dry["dryRun"], dry["submitted"]), (True, False))
        self.assertEqual(self.node.contracts["GasCapProposal"], [])
        self.raise_step("propose", 40_000_000)
        before = len(self.sent())
        dry = self.raise_step("accept", 40_000_000, "--dry-run")
        self.assertEqual((dry["dryRun"], dry["submitted"], dry["newGasCap"]), (True, False, "40000000"))
        self.assertEqual(len(self.sent()), before)
        self.assertEqual(len(self.node.contracts["GasCapProposal"]), 1)
        self.assertEqual(self.node.contracts["ZkChain"][0]["args"]["gasCap"], "30000000")

    def test_a_cap_the_daml_would_refuse_is_refused_before_anything_is_submitted(self):
        self.run_setup()
        before = len(self.sent())
        for value, why in ((30_000_000, "above"), (20_000_000, "above"), (60_000_001, "double")):
            with self.subTest(value=value), self.assertRaises(SystemExit) as ctx:
                self.raise_step("propose", value)
            self.assertIn(why, str(ctx.exception))
            # a proposal for the value (made when the chain's cap was another, or by hand) is refused by the accept as well
            self.node.contracts["GasCapProposal"] = [{"contractId": "g9", "args": {**self.chain_args(), "newCap": str(value)}}]
            with self.subTest(value=value, step="accept"), self.assertRaises(SystemExit) as ctx:
                self.raise_step("accept", value)
            self.assertIn(why, str(ctx.exception))
            self.node.contracts["GasCapProposal"] = []
        self.assertEqual(len(self.sent()), before)
        self.assertEqual(self.node.contracts["GasCapProposal"], [])

    def test_a_cap_over_300_million_is_refused(self):
        self.run_setup()
        self.node.contracts["ZkChain"][0]["args"]["gasCap"] = "200000000"   # a chain whose cap was raised before: double of it is over the highest
        before = len(self.sent())
        for value in (300_000_001, 400_000_000):
            with self.subTest(value=value), self.assertRaises(SystemExit) as ctx:
                self.raise_step("propose", value)
            self.assertIn("300000000", str(ctx.exception))
        self.raise_step("propose", 300_000_000, "--dry-run")
        self.assertEqual(len(self.sent()), before)

    def test_the_accept_refuses_a_cap_that_is_no_longer_a_raise_and_one_nobody_proposed(self):
        self.run_setup()
        with self.assertRaises(SystemExit) as ctx:
            self.raise_step("accept", 50_000_000)
        self.assertIn("no proposal", str(ctx.exception))
        self.raise_step("propose", 50_000_000)
        self.node.contracts["ZkChain"][0]["args"]["gasCap"] = "60000000"   # the chain moved on after the proposal
        before = len(self.sent())
        with self.assertRaises(SystemExit) as ctx:
            self.raise_step("accept", 50_000_000)
        self.assertIn("above", str(ctx.exception))
        self.assertEqual(len(self.sent()), before)

    def test_a_second_propose_for_the_same_cap_changes_nothing_and_another_cap_is_refused(self):
        self.run_setup()
        self.raise_step("propose", 50_000_000)
        before = len(self.sent())
        again = self.raise_step("propose", 50_000_000)
        self.assertEqual((again["submitted"], again["alreadyProposed"]), (False, True))
        with self.assertRaises(SystemExit) as ctx:
            self.raise_step("propose", 45_000_000)
        self.assertIn("50000000", str(ctx.exception))
        self.assertEqual(len(self.sent()), before)

    def chain_args(self):
        return {k: self.node.contracts["ZkChain"][0]["args"][k] for k in ("operator", "confirmer", "chainId")}

    def test_accept_takes_exactly_the_value_given_and_not_another_proposal(self):
        self.run_setup()
        self.raise_step("propose", 50_000_000)
        before = len(self.sent())
        for value in (40_000_000, 60_000_000):
            with self.subTest(value=value), self.assertRaises(SystemExit) as ctx:
                self.raise_step("accept", value)
            self.assertIn("no proposal", str(ctx.exception))
        self.assertEqual(len(self.sent()), before)
        self.assertEqual(self.node.contracts["ZkChain"][0]["args"]["gasCap"], "30000000")

    def test_a_chain_of_other_parties_is_refused_by_both_steps(self):
        self.run_setup()
        for field in ("operator", "confirmer"):
            self.node.contracts["ZkChain"][0]["args"][field] = "someone-else::1220fp"
            for step in ("propose", "accept"):
                before = len(self.sent())
                with self.subTest(field=field, step=step), self.assertRaises(SystemExit) as ctx:
                    self.raise_step(step, 50_000_000)
                self.assertIn("operator and confirmer", str(ctx.exception))
                self.assertEqual(len(self.sent()), before)
            self.node.contracts["ZkChain"][0]["args"][field] = {"operator": "ostia-operator::1220fp", "confirmer": "ostia-confirmer::1220fp"}[field]

    def test_exactly_double_is_proposed_and_accepted(self):
        self.run_setup()
        self.assertTrue(self.raise_step("propose", 60_000_000)["submitted"])
        self.assertTrue(self.raise_step("accept", 60_000_000)["submitted"])
        self.assertEqual(self.node.contracts["ZkChain"][0]["args"]["gasCap"], "60000000")

    def test_a_second_accept_after_it_went_through_is_done_not_an_error(self):
        self.run_setup()
        self.raise_step("propose", 50_000_000)
        self.raise_step("accept", 50_000_000)
        before = len(self.sent())
        again = self.raise_step("accept", 50_000_000)
        self.assertEqual((again["submitted"], again["alreadyAccepted"]), (False, True))
        self.assertEqual(len(self.sent()), before)
        with self.assertRaises(SystemExit):   # another value that nobody proposed is still an error
            self.raise_step("accept", 55_000_000)

    def test_a_refused_submit_stops_with_the_participants_reason(self):
        self.run_setup()
        def refused(self_, command):
            raise urllib.error.HTTPError("u", 409, "Conflict", {}, io.BytesIO(b"CONTRACT_NOT_FOUND stale"))
        with mock.patch.object(propose.Ledger, "submit", refused), self.assertRaises(SystemExit) as ctx:
            self.raise_step("propose", 50_000_000)
        self.assertIn("CONTRACT_NOT_FOUND", str(ctx.exception))
        self.raise_step("propose", 50_000_000)
        with mock.patch.object(propose.Ledger, "submit", refused), self.assertRaises(SystemExit) as ctx:
            self.raise_step("accept", 50_000_000)
        self.assertIn("CONTRACT_NOT_FOUND", str(ctx.exception))
        self.assertIn("run the accept again", str(ctx.exception))

    def test_the_message_for_another_proposal_points_to_the_withdraw(self):
        self.run_setup()
        self.raise_step("propose", 50_000_000)
        with self.assertRaises(SystemExit) as ctx:
            self.raise_step("propose", 45_000_000)
        self.assertIn("Withdraw", str(ctx.exception))
        self.assertNotIn("leave it", str(ctx.exception))

    def test_the_wait_check_can_be_skipped_so_the_ledger_refuses_the_early_accept_itself(self):
        self.run_setup()
        self.set_chain_delay(3600)
        self.raise_step("propose", 50_000_000)
        base = len(self.sent())
        with self.assertRaises(SystemExit) as ctx:
            self.raise_step("accept", 50_000_000)
        self.assertIn("may be accepted from", str(ctx.exception))
        self.assertEqual(len(self.sent()), base)   # the clock check stopped it: only the propose was sent
        with mock.patch.dict(os.environ, {"CZE_SKIP_WAIT_CHECK": "1"}), self.assertRaises(SystemExit) as ctx:
            self.raise_step("accept", 50_000_000)
        self.assertIn("the accept was refused: HTTP 400", str(ctx.exception))
        self.assertIn("may be accepted from", str(ctx.exception))
        self.assertEqual(len(self.sent()), base + 1)   # sent, and the ledger (here the fake) refused it
        self.assertEqual(self.node.contracts["ZkChain"][0]["args"]["gasCap"], "30000000")

    def withdraw(self, kind, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = setup.main(["--ledger-url", self.node.url, "--withdraw-proposal", kind, *extra])
        self.assertEqual(code, 0)
        return json.loads(out.getvalue())

    def test_the_withdraw_uses_the_ostia_operator_user_when_the_prefix_is_not_set(self):
        self.run_setup()
        self.raise_step("propose", 50_000_000)
        os.environ.pop("CZE_USER_PREFIX")                    # the operator runs the step with no prefix in the environment
        self.addCleanup(os.environ.pop, "CZE_USER_PREFIX", None)
        self.assertEqual(self.withdraw("gas-cap")["withdrawn"], 1)
        self.assertEqual(self.node.submitted_users[-1], "ostia-operator")

    def test_the_withdraw_refuses_a_value_flag(self):
        for extra in (["--new-gas-cap", "50000000"], ["--delay-seconds", "5"], ["--program-vk", "ab" * 32]):
            with self.assertRaises(SystemExit) as e, contextlib.redirect_stderr(io.StringIO()):
                setup.main(["--ledger-url", self.node.url, "--withdraw-proposal", "gas-cap", *extra])
            self.assertEqual(e.exception.code, 2, extra)

    def test_the_operator_withdraws_a_pending_proposal_of_each_kind_and_can_propose_again(self):
        self.run_setup()
        self.raise_step("propose", 50_000_000)
        self.program_step("propose")
        self.delay_step("propose", 20)
        for kind, name in (("gas-cap", "GasCapProposal"), ("program", "ProgramProposal"), ("change-delay", "ChangeDelayProposal")):
            dry = self.withdraw(kind, "--dry-run")
            self.assertEqual((dry["pending"], dry["withdrawn"], dry["dryRun"]), (1, 0, True))
            self.assertEqual(len(self.node.contracts[name]), 1)
            done = self.withdraw(kind)
            self.assertEqual((done["pending"], done["withdrawn"]), (1, 1))
            self.assertEqual(self.node.contracts[name], [])
            self.assertEqual(self.withdraw(kind)["pending"], 0)
        command, acting = self.sent()[-1]
        self.assertEqual(command["ExerciseCommand"]["choice"], "WithdrawChangeDelay")
        self.raise_step("propose", 45_000_000)
        self.assertEqual(len(self.node.contracts["GasCapProposal"]), 1)

    def test_each_gas_cap_step_needs_only_its_own_token_and_sends_no_other(self):
        self.run_setup()
        self.node.calls.clear()
        os.environ.pop("CZE_TOKEN_FILE_ADMIN"); os.environ.pop("CZE_TOKEN_FILE_CONFIRMER")
        self.raise_step("propose", 50_000_000)
        self.assertEqual({c[2] for c in self.node.calls}, {"Bearer tok-operator-2"})
        os.environ["CZE_TOKEN_FILE_CONFIRMER"] = str(self.tokens["confirmer"]); os.environ.pop("CZE_TOKEN_FILE_OPERATOR")
        self.node.calls.clear()
        self.raise_step("accept", 50_000_000)
        self.assertEqual({c[2] for c in self.node.calls}, {"Bearer tok-confirmer-3"})
        os.environ.pop("CZE_TOKEN_FILE_CONFIRMER")
        with self.assertRaises(SystemExit) as ctx:
            self.raise_step("accept", 60_000_000)
        self.assertIn("CZE_TOKEN_FILE_CONFIRMER", str(ctx.exception))

    def test_a_gas_cap_step_refuses_the_chain_arguments_the_demo_and_a_missing_value(self):
        for extra in (["--demo"], ["--package-step", "check"], ["--", *CHAIN_ARGS]):
            with self.subTest(extra=extra), self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                setup.main(["--ledger-url", self.node.url, "--gas-cap-step", "propose", "--new-gas-cap", "5", *extra])
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            setup.main(["--ledger-url", self.node.url, "--gas-cap-step", "propose"])
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            setup.main(["--ledger-url", self.node.url, "--dar", str(self.dar), "--new-gas-cap", "5"])

    NEW_PROGRAM = ("ab" * 32, "cd" * 32, "ef" * 32)

    def program_step(self, step, values=None, *extra):
        """setup.py --program-step: only the operator's or the confirmer's token; returns the JSON line it printed."""
        vk, root, rules = values or self.NEW_PROGRAM
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = setup.main(["--ledger-url", self.node.url, "--program-step", step, "--program-vk", vk, "--root-c", root, "--rules-hash", rules, *extra])
        self.assertEqual(code, 0)
        return json.loads(out.getvalue())

    def chain_program(self):
        args = self.node.contracts["ZkChain"][0]["args"]
        return (args["programVK"], args["rootC"], args["rulesHash"])

    def test_a_proposed_program_is_accepted_and_changed_back(self):
        self.run_setup()
        old = self.chain_program()
        before = len(self.sent())
        proposed = self.program_step("propose")
        self.assertEqual((proposed["submitted"], proposed["alreadyProposed"]), (True, False))
        [(command, acts)] = self.sent()[before:]
        self.assertEqual(sorted(acts), ["ostia-gateway::1220fp", "ostia-operator::1220fp"])   # the operator's user acts for the operator and the gateway
        self.assertEqual(command["ExerciseCommand"]["choice"], "ProposeProgram")
        self.assertEqual(self.node.contracts["ProgramProposal"][0]["args"]["gateway"], "ostia-gateway::1220fp")
        self.assertEqual({k: v for k, v in command["ExerciseCommand"]["choiceArgument"].items() if k.startswith("new")},
                         {"newProgramVK": "ab" * 32, "newRootC": "cd" * 32, "newRulesHash": "ef" * 32})
        self.assertEqual(self.chain_program(), old)   # the proposal alone changes nothing
        self.assertFalse(self.program_step("propose")["submitted"])   # the same proposal again: nothing is sent
        self.assertEqual(len(self.node.contracts["ProgramProposal"]), 1)
        accepted = self.program_step("accept")
        self.assertTrue(accepted["submitted"])
        self.assertEqual(self.sent()[-1][1], ["ostia-confirmer::1220fp"])
        self.assertEqual(self.sent()[-1][0]["ExerciseCommand"]["choice"], "AcceptProgram")
        self.assertEqual(self.sent()[-1][0]["ExerciseCommand"]["choiceArgument"], {"chain": "c1"})
        self.assertEqual(self.chain_program(), self.NEW_PROGRAM)
        self.assertEqual(self.node.contracts["ProgramProposal"], [])
        again = self.program_step("accept")   # a re-run after it went through
        self.assertEqual((again["submitted"], again["alreadyAccepted"]), (False, True))
        # The rollback is the same two steps with the old values.
        self.program_step("propose", old)
        self.program_step("accept", old)
        self.assertEqual(self.chain_program(), old)

    def test_a_program_dry_run_submits_nothing(self):
        self.run_setup()
        before = len(self.sent())
        dry = self.program_step("propose", None, "--dry-run")
        self.assertEqual((dry["dryRun"], dry["submitted"]), (True, False))
        self.assertEqual(self.node.contracts["ProgramProposal"], [])
        self.program_step("propose")
        before = len(self.sent())
        dry = self.program_step("accept", None, "--dry-run")
        self.assertEqual((dry["dryRun"], dry["submitted"], dry["new"]["programVK"]), (True, False, "ab" * 32))
        self.assertEqual(len(self.sent()), before)
        self.assertEqual(len(self.node.contracts["ProgramProposal"]), 1)

    def test_a_program_step_refuses_what_the_daml_would_and_a_wrong_proposal(self):
        self.run_setup()
        with self.assertRaises(SystemExit) as ctx:
            self.program_step("propose", self.chain_program())
        self.assertIn("holds these values already", str(ctx.exception))
        with self.assertRaises(SystemExit) as ctx:
            self.program_step("accept")   # no proposal
        self.assertIn("no proposal", str(ctx.exception))
        self.program_step("propose")
        with self.assertRaises(SystemExit) as ctx:
            self.program_step("propose", ("11" * 32, "cd" * 32, "ef" * 32))   # another proposal is there
        self.assertIn("Withdraw", str(ctx.exception))
        with self.assertRaises(SystemExit) as ctx:
            self.program_step("accept", ("11" * 32, "cd" * 32, "ef" * 32))   # accept takes exactly the values given
        self.assertIn("no proposal", str(ctx.exception))
        self.assertEqual(len(self.node.contracts["ProgramProposal"]), 1)

    def test_a_program_value_must_be_64_lowercase_hex_digits(self):
        self.run_setup()
        before = len(self.sent())
        for bad in ("AB" * 32, "ab" * 31, "0x" + "ab" * 32, "zz" * 32, ""):
            for position in range(3):
                values = [*self.NEW_PROGRAM]
                values[position] = bad
                with self.subTest(bad=bad, position=position), self.assertRaises(SystemExit):
                    self.program_step("propose", tuple(values))
        self.assertEqual(len(self.sent()), before)

    def test_each_program_step_needs_only_its_own_token(self):
        self.run_setup()
        self.node.calls.clear()
        os.environ.pop("CZE_TOKEN_FILE_ADMIN"); os.environ.pop("CZE_TOKEN_FILE_CONFIRMER")
        self.program_step("propose")
        self.assertEqual({c[2] for c in self.node.calls}, {"Bearer tok-operator-2"})
        os.environ["CZE_TOKEN_FILE_CONFIRMER"] = str(self.tokens["confirmer"]); os.environ.pop("CZE_TOKEN_FILE_OPERATOR")
        self.node.calls.clear()
        self.program_step("accept")
        self.assertEqual({c[2] for c in self.node.calls}, {"Bearer tok-confirmer-3"})

    def test_a_program_step_refuses_the_other_modes_and_a_missing_value(self):
        keys = ["--program-vk", "ab" * 32, "--root-c", "cd" * 32, "--rules-hash", "ef" * 32]
        for extra in (["--demo"], ["--package-step", "check"], ["--gas-cap-step", "propose"], ["--", *CHAIN_ARGS]):
            with self.subTest(extra=extra), self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                setup.main(["--ledger-url", self.node.url, "--program-step", "propose", *keys, *extra])
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            setup.main(["--ledger-url", self.node.url, "--program-step", "propose", "--program-vk", "ab" * 32])
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            setup.main(["--ledger-url", self.node.url, "--dar", str(self.dar), *keys])   # the keys go with --program-step
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            setup.main(["--ledger-url", self.node.url, "--gas-cap-step", "propose", "--new-gas-cap", "5", *keys])

    def delay_step(self, step, seconds, *extra):
        """setup.py --change-delay-step: only the operator's or the confirmer's token; returns the JSON line it printed."""
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = setup.main(["--ledger-url", self.node.url, "--change-delay-step", step, "--delay-seconds", str(seconds), *extra])
        self.assertEqual(code, 0)
        return json.loads(out.getvalue())

    def set_chain_delay(self, seconds):
        self.node.contracts["ZkChain"][0]["args"]["changeDelay"] = {"microseconds": str(seconds * 1_000_000)}

    def age(self, template, seconds):
        """Moves the proposal's ledger time back, as time passing would."""
        args = self.node.contracts[template][0]["args"]
        then = setup.parse_time(args["proposedAt"]) - timedelta(seconds=seconds)
        args["proposedAt"] = setup.show_time(then)

    def test_a_chain_without_a_delay_accepts_at_once_and_the_steps_print_the_wait(self):
        self.run_setup()
        proposed = self.raise_step("propose", 50_000_000)
        self.assertEqual(proposed["changeDelaySeconds"], 0)
        self.assertEqual(proposed["acceptableAt"], proposed["proposedAt"])   # no delay: it may be accepted from the moment it was made
        # the proposal carries no time of the proposer's: the choice takes the cap alone, the ledger stamps the time
        self.assertEqual(self.sent()[-1][0]["ExerciseCommand"]["choiceArgument"], {"newCap": "50000000"})
        dry = self.raise_step("accept", 50_000_000, "--dry-run")
        self.assertEqual((dry["changeDelaySeconds"], dry["acceptableAt"]), (0, proposed["proposedAt"]))
        self.assertTrue(self.raise_step("accept", 50_000_000)["submitted"])
        self.assertEqual(self.program_step("propose")["changeDelaySeconds"], 0)
        self.assertTrue(self.program_step("accept")["submitted"])

    def test_a_gas_cap_accept_waits_out_the_delay(self):
        self.run_setup()
        self.set_chain_delay(3600)
        proposed = self.raise_step("propose", 50_000_000)
        self.assertEqual(proposed["changeDelaySeconds"], 3600)
        self.assertEqual(setup.parse_time(proposed["acceptableAt"]) - setup.parse_time(proposed["proposedAt"]), timedelta(hours=1))
        before = len(self.sent())
        dry = self.raise_step("accept", 50_000_000, "--dry-run")   # a dry run says when, and sends nothing
        self.assertEqual((dry["submitted"], dry["acceptableAt"]), (False, proposed["acceptableAt"]))
        with self.assertRaises(SystemExit) as ctx:
            self.raise_step("accept", 50_000_000)
        self.assertIn("may be accepted from " + proposed["acceptableAt"], str(ctx.exception))
        self.assertEqual(len(self.sent()), before)   # refused before anything was sent
        with mock.patch.object(setup, "check_waited"), self.assertRaises(SystemExit) as ctx:   # and if it were sent, the chain refuses it
            self.raise_step("accept", 50_000_000)
        self.assertIn("the accept was refused: HTTP 400", str(ctx.exception))
        self.assertEqual(self.node.contracts["ZkChain"][0]["args"]["gasCap"], "30000000")
        self.age("GasCapProposal", 3601)
        self.assertTrue(self.raise_step("accept", 50_000_000)["submitted"])
        self.assertEqual(self.node.contracts["ZkChain"][0]["args"]["gasCap"], "50000000")

    def test_a_program_accept_waits_out_the_delay(self):
        self.run_setup()
        self.set_chain_delay(60)
        old = self.chain_program()
        proposed = self.program_step("propose")
        self.assertEqual(proposed["changeDelaySeconds"], 60)
        self.assertEqual(setup.parse_time(proposed["acceptableAt"]) - setup.parse_time(proposed["proposedAt"]), timedelta(seconds=60))
        self.assertEqual(self.program_step("propose")["acceptableAt"], proposed["acceptableAt"])   # the same proposal again prints the same time
        dry = self.program_step("accept", None, "--dry-run")
        self.assertEqual((dry["submitted"], dry["acceptableAt"]), (False, proposed["acceptableAt"]))
        with self.assertRaises(SystemExit) as ctx:
            self.program_step("accept")
        self.assertIn("may be accepted from " + proposed["acceptableAt"], str(ctx.exception))
        with mock.patch.object(setup, "check_waited"), self.assertRaises(SystemExit) as ctx:
            self.program_step("accept")
        self.assertIn("the accept was refused: HTTP 400", str(ctx.exception))
        self.assertEqual(self.chain_program(), old)
        self.age("ProgramProposal", 61)
        self.assertTrue(self.program_step("accept")["submitted"])
        self.assertEqual(self.chain_program(), self.NEW_PROGRAM)

    def test_the_delay_is_changed_by_a_proposal_that_waits_out_the_current_delay(self):
        self.run_setup()
        before = len(self.sent())
        dry = self.delay_step("propose", 30, "--dry-run")
        self.assertEqual((dry["dryRun"], dry["submitted"], dry["newChangeDelaySeconds"]), (True, False, 30))
        self.assertEqual((self.node.contracts["ChangeDelayProposal"], len(self.sent())), ([], before))
        proposed = self.delay_step("propose", 30)   # no delay yet: the first change is at once
        self.assertEqual((proposed["submitted"], proposed["alreadyProposed"], proposed["changeDelaySeconds"]), (True, False, 0))
        [(command, acts)] = self.sent()[before:]
        self.assertEqual(sorted(acts), ["ostia-gateway::1220fp", "ostia-operator::1220fp"])   # the operator's user acts for the operator and the gateway
        self.assertEqual((command["ExerciseCommand"]["choice"], command["ExerciseCommand"]["choiceArgument"]), ("ProposeChangeDelay", {"newDelay": {"microseconds": "30000000"}}))
        again = self.delay_step("propose", 30)
        self.assertEqual((again["submitted"], again["alreadyProposed"]), (False, True))
        self.assertEqual(len(self.node.contracts["ChangeDelayProposal"]), 1)
        accepted = self.delay_step("accept", 30)
        self.assertTrue(accepted["submitted"])
        self.assertEqual(self.sent()[-1][1], ["ostia-confirmer::1220fp"])
        self.assertEqual(self.sent()[-1][0]["ExerciseCommand"]["choice"], "AcceptChangeDelay")
        self.assertEqual(self.node.contracts["ZkChain"][0]["args"]["changeDelay"], {"microseconds": "30000000"})
        self.assertEqual(self.node.contracts["ChangeDelayProposal"], [])
        done = self.delay_step("accept", 30)   # a re-run after it went through
        self.assertEqual((done["submitted"], done["alreadyAccepted"], done["changeDelaySeconds"]), (False, True, 30))
        with self.assertRaises(SystemExit) as ctx:
            self.delay_step("propose", 30)
        self.assertIn("already", str(ctx.exception))
        # The delay is now 30 s: taking it away is itself subject to it, so it cannot be cut short.
        proposed = self.delay_step("propose", 0)
        self.assertEqual(proposed["changeDelaySeconds"], 30)
        self.assertEqual(setup.parse_time(proposed["acceptableAt"]) - setup.parse_time(proposed["proposedAt"]), timedelta(seconds=30))
        self.assertEqual(self.sent()[-1][0]["ExerciseCommand"]["choiceArgument"], {"newDelay": None})
        with self.assertRaises(SystemExit) as ctx:
            self.delay_step("accept", 0)
        self.assertIn("may be accepted from " + proposed["acceptableAt"], str(ctx.exception))
        with mock.patch.object(setup, "check_waited"), self.assertRaises(SystemExit) as ctx:
            self.delay_step("accept", 0)
        self.assertIn("the accept was refused: HTTP 400", str(ctx.exception))
        self.assertEqual(self.node.contracts["ZkChain"][0]["args"]["changeDelay"], {"microseconds": "30000000"})
        self.age("ChangeDelayProposal", 31)
        self.assertTrue(self.delay_step("accept", 0)["submitted"])
        self.assertIsNone(self.node.contracts["ZkChain"][0]["args"]["changeDelay"])   # None: no delay, as a chain starts

    def test_a_change_delay_step_refuses_a_bad_value_another_proposal_and_missing_arguments(self):
        self.run_setup()
        before = len(self.sent())
        for bad in (-1, setup.MAX_CHANGE_DELAY + 1):
            with self.subTest(bad=bad), self.assertRaises(SystemExit) as ctx:
                self.delay_step("propose", bad)
            self.assertIn("between 0 and", str(ctx.exception))
        self.delay_step("propose", setup.MAX_CHANGE_DELAY)   # the highest is fine
        with self.assertRaises(SystemExit) as ctx:
            self.delay_step("propose", 20)
        self.assertIn("another change delay", str(ctx.exception))
        self.assertIn("Withdraw", str(ctx.exception))
        with self.assertRaises(SystemExit) as ctx:
            self.delay_step("accept", 20)   # nobody proposed 20
        self.assertIn("no proposal", str(ctx.exception))
        self.assertEqual(len(self.sent()), before + 1)
        for extra in (["--demo"], ["--package-step", "check"], ["--new-gas-cap", "5"], ["--program-vk", "ab" * 32], ["--", *CHAIN_ARGS]):
            with self.subTest(extra=extra), self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                setup.main(["--ledger-url", self.node.url, "--change-delay-step", "propose", "--delay-seconds", "5", *extra])
        for argv in (["--change-delay-step", "propose"], ["--delay-seconds", "5"], ["--change-delay-step", "propose", "--delay-seconds", "5", "--gas-cap-step", "propose", "--new-gas-cap", "9"]):
            with self.subTest(argv=argv), self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                setup.main(["--ledger-url", self.node.url, *argv])

    def test_each_change_delay_step_needs_only_its_own_token(self):
        self.run_setup()
        self.node.calls.clear()
        os.environ.pop("CZE_TOKEN_FILE_ADMIN"); os.environ.pop("CZE_TOKEN_FILE_CONFIRMER")
        self.delay_step("propose", 30)
        self.assertEqual({c[2] for c in self.node.calls}, {"Bearer tok-operator-2"})
        os.environ["CZE_TOKEN_FILE_CONFIRMER"] = str(self.tokens["confirmer"]); os.environ.pop("CZE_TOKEN_FILE_OPERATOR")
        self.node.calls.clear()
        self.delay_step("accept", 30)
        self.assertEqual({c[2] for c in self.node.calls}, {"Bearer tok-confirmer-3"})

    def test_a_chain_whose_cap_is_below_the_pinned_one_is_refused_and_one_above_it_is_found(self):
        self.run_setup()
        self.node.contracts["ZkChain"][0]["args"]["gasCap"] = "29999999"
        with self.assertRaises(SystemExit) as ctx:
            self.run_setup()
        self.assertIn("gasCap", str(ctx.exception))
        self.node.contracts["ZkChain"][0]["args"]["gasCap"] = "90000000"
        _, out, _ = self.run_setup()
        self.assertFalse(json.loads(out)["created"])

    def test_a_chain_with_another_program_is_refused_at_any_block(self):
        self.run_setup()
        self.node.contracts["ZkChain"][0]["args"].update({"headNumber": "3", "programVK": "00" * 32})
        with self.assertRaises(SystemExit) as ctx:
            self.run_setup()
        self.assertIn("programVK", str(ctx.exception))

    def test_a_party_hosted_elsewhere_with_the_same_hint_is_not_ours(self):
        self.node.remote = [f"ostia-{n}::1220other" for n in setup.CHAIN_PARTIES]
        self.run_setup(chain=False)
        self.assertEqual(sorted(self.node.parties), sorted(f"ostia-{n}::1220fp" for n in setup.CHAIN_PARTIES))
        env = propose.read_env_file(self.state / "canton" / "parties.env")
        self.assertTrue(all(v.endswith("::1220fp") for v in env.values()))
        for user, rights in self.node.users.items():
            self.assertFalse(any("1220other" in json.dumps(r) for r in rights["rights"]), user)

    def test_a_second_run_looks_each_party_up_by_id_and_never_lists_the_parties(self):
        self.node.remote = [f"someone-{i}::1220other" for i in range(7)]
        self.run_setup()
        self.node.calls.clear()
        _, out, _ = self.run_setup()
        self.assertEqual(self.node.mutations(), [])
        self.assertFalse(json.loads(out)["created"])
        self.assertEqual(len(self.node.parties), len(setup.CHAIN_PARTIES))
        gets = sorted(c[1] for c in self.node.calls if c[0] == "GET" and c[1].startswith("/v2/parties") and c[1] != "/v2/parties/participant-id")
        self.assertEqual(gets, sorted(f"/v2/parties/ostia-{n}%3A%3A1220fp" for n in setup.CHAIN_PARTIES))
        self.assertFalse([c for c in self.node.calls if c[1].split("?")[0] == "/v2/parties"])

    def test_an_unknown_party_answered_with_404_is_allocated_too(self):
        self.node.unknown_is_404 = True
        self.run_setup(chain=False)
        self.assertEqual(len(self.node.parties), len(setup.CHAIN_PARTIES))

    def test_a_party_that_the_participant_knows_but_does_not_host_is_allocated(self):
        self.node.remote = [f"ostia-{n}::1220fp" for n in setup.CHAIN_PARTIES]
        self.run_setup(chain=False)
        self.assertEqual(sorted(self.node.parties), sorted(f"ostia-{n}::1220fp" for n in setup.CHAIN_PARTIES))

    def test_an_allocation_that_gives_another_id_is_used_as_it_came(self):
        route = self.node.route
        self.node.route = lambda m, p, b, r: ({"partyDetails": {"party": self.node.parties.append(b["partyIdHint"] + "::1220odd") or self.node.parties[-1]}}
                                              if (m, p) == ("POST", "/v2/parties") else route(m, p, b, r))
        _, _, err = self.run_setup(chain=False)
        env = propose.read_env_file(self.state / "canton" / "parties.env")
        self.assertTrue(all(v.endswith("::1220odd") for v in env.values()))
        self.assertIn("not the one expected", err)

    def test_a_package_that_is_not_vetted_stops_everything(self):
        self.node.vetting = False
        with self.assertRaises(SystemExit) as ctx:
            self.run_setup()
        self.assertIn("not vetted", str(ctx.exception))
        self.assertEqual(self.node.parties, [])

    def test_a_package_vetted_by_another_participant_does_not_count(self):
        self.node.vetted_by = "PAR::someone-else::1220ff"
        with self.assertRaises(SystemExit) as ctx:
            self.run_setup()
        self.assertIn("not vetted", str(ctx.exception))
        self.assertEqual(self.node.parties, [])

    def test_a_participant_without_a_vetting_list_gives_a_warning_and_goes_on(self):
        self.node.vetting = None
        _, _, err = self.run_setup()
        self.assertIn("WARN", err)
        self.assertEqual(len(self.node.contracts["ZkChain"]), 1)

    def test_a_package_that_is_there_is_not_uploaded_again(self):
        self.node.packages = [PKG]
        self.run_setup(chain=False)
        self.assertNotIn(("POST", "/v2/packages", "Bearer tok-admin-1"), self.node.calls)

    def test_a_missing_ledger_url_is_an_error(self):
        with mock.patch.dict(os.environ), self.assertRaises(SystemExit):
            os.environ.pop("CZE_LEDGER_URL", None)
            with contextlib.redirect_stderr(io.StringIO()):
                setup.main([])

    def run_step(self, step, *extra):
        """setup.py --package-step: only the package, with the admin token alone; returns the JSON line it printed."""
        os.environ.pop("CZE_TOKEN_FILE_OPERATOR", None); os.environ.pop("CZE_TOKEN_FILE_CONFIRMER", None)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = setup.main(["--ledger-url", self.node.url, "--dar", str(self.dar), "--package-step", step, *extra])
        self.assertEqual(code, 0)
        return json.loads(out.getvalue())

    def test_the_default_upload_still_vets_and_sends_no_query(self):
        self.run_setup(chain=False)
        self.assertIn(("POST", "/v2/packages", "Bearer tok-admin-1"), self.node.calls)
        self.assertFalse([c for c in self.node.calls if "vetAllPackages" in c[1] or "validate" in c[1] or "vetting/update" in c[1]])

    def test_check_validates_the_dar_on_each_synchronizer_and_keeps_nothing(self):
        line = self.run_step("check")
        self.assertEqual(line, {"step": "check", "packageId": PKG, "valid": True})
        self.assertIn(("POST", "/v2/dars/validate?synchronizerId=global%3A%3A1220", "Bearer tok-admin-1"), self.node.calls)
        self.assertEqual(self.node.packages, [])
        self.assertEqual(self.node.mutations(), [])

    def test_check_stops_with_the_participants_reason_for_a_dar_it_refuses(self):
        self.node.invalid_dar = True
        with self.assertRaises(SystemExit) as ctx:
            self.run_step("check")
        self.assertIn("not a valid upgrade", str(ctx.exception))
        self.assertEqual(self.node.packages, [])

    def test_upload_without_vetting_asks_for_vetAllPackages_false_and_vets_nothing(self):
        line = self.run_step("upload")
        self.assertEqual(line, {"step": "upload", "packageId": PKG, "uploaded": True, "vetted": False})
        self.assertIn(("POST", "/v2/packages?vetAllPackages=false", "Bearer tok-admin-1"), self.node.calls)
        self.assertNotIn(("POST", "/v2/packages", "Bearer tok-admin-1"), self.node.calls)
        self.assertEqual(self.node.parties, [])
        self.assertEqual(self.node.updates, [])

    def test_upload_does_nothing_for_a_package_that_is_there(self):
        self.node.packages = [PKG]
        self.assertFalse(self.run_step("upload")["uploaded"])
        self.assertEqual(self.node.mutations(), [])

    def test_vet_with_a_dry_run_applies_nothing_and_without_it_vets_the_package_by_id(self):
        self.run_step("upload")
        line = self.run_step("vet", "--dry-run")
        self.assertEqual(line, {"step": "vet", "packageId": PKG, "dryRun": True, "synchronizers": {"global::1220": "dry-run"}})
        self.assertFalse(self.node.vetting)
        line = self.run_step("vet")
        self.assertEqual(line["synchronizers"], {"global::1220": "vetted"})
        self.assertTrue(self.node.vetting)
        self.assertEqual([u["dryRun"] for u in self.node.updates], [True, False])
        self.assertEqual(self.node.updates[1], {"changes": [{"operation": {"Vet": {"value": {"packages": [{"packageId": PKG}]}}}}],
                                                "dryRun": False, "synchronizerId": "global::1220"})

    def test_vet_does_nothing_where_the_package_is_vetted_already(self):
        self.node.packages = [PKG]
        self.assertEqual(self.run_step("vet")["synchronizers"], {"global::1220": "already"})
        self.assertEqual(self.node.updates, [])

    def test_vet_stops_for_a_package_that_is_not_uploaded(self):
        with self.assertRaises(SystemExit) as ctx:
            self.run_step("vet")
        self.assertIn("upload it first", str(ctx.exception))
        self.assertEqual(self.node.updates, [])

    def test_a_package_step_needs_only_the_admin_token_and_never_sends_another(self):
        self.run_step("upload")
        self.run_step("vet", "--dry-run")
        self.assertEqual({c[2] for c in self.node.calls}, {"Bearer tok-admin-1"})

    def test_a_package_step_refuses_the_chain_arguments_the_demo_and_a_stray_dry_run(self):
        for extra in (["--demo"], ["--", *CHAIN_ARGS]):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                setup.main(["--ledger-url", self.node.url, "--dar", str(self.dar), "--package-step", "check", *extra])
        for argv in (["--dry-run"], ["--package-step", "upload", "--dry-run"]):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                setup.main(["--ledger-url", self.node.url, "--dar", str(self.dar), *argv])
        self.assertEqual(self.node.calls, [])

    def test_a_package_step_still_refuses_an_admin_token_that_others_can_read(self):
        self.tokens["admin"].chmod(0o644)
        with self.assertRaises(SystemExit):
            self.run_step("check")
        self.assertEqual(self.node.calls, [])

    def test_a_package_step_without_the_admin_token_file_stops_before_any_call(self):
        os.environ.pop("CZE_TOKEN_FILE_ADMIN")
        with self.assertRaises(SystemExit) as ctx:
            self.run_step("check")
        self.assertIn("CZE_TOKEN_FILE_ADMIN", str(ctx.exception))
        self.assertEqual(self.node.calls, [])

    def test_vet_vets_the_dependencies_the_dar_brings_with_the_main_package_in_one_change(self):
        # A new dependency (not vetted yet): the participant refuses the main package alone, so the change carries both.
        self.node.packages, self.node.dep, self.node.dep_vetted, self.dar_packages = [PKG, DEP], DEP, False, [PKG, DEP]
        self.node.vetting = False
        self.run_step("vet", "--dry-run")
        self.assertFalse(self.node.vetting or self.node.dep_vetted)
        self.run_step("vet")
        self.assertEqual([[p["packageId"] for p in u["changes"][0]["operation"]["Vet"]["value"]["packages"]] for u in self.node.updates], [[PKG, DEP], [PKG, DEP]])
        self.assertTrue(self.node.vetting and self.node.dep_vetted)
        self.assertEqual(self.run_step("vet")["synchronizers"], {"global::1220": "already"})

    def test_vet_leaves_out_a_dependency_that_is_vetted_already(self):
        self.node.packages, self.node.dep, self.node.dep_vetted, self.dar_packages = [PKG, DEP], DEP, True, [PKG, DEP]
        self.node.vetting = False
        self.run_step("vet")
        self.assertEqual([p["packageId"] for p in self.node.updates[0]["changes"][0]["operation"]["Vet"]["value"]["packages"]], [PKG])

    def test_upload_stops_when_the_participant_lists_the_package_vetted_after_vetAllPackages_false(self):
        self.node.ignores_query = True
        with self.assertRaises(SystemExit) as ctx:
            self.run_step("upload")
        self.assertIn(PKG, str(ctx.exception))
        self.assertIn("global::1220", str(ctx.exception))
        self.assertIn("ignores", str(ctx.exception))

    def test_the_dar_package_ids_are_the_main_package_then_every_dalf_of_the_dar(self):
        dar = Path(self.tmp.name) / "real.dar"
        with zipfile.ZipFile(dar, "w") as z:
            for name in (f"ostia-0.2.0-{PKG}/ostia-0.2.0-{PKG}.dalf", f"daml-prim-{DEP}/daml-prim-{DEP}.dalf", "META-INF/MANIFEST.MF", "data/readme.txt"):
                z.writestr(name, "x")
        self.assertEqual(REAL_DAR_PACKAGE_IDS(dar), [PKG, DEP])

    def test_the_upgrade_in_order_check_upload_vet(self):
        # A 0.1.0 package is there and vetted; the DAR is the next version (another id): check, upload (not vetted), dry run, vet.
        self.node.packages = ["01" * 32]
        for step, extra in (("check", ()), ("upload", ()), ("vet", ("--dry-run",)), ("vet", ())):
            self.run_step(step, *extra)
        self.assertEqual(self.node.packages, ["01" * 32, PKG])
        self.assertTrue(self.node.vetting)


if __name__ == "__main__":
    unittest.main()
