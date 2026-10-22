"""network/external/setup.py against a fake participant (a stateful JSON Ledger API). Run: python3 -m unittest discover -s tests -p 'test_external_setup.py'"""
import contextlib, io, json, os, re, sys, tempfile, threading, unittest, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "network" / "canton"))
sys.path.insert(0, str(ROOT / "network" / "external"))
import propose, setup

PKG = "ab" * 32
H = "ab" * 32
CHAIN_ARGS = ["--genesis-hash", H, "--genesis-state-root", "55" * 32, "--program-vk", "cd" * 32, "--root-c", "ef" * 32, "--rules-hash", "12" * 32]
FAKE_TOKENS = {"admin": "tok-admin-1", "operator": "tok-operator-2", "confirmer": "tok-confirmer-3"}


class FakeParticipant:
    """What setup.py touches: packages, parties, users and their rights, the chain's two templates. `calls` lists (method, path, authorization)."""
    def __init__(self, packages=(), vetting=True):
        self.packages, self.vetting, self.parties, self.users, self.contracts, self.calls = list(packages), vetting, [], {}, {"ZkChain": [], "ChainProposal": []}, []
        self.remote, self.vetted_by = [], "PAR::ostia-test::1220fp"   # parties hosted elsewhere; who vetted the package
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
                answer = node.route(method, self.path, body, raw)
                self.send(*answer) if isinstance(answer, tuple) else self.send(answer)

            def do_GET(self): self.handle_any("GET")
            def do_POST(self): self.handle_any("POST")

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown(); self.server.server_close()

    def mutations(self):
        return [c for c in self.calls if c[0] == "POST" and c[1] not in ("/v2/state/active-contracts", "/v2/package-vetting/list")]

    def route(self, method, path, body, raw):
        if (method, path) == ("GET", "/v2/packages"):
            return {"packageIds": self.packages}
        if (method, path) == ("POST", "/v2/packages"):
            self.packages.append(PKG)
            return {}
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
            return {"vettedPackages": [{"participantId": self.vetted_by, "synchronizerId": "global::1220", "packages": [{"packageId": PKG}] if self.vetting else []}]}
        m = re.fullmatch(r"/v2/parties/([^/?]+)", path)
        if method == "GET" and m:
            # One party by id (url-encoded): the participant knows the remote ones too, with isLocal false; a party it does not know is a 404.
            party = urllib.parse.unquote(m[1])
            if party in self.parties or party in self.remote:
                return {"partyDetails": [{"party": party, "isLocal": party in self.parties}]}
            return {}, 404
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
            if "CreateCommand" in command:
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


if __name__ == "__main__":
    unittest.main()
