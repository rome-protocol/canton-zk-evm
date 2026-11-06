"""The accounts service against a fake JSON Ledger API. Run: python3 -m unittest discover -s apps/accounts/tests -v (pytest collects them too)."""
import base64, hashlib, http.client, ipaddress, json, os, sys, tempfile, threading, time, unittest, unittest.mock, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import accounts as A
from test_ed25519 import public_key, sign

SEED, OTHER_SEED = bytes(range(32)), bytes(range(1, 33))
KEY, OTHER_KEY = (base64.b64encode(public_key(seed)).decode() for seed in (SEED, OTHER_SEED))
SIG = base64.b64encode(bytes(64)).decode()
DAY = 86400
FINGERPRINT = "1220" + "ab" * 32
PARTY = "bridge::" + FINGERPRINT
SYNC = "da::1220" + "cd" * 32
ACCEPT, DEPOSIT = A.ACCEPTANCE, A.DEPOSIT
CHAIN = {f: f + "::1220" + "0%d" % i * 32 for i, f in enumerate(A.CHAIN_FIELDS, 1)}
HOLDER = "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding"


class FakeLedger:
    """Answers the endpoints the service uses, records every call, and can be told to refuse."""
    def __init__(self):
        self.calls, self.fail, self.holdings, self.tokens, self.open, self.cost, self.prepared = [], {}, [], [], {}, 1000, 0
        self.rights = []   # the parties the service's user can act as
        self.commits = None   # a template: each executeAndWait makes one open contract of it (after a pause, as a real commit takes time)
        fake = self

        class H(BaseHTTPRequestHandler):
            def serve(self):
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n)) if n else None
                fake.calls.append((self.command, self.path, body))
                fake.tokens.append(self.headers.get("authorization"))
                status, out = fake.answer(self.command, self.path, body)
                data = json.dumps(out).encode()
                self.send_response(status); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

            do_GET = do_POST = serve
            def log_message(self, *a): pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def answer(self, method, path, body):
        if path in self.fail:
            return self.fail[path]
        if path == "/v2/version":
            return 200, {"version": "3.7.1"}
        if path == "/v2/state/connected-synchronizers":
            return 200, {"connectedSynchronizers": [{"synchronizerAlias": "da", "synchronizerId": SYNC}]}
        if path.endswith("/generate-topology"):
            return 200, {"partyId": PARTY, "publicKeyFingerprint": FINGERPRINT, "topologyTransactions": ["t1", "t2"], "multiHash": "bXVsdGk="}
        if path.endswith("/external/allocate"):
            self.rights.append(PARTY)
            return 200, {"partyId": PARTY}
        if path == "/v2/users/svc/rights":
            return 200, {"rights": [{"kind": {"CanReadAs": {"value": {"party": "reader::1220" + "11" * 32}}}}] + [{"kind": {"CanActAs": {"value": {"party": p}}}} for p in self.rights]}
        if path.endswith("/prepare"):
            self.prepared += 1
            return 200, {"preparedTransaction": base64.b64encode(b"prepared%d" % self.prepared).decode(), "preparedTransactionHash": "aGFzaA==", "hashingSchemeVersion": "HASHING_SCHEME_VERSION_V2",
                         "costEstimation": {"totalTrafficCostEstimation": self.cost}}
        if path.endswith("/executeAndWait"):
            if self.commits:
                time.sleep(0.05)
                self.open[self.commits] = self.open.get(self.commits, 0) + 1
            return 200, {"updateId": "u-1", "completionOffset": 5}
        if path.endswith("/active-contracts-page") and "TemplateFilter" in json.dumps(body):   # the account's own contracts of one template
            template = json.dumps(body).split('"templateId": "')[1].split('"')[0]
            return 200, {"activeAtOffset": 9, "activeContracts": [{}] * min(self.open.get(template, 0), body["maxPageSize"])}
        if path.endswith("/active-contracts-page"):
            pages = self.holdings
            at = int(body["pageToken"]) if body.get("pageToken") else 0
            page = pages[at] if at < len(pages) else []
            owners = {entry[0]: entry[2] for entry in page if len(entry) > 2}
            out = {"activeAtOffset": 9, "activeContracts": [{"contractEntry": {"JsActiveContract": {"createdEvent": {
                "contractId": cid, "interfaceViews": [{"interfaceId": "pkg:HoldingV1:Holding", "viewValue": {
                    "owner": owners.get(cid, PARTY), "instrumentId": {"admin": "reg::1", "id": "TKB"}, "amount": amount, "lock": None, "meta": {"values": {}}}}]}}}} for cid, amount, *_ in page]}
            if at + 1 < len(pages):
                out["nextPageToken"] = str(at + 1)
            return 200, out
        return 404, {}


class Case(unittest.TestCase):
    def setUp(self):
        self.ledger = FakeLedger()
        self.dir = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.dir.name, "accounts.jsonl")
        self.used, self.sig_lock = set(), threading.Lock()
        self.start()

    def start(self, **kw):
        if getattr(self, "http", None):
            self.http.shutdown()
        kw.setdefault("allow", A.DEFAULT_ALLOW)
        kw.setdefault("chain", CHAIN)
        kw.setdefault("rights_gap", 0)
        self.service = A.Accounts(A.Ledger(self.ledger.url, token="tok"), "svc", A.Parties(self.state), **kw)
        self.http = A.make_server(self.service, "127.0.0.1", 0)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.http.server_address[1]}"

    def tearDown(self):
        self.http.shutdown(); self.ledger.server.shutdown(); self.dir.cleanup()

    def account_signature(self, method, path, data, seed=SEED, at=None):
        """The X-Account-Signature value, built as the README says; a fresh second for each request that is the same as an earlier one."""
        if at is None:
            with self.sig_lock:   # requests made together do not pick the same second
                now = int(time.time())
                at = next(t for t in range(now, now - 50, -1) if (method, path, data, t) not in self.used)
                self.used.add((method, path, data, at))
        message = f"accounts-v1\n{method}\n{path}\n{hashlib.sha256(data).hexdigest()}\n{at}".encode()
        return f"{at}.{base64.b64encode(sign(seed, message)).decode()}"

    def req(self, method, path, body=None, headers=None, raw=None, signed=True, seed=SEED, at=None):
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        headers = dict(headers or {})
        if signed and (path in ("/accounts/v1/prepare", "/accounts/v1/execute") or path.startswith("/accounts/v1/holdings/")) and "X-Account-Signature" not in headers:
            headers["X-Account-Signature"] = self.account_signature(method, path, data or b"", seed, at)
        r = urllib.request.Request(self.base + path, data, headers, method=method)
        try:
            with urllib.request.urlopen(r) as f:
                return f.status, json.load(f), f.headers
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.load(e), e.headers

    def make_account(self, key=KEY, seed=SEED):
        _, t, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": key})
        return self.req("POST", "/accounts/v1/allocate", {"blob": t["blob"], "signature": self.sig(t["multiHash"], seed)})

    @staticmethod
    def sig(message_b64, seed=SEED):
        return base64.b64encode(sign(seed, base64.b64decode(message_b64))).decode()

    def execute_body(self, prepared, seed=SEED):
        return {"preparedTransaction": prepared["preparedTransaction"], "partySignatures": [{"party": PARTY, "signature": self.sig(prepared["preparedTransactionHash"], seed)}]}

    def calls_to(self, suffix):
        return [c for c in self.ledger.calls if c[1].endswith(suffix)]


class TopologyAndAllocate(Case):
    def test_topology_wraps_a_raw_key_and_names_the_synchronizer(self):
        status, out, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        self.assertEqual((status, out["party"], out["exists"], out["multiHash"]), (200, PARTY, False, "bXVsdGk="))
        sent = self.calls_to("/generate-topology")[0][2]
        self.assertEqual(sent["synchronizer"], SYNC)
        self.assertEqual(sent["partyHint"], "bridge")
        self.assertEqual(base64.b64decode(sent["publicKey"]["keyData"]), A.SPKI_ED25519 + public_key(SEED))
        self.assertEqual(sent["publicKey"]["keySpec"], "SIGNING_KEY_SPEC_EC_CURVE25519")
        self.assertNotIn("protocolVersion", sent)
        self.assertEqual(set(self.ledger.tokens), {"Bearer tok"})

    def test_the_protocol_version_is_passed_through_when_set(self):
        self.start(topology_version=36)
        self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        self.assertEqual(self.calls_to("/generate-topology")[0][2]["protocolVersion"], 36)

    def test_bad_keys_and_hints_are_refused(self):
        for body in ({}, {"publicKey": "not base64!"}, {"publicKey": base64.b64encode(b"short").decode()},
                     {"publicKey": base64.b64encode(bytes(44)).decode()}, {"publicKey": KEY, "partyHint": "other"}):
            self.assertEqual(self.req("POST", "/accounts/v1/topology", body)[0], 400, body)
        self.assertEqual(self.calls_to("/generate-topology"), [])

    def test_allocate_signs_the_multihash_and_gives_the_user_the_right_to_act(self):
        status, out, _ = self.make_account()
        self.assertEqual((status, out), (200, {"party": PARTY, "created": True}))
        sent = self.calls_to("/external/allocate")[0][2]
        self.assertEqual(sent["onboardingTransactions"], [{"transaction": "t1"}, {"transaction": "t2"}])
        self.assertEqual(sent["multiHashSignatures"], [{"format": A.SIGNATURE_FORMAT, "signature": self.sig("bXVsdGk="), "signedBy": FINGERPRINT,
                                                         "signingAlgorithmSpec": "SIGNING_ALGORITHM_SPEC_ED25519"}])
        self.assertEqual((sent["userId"], sent["synchronizer"]), ("svc", SYNC))
        self.assertEqual([c for c in self.calls_to("/rights") if c[0] == "POST"], [])   # no separate grant: the service's user has no admin right

    def test_allocate_is_idempotent_and_survives_a_restart(self):
        self.make_account()
        _, t, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        self.assertEqual((t["party"], t["exists"], "blob" in t), (PARTY, True, False))
        self.start()
        _, t, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        self.assertTrue(t["exists"])
        self.assertEqual(len(self.calls_to("/external/allocate")), 1)

    def test_a_blob_that_was_not_handed_out_or_a_bad_signature_is_refused(self):
        self.assertEqual(self.req("POST", "/accounts/v1/allocate", {"blob": "made-up", "signature": SIG})[0], 404)
        self.assertEqual(self.req("POST", "/accounts/v1/allocate", {"blob": "made-up", "signature": "AA=="})[0], 400)
        self.assertEqual(self.calls_to("/external/allocate"), [])

    def test_a_ledger_refusal_is_a_clear_error_and_leaves_no_account(self):
        _, t, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        self.ledger.fail["/v2/parties/external/allocate"] = (400, {"code": "INVALID_ARGUMENT", "cause": "the signature does not match"})
        status, out, _ = self.req("POST", "/accounts/v1/allocate", {"blob": t["blob"], "signature": self.sig(t["multiHash"])})
        self.assertEqual((status, out["code"], out["detail"]), (422, "INVALID_ARGUMENT", "the signature does not match"))
        self.assertNotIn(PARTY, self.service.parties)

    def test_an_unreachable_or_unauthorized_ledger_is_a_502_without_detail(self):
        self.ledger.fail["/v2/parties/external/generate-topology"] = (401, {"cause": "bad token secret"})
        status, out, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        self.assertEqual(status, 502)
        self.assertNotIn("secret", json.dumps(out))

    def test_accounts_per_day_are_limited_per_client(self):
        self.start(creates=A.Limiter(1, 86400))
        _, t1, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        self.ledger.fail["/v2/parties/external/generate-topology"] = (200, {"partyId": "bridge::1220" + "ef" * 32, "publicKeyFingerprint": "1220" + "ef" * 32,
                                                                           "topologyTransactions": ["t"], "multiHash": "bQ=="})
        _, t2, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": OTHER_KEY})
        self.assertEqual(self.req("POST", "/accounts/v1/allocate", {"blob": t1["blob"], "signature": self.sig(t1["multiHash"])})[0], 200)
        status, out, headers = self.req("POST", "/accounts/v1/allocate", {"blob": t2["blob"], "signature": self.sig(t2["multiHash"], OTHER_SEED)})
        self.assertEqual(status, 429)
        self.assertTrue(int(headers["retry-after"]) > 0)


class PrepareAndExecute(Case):
    def command(self, template=ACCEPT, kind="CreateCommand", **more):
        return {"party": PARTY, "commands": [{kind: {"templateId": template, "createArguments": {"party": PARTY, **CHAIN}, **more}}]}

    def test_an_allowed_create_is_prepared_for_the_party_alone(self):
        self.make_account()
        status, out, _ = self.req("POST", "/accounts/v1/prepare", self.command())
        self.assertEqual((status, out["preparedTransactionHash"], out["hashingSchemeVersion"]), (200, "aGFzaA==", "HASHING_SCHEME_VERSION_V2"))
        sent = self.calls_to("/prepare")[0][2]
        self.assertEqual((sent["actAs"], sent["userId"], sent["synchronizerId"]), ([PARTY], "svc", SYNC))
        self.assertEqual((sent["readAs"], sent["disclosedContracts"]), ([], []))

    def test_commands_off_the_list_are_refused(self):
        self.make_account()
        refused = [self.command("#canton-zk-evm:Zk.Chain:ZkChain"),
                   self.command("0" * 64 + ":Zk.Chain:WithdrawalAcceptance"),   # a package id is not a name on the list
                   self.command(ACCEPT, "ExerciseCommand", choice="Receive", contractId="c"),   # the template is on the list for a create, not for a choice
                   {"party": PARTY, "commands": [{"CreateAndExerciseCommand": {"templateId": ACCEPT}}]},
                   {"party": PARTY, "commands": [{"CreateCommand": {"templateId": ACCEPT}}, {"CreateCommand": {"templateId": ACCEPT}}]},
                   {"party": PARTY, "commands": []}]
        for body in refused:
            self.assertIn(self.req("POST", "/accounts/v1/prepare", body)[0], (400, 403), body)
        self.assertEqual(self.calls_to("/prepare"), [])

    def test_a_listed_choice_is_allowed(self):
        self.make_account()
        factory = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory"
        body = {"party": PARTY, "disclosedContracts": [{"contractId": "f"}], "commands": [{"ExerciseCommand": {
            "templateId": factory, "contractId": "f", "choice": "TransferFactory_Transfer", "choiceArgument": {}}}]}
        self.assertEqual(self.req("POST", "/accounts/v1/prepare", body)[0], 200)
        self.assertEqual(self.calls_to("/prepare")[0][2]["disclosedContracts"], [{"contractId": "f"}])
        body["commands"][0]["ExerciseCommand"]["choice"] = "TransferFactory_PublicFetch"
        self.assertEqual(self.req("POST", "/accounts/v1/prepare", body)[0], 403)

    def test_only_parties_this_service_made_are_served(self):
        for status in (self.req("POST", "/accounts/v1/prepare", self.command())[0], self.req("GET", f"/accounts/v1/holdings/{PARTY}")[0],
                       self.req("POST", "/accounts/v1/execute", {"preparedTransaction": "x", "partySignatures": [{"party": PARTY, "signature": SIG}]})[0]):
            self.assertEqual(status, 404)
        self.assertEqual({c[1] for c in self.ledger.calls}, {"/v2/users/svc/rights"})   # only the read of the user's rights, on each miss

    def test_execute_sends_the_signature_and_returns_the_update_id(self):
        self.make_account()
        _, p, _ = self.req("POST", "/accounts/v1/prepare", self.command())
        body = self.execute_body(p)
        status, out, _ = self.req("POST", "/accounts/v1/execute", body)
        self.assertEqual((status, out), (200, {"updateId": "u-1"}))
        sent = self.calls_to("/executeAndWait")[0][2]
        self.assertEqual(sent["hashingSchemeVersion"], "HASHING_SCHEME_VERSION_V2")
        self.assertEqual(sent["partySignatures"]["signatures"], [{"party": PARTY, "signatures": [{
            "format": A.SIGNATURE_FORMAT, "signature": body["partySignatures"][0]["signature"], "signedBy": FINGERPRINT,
            "signingAlgorithmSpec": "SIGNING_ALGORITHM_SPEC_ED25519"}]}])
        self.assertEqual(self.req("POST", "/accounts/v1/execute", body)[0], 404)   # once

    def test_a_transaction_this_service_did_not_prepare_is_not_executed(self):
        self.make_account()
        body = {"preparedTransaction": "b3RoZXI=", "partySignatures": [{"party": PARTY, "signature": SIG}]}
        self.assertEqual(self.req("POST", "/accounts/v1/execute", body)[0], 404)
        self.assertEqual(self.calls_to("/executeAndWait"), [])

    def test_a_prepared_transaction_expires(self):
        now = [0.0]
        self.start(prepared=A.Pending(ttl=10, clock=lambda: now[0]))
        self.make_account()
        _, p, _ = self.req("POST", "/accounts/v1/prepare", self.command())
        now[0] = 11
        self.assertEqual(self.req("POST", "/accounts/v1/execute", self.execute_body(p))[0], 404)


class Hardening(Case):
    """The limits that keep a hostile client from spending the participant's traffic or filling other parties' views."""
    def command(self, template=ACCEPT, **arguments):
        return {"party": PARTY, "commands": [{"CreateCommand": {"templateId": template, "createArguments": {"party": PARTY, **CHAIN, **arguments}}}]}

    def prepare(self, template=ACCEPT, **arguments):
        return self.req("POST", "/accounts/v1/prepare", self.command(template, **arguments))

    def send(self):
        """Prepare and execute one create; the status of the execute."""
        _, p, _ = self.prepare()
        return self.req("POST", "/accounts/v1/execute", self.execute_body(p))[0]

    # H1: creates name observers

    def test_a_create_that_names_other_parties_than_the_chains_is_refused(self):
        self.make_account()
        stranger = "stranger::1220" + "99" * 32
        for arguments in ({"operator": stranger}, {"gateway": PARTY}, {"extra": {"deep": [stranger]}}):
            self.assertEqual(self.prepare(**arguments)[0], 403, arguments)
        missing = self.command()
        del missing["commands"][0]["CreateCommand"]["createArguments"]["builder"]
        self.assertEqual(self.req("POST", "/accounts/v1/prepare", missing)[0], 403)
        self.assertEqual(self.calls_to("/prepare"), [])
        self.assertEqual(self.prepare()[0], 200)
        self.start(chain={})   # the chain's parties are not configured: the creates that name them are refused
        self.assertEqual(self.prepare()[0], 403)

    def test_any_other_allowed_create_is_checked_too(self):
        self.start(allow=[*A.DEFAULT_ALLOW, "#other:Mod:Thing"])
        self.make_account()
        thing = "#other:Mod:Thing"
        self.assertEqual(self.prepare(thing, observers=[PARTY, CHAIN["operator"]])[0], 200)
        self.assertEqual(self.prepare(thing, observers=["stranger::1220" + "99" * 32])[0], 403)
        self.assertEqual(self.prepare(thing, operator="stranger::1220" + "99" * 32)[0], 403)

    def test_one_withdrawal_acceptance_and_a_few_deposit_requests_per_account(self):
        self.make_account()
        self.ledger.open[ACCEPT] = 1
        self.assertEqual(self.prepare()[0], 409)
        self.assertEqual(self.calls_to("/prepare"), [])
        asked = self.calls_to("/active-contracts-page")[0][2]   # the account's own contracts, of that template
        self.assertEqual(list(asked["eventFormat"]["filtersByParty"]), [PARTY])
        self.assertEqual(asked["eventFormat"]["filtersByParty"][PARTY]["cumulative"][0]["identifierFilter"]["TemplateFilter"]["value"]["templateId"], ACCEPT)
        self.ledger.open[DEPOSIT] = 2
        self.assertEqual(self.prepare(DEPOSIT)[0], 200)
        self.service.prepared.items.clear()   # the one waiting for a signature does not count here
        self.ledger.open[DEPOSIT] = 3
        self.assertEqual(self.prepare(DEPOSIT)[0], 409)
        self.start(open_limits={DEPOSIT: 5})
        self.ledger.open[DEPOSIT] = 4
        self.assertEqual(self.prepare(DEPOSIT)[0], 200)

    def test_the_open_contracts_are_counted_again_when_the_transaction_is_sent(self):
        self.make_account()
        _, p, _ = self.prepare()
        self.ledger.open[ACCEPT] = 1   # another one was made after this was prepared
        self.assertEqual(self.req("POST", "/accounts/v1/execute", self.execute_body(p))[0], 409)
        self.assertEqual(self.calls_to("/executeAndWait"), [])

    # H2: traffic

    def test_executes_are_budgeted_per_account_per_client_and_overall(self):
        self.make_account()
        for name, limits in (("per_account", {"per_account": A.Limiter(2, DAY)}), ("per_client", {"per_client": A.Limiter(2, DAY)}), ("overall", {"overall": A.Limiter(2, DAY)})):
            self.start(**limits)
            self.ledger.calls.clear()
            self.assertEqual([self.send() for _ in range(3)], [200, 200, 429], name)
            self.assertEqual(len(self.calls_to("/executeAndWait")), 2, name)

    def test_a_breach_of_the_accounts_own_budget_draws_nothing_from_the_overall_one(self):
        self.start(per_account=A.Limiter(1, DAY))
        self.make_account()
        made = len(self.service.overall.hits["all"])   # the allocation counted once
        self.assertEqual([self.send() for _ in range(2)], [200, 429])   # the 429 keeps its entry, so a third prepare would wait for it
        self.assertEqual(len(self.service.overall.hits["all"]), made + 1)   # the one execute that was within the account's budget

    def test_allocations_are_budgeted_too(self):
        self.start(overall=A.Limiter(0, DAY))
        self.assertEqual(self.make_account()[0], 429)
        self.assertEqual(self.calls_to("/external/allocate"), [])

    def test_a_transaction_over_the_traffic_ceiling_is_refused_and_estimates_are_counted_against_the_day(self):
        self.make_account()
        self.ledger.cost = 200001
        self.assertEqual(self.prepare()[0], 403)
        self.start(traffic=A.Limiter(1500, DAY))
        self.ledger.cost = 1000
        self.assertEqual([self.send() for _ in range(2)], [200, 429])
        self.assertEqual(len(self.calls_to("/executeAndWait")), 1)
        self.ledger.fail["/v2/interactive-submission/prepare"] = (200, {"preparedTransaction": "eA==", "preparedTransactionHash": "aGFzaA==", "hashingSchemeVersion": "V"})
        self.service.prepared.items.clear()   # the over-budget one kept its entry
        self.assertEqual(self.prepare()[0], 502)   # no estimate: no transaction

    def test_a_prepared_transaction_gets_one_attempt_to_execute(self):
        self.make_account()
        _, p, _ = self.prepare()
        body = self.execute_body(p)
        self.ledger.fail["/v2/interactive-submission/executeAndWait"] = (400, {"code": "INVALID_ARGUMENT", "cause": "no"})
        self.assertEqual(self.req("POST", "/accounts/v1/execute", body)[0], 422)
        del self.ledger.fail["/v2/interactive-submission/executeAndWait"]
        self.assertEqual(self.req("POST", "/accounts/v1/execute", body)[0], 404)
        self.assertEqual(len(self.calls_to("/executeAndWait")), 1)

    def test_a_signature_that_is_not_the_accounts_is_refused_before_any_ledger_call(self):
        self.make_account()
        _, p, _ = self.prepare()
        before = len(self.ledger.calls)
        for bad in (self.execute_body(p, OTHER_SEED), {**self.execute_body(p), "partySignatures": [{"party": PARTY, "signature": SIG}]}):
            self.assertEqual(self.req("POST", "/accounts/v1/execute", bad)[0], 401)
        self.assertEqual(len(self.ledger.calls), before)
        self.assertEqual(self.req("POST", "/accounts/v1/execute", self.execute_body(p))[0], 200)   # the entry is still there for the right signature

    def test_a_signature_of_another_hash_is_refused(self):
        self.make_account()
        _, p, _ = self.prepare()
        body = self.execute_body({**p, "preparedTransactionHash": base64.b64encode(b"other").decode()})
        self.assertEqual(self.req("POST", "/accounts/v1/execute", body)[0], 401)
        self.assertEqual(self.calls_to("/executeAndWait"), [])

    def test_an_allocation_with_a_signature_that_is_not_the_keys_is_refused_before_any_ledger_call(self):
        _, t, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        status, _, _ = self.req("POST", "/accounts/v1/allocate", {"blob": t["blob"], "signature": self.sig(t["multiHash"], OTHER_SEED)})
        self.assertEqual(status, 401)
        self.assertEqual(self.calls_to("/external/allocate"), [])

    # M2: what waits for a signature

    def test_one_topology_blob_per_key_is_reused(self):
        first = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})[1]
        again = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})[1]
        self.assertEqual(first, again)
        self.assertEqual(len(self.calls_to("/generate-topology")), 1)
        self.assertNotEqual(self.req("POST", "/accounts/v1/topology", {"publicKey": OTHER_KEY})[1]["blob"], first["blob"])
        self.assertEqual(len(self.service.topologies.items), 2)

    def test_topologies_and_prepared_transactions_have_caps_of_their_own(self):
        self.start(topologies=A.Pending(limit=1), prepared=A.Pending(limit=1), open_limits={})
        self.assertEqual(self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})[0], 200)
        self.assertEqual(self.req("POST", "/accounts/v1/topology", {"publicKey": OTHER_KEY})[0], 503)   # full of topologies
        self.make_account()   # the one topology is used up
        self.assertEqual(self.prepare()[0], 200)   # prepared transactions have room that the topologies did not use
        self.assertEqual(self.prepare()[0], 503)

    def test_one_client_may_have_so_many_waiting_and_another_is_not_hindered(self):
        pending = A.Pending(per_owner=2)
        pending.put("a", 1, "x"); pending.put("b", 1, "x"); pending.put("a", 2, "x")   # the same key again takes no room
        with self.assertRaises(A.HttpError) as e:
            pending.put("c", 1, "x")
        self.assertEqual(e.exception.status, 503)
        pending.put("c", 1, "y")
        self.assertEqual(pending.take("a"), 2)
        self.assertIsNone(pending.take("a"))
        pending.put("c2", 1, "x")   # taking one freed a place
        self.start(prepared=A.Pending(per_owner=1), open_limits={})
        self.make_account()
        self.assertEqual([self.prepare()[0], self.prepare()[0]], [200, 503])

    # round 3

    def together(self, calls):
        out = [None] * len(calls)

        def run(i, call):
            out[i] = call()
        threads = [threading.Thread(target=run, args=(i, c)) for i, c in enumerate(calls)]
        for t in threads: t.start()
        for t in threads: t.join()
        return out

    def put_prepared(self, i, template=ACCEPT):
        """An entry as an earlier prepare would have made it."""
        tx = base64.b64encode(b"tx%d" % i).decode()
        self.service.prepared.put(hashlib.sha256(tx.encode()).hexdigest(), {"party": PARTY, "version": "V", "hash": b"hash", "cost": 1000, "template": template}, "x", PARTY)
        return {"preparedTransaction": tx, "preparedTransactionHash": "aGFzaA=="}

    def test_five_executes_at_once_make_one_acceptance(self):
        self.make_account()
        self.ledger.commits = ACCEPT
        entries = [self.put_prepared(i) for i in range(5)]
        statuses = self.together([lambda p=p: self.req("POST", "/accounts/v1/execute", self.execute_body(p))[0] for p in entries])
        self.assertEqual(sorted(statuses), [200, 409, 409, 409, 409])
        self.assertEqual(len(self.calls_to("/executeAndWait")), 1)

    def test_five_prepares_at_once_leave_one_waiting(self):
        self.make_account()
        statuses = self.together([lambda: self.prepare()[0] for _ in range(5)])
        self.assertEqual(sorted(statuses), [200, 409, 409, 409, 409])
        self.assertEqual(len(self.calls_to("/prepare")), 1)

    def test_an_account_with_a_create_waiting_prepares_no_other_of_that_template(self):
        self.make_account()
        self.assertEqual(self.prepare()[0], 200)
        self.assertEqual(self.prepare()[0], 409)
        self.assertEqual(len(self.calls_to("/prepare")), 1)
        self.assertEqual(self.prepare(DEPOSIT)[0], 200)   # another template is not hindered

    # round 3: text in creates, and the account's room

    def test_long_text_in_a_chain_create_is_refused(self):
        self.make_account()
        self.assertEqual(self.prepare(label="x" * 129)[0], 400)
        self.assertEqual(self.prepare(DEPOSIT, label={"ref": ["x" * 129]})[0], 400)
        self.assertEqual(self.calls_to("/prepare"), [])
        self.assertEqual(self.prepare(DEPOSIT, label="x" * 128)[0], 200)

    def test_one_account_may_have_only_so_many_prepared_waiting(self):
        self.start()
        self.assertEqual(self.service.prepared.per_group, 5)
        self.start(prepared=A.Pending(per_group=2), open_limits={})
        self.make_account()
        self.assertEqual([self.prepare()[0] for _ in range(3)], [200, 200, 503])

    def test_waiting_entries_count_ipv6_clients_by_their_48_and_the_rates_stay_per_64(self):
        self.start(topologies=A.Pending(per_owner=1))
        topology = lambda key, ip: self.service.handle("POST", "/accounts/v1/topology", {"publicKey": key}, ip)
        topology(KEY, "2001:db8:1:2::1")
        with self.assertRaises(A.HttpError) as e:
            topology(OTHER_KEY, "2001:db8:1:3::1")   # another /64 of the same /48
        self.assertEqual(e.exception.status, 503)
        topology(OTHER_KEY, "2001:db8:2:3::1")   # another /48
        self.assertEqual(A.pending_owner(A.client_key("203.0.113.7")), "203.0.113.7")
        self.assertNotEqual(A.client_key("2001:db8:1:2::1"), A.client_key("2001:db8:1:3::1"))

    # round 3: budgets and verifies

    def test_an_exhausted_overall_budget_charges_nothing_else_and_the_entry_survives(self):
        self.start(overall=A.Limiter(1, DAY))
        self.make_account()   # the allocation took the overall budget's one
        service = self.service
        _, p, _ = self.prepare()
        client = len(service.per_client.hits["127.0.0.1"])
        self.assertEqual(self.req("POST", "/accounts/v1/execute", self.execute_body(p))[0], 429)
        self.assertNotIn(PARTY, service.per_account.hits)
        self.assertEqual(len(service.per_client.hits["127.0.0.1"]), client)
        self.assertNotIn("all", service.traffic.hits)
        service.overall = A.Limiter(5, DAY)
        self.assertEqual(self.req("POST", "/accounts/v1/execute", self.execute_body(p))[0], 200)   # the entry was kept

    def test_failed_verifies_are_limited_before_anything_is_verified(self):
        self.start(failures=A.Limiter(2, 60))
        self.make_account()
        _, p, _ = self.prepare()
        calls, real = [], A.ed25519.verify
        with unittest.mock.patch.object(A.ed25519, "verify", side_effect=lambda *a: (calls.append(1), real(*a))[1]):
            bad = lambda: self.req("POST", "/accounts/v1/execute", self.execute_body(p, OTHER_SEED))[0]
            self.assertEqual([bad(), bad(), bad()], [401, 401, 429])
            verified = len(calls)
            self.assertEqual(bad(), 429)
            self.assertEqual(len(calls), verified)

    def test_a_failing_party_and_a_failing_client_are_each_limited(self):
        self.start(failures=A.Limiter(1, 60))
        self.make_account()
        other = "bridge::1220" + "ee" * 32
        self.service.parties.parties[other] = public_key(OTHER_SEED)
        path = "/accounts/v1/holdings/x"

        def status(party, ip):
            try:
                self.service.authenticate(party, "GET", path, b"", f"{int(time.time())}.{SIG}", ip)
            except A.HttpError as e:
                return e.status
        self.assertEqual(status(PARTY, "198.51.100.1"), 401)
        self.assertEqual(status(PARTY, "198.51.100.2"), 429)   # the party has failed enough, from whoever
        self.assertEqual(status(other, "198.51.100.1"), 429)   # the client has failed enough, for whichever party
        self.assertEqual(status(other, "198.51.100.3"), 401)


class Holdings(Case):
    def test_the_holding_views_of_all_pages(self):
        self.make_account()
        self.ledger.holdings = [[("c1", "10.0"), ("c2", "2.5")], [("c3", "1.0")]]
        status, out, _ = self.req("GET", f"/accounts/v1/holdings/{PARTY}")
        self.assertEqual(status, 200)
        self.assertEqual([(h["contractId"], h["amount"]) for h in out["holdings"]], [("c1", "10.0"), ("c2", "2.5"), ("c3", "1.0")])
        self.assertEqual(out["holdings"][0]["instrumentId"], {"admin": "reg::1", "id": "TKB"})
        first, second = [c[2] for c in self.calls_to("/active-contracts-page")]
        self.assertEqual(first["eventFormat"]["filtersByParty"][PARTY]["cumulative"][0]["identifierFilter"]["InterfaceFilter"]["value"]["interfaceId"], A.HOLDING)
        self.assertEqual((second["activeAtOffset"], second["pageToken"]), (9, "1"))   # the same snapshot, the next page

    def test_only_views_the_party_owns_are_listed(self):
        self.make_account()
        self.ledger.holdings = [[("c1", "10.0"), ("c2", "99.0", "other::1220" + "99" * 32), ("c3", "1.0", PARTY)]]
        out = self.req("GET", f"/accounts/v1/holdings/{PARTY}")[1]
        self.assertEqual([h["contractId"] for h in out["holdings"]], ["c1", "c3"])

    def test_no_holdings_is_an_empty_list(self):
        self.make_account()
        self.assertEqual(self.req("GET", f"/accounts/v1/holdings/{PARTY}")[1], {"party": PARTY, "holdings": []})


class Authentication(Case):
    """M1: every account-scoped request carries the account's signature."""
    def holdings(self, **kw):
        return self.req("GET", f"/accounts/v1/holdings/{PARTY}", **kw)

    def test_a_good_signature_passes_on_all_three_calls(self):
        self.make_account()
        self.assertEqual(self.holdings()[0], 200)
        _, p, _ = self.req("POST", "/accounts/v1/prepare", {"party": PARTY, "commands": [{"CreateCommand": {"templateId": DEPOSIT, "createArguments": {"party": PARTY, **CHAIN}}}]})
        self.assertEqual(self.req("POST", "/accounts/v1/execute", {"preparedTransaction": p["preparedTransaction"], "partySignatures": [
            {"party": PARTY, "signature": self.sig(p["preparedTransactionHash"])}]})[0], 200)

    def test_a_missing_signature_is_401_on_all_three_calls_and_nothing_reaches_the_ledger(self):
        self.make_account()
        before = len(self.ledger.calls)
        self.assertEqual(self.holdings(signed=False)[0], 401)
        self.assertEqual(self.req("POST", "/accounts/v1/prepare", {"party": PARTY, "commands": []}, signed=False)[0], 401)
        self.assertEqual(self.req("POST", "/accounts/v1/execute", {"preparedTransaction": "x", "partySignatures": [{"party": PARTY, "signature": SIG}]}, signed=False)[0], 401)
        self.assertEqual(len(self.ledger.calls), before)

    def test_a_bad_signature_is_401(self):
        self.make_account()
        self.assertEqual(self.holdings(seed=OTHER_SEED)[0], 401)   # another key's
        for header in ("", "garbage", "123", f"{int(time.time())}.", f"{int(time.time())}.!!!!", f"{int(time.time())}.{SIG}"):
            self.assertEqual(self.holdings(headers={"X-Account-Signature": header})[0], 401, header)
        # made for another body, another path or another method
        body = {"party": PARTY, "commands": []}
        other = self.account_signature("POST", "/accounts/v1/prepare", json.dumps({**body, "x": 1}).encode())
        self.assertEqual(self.req("POST", "/accounts/v1/prepare", body, headers={"X-Account-Signature": other})[0], 401)
        self.assertEqual(self.holdings(headers={"X-Account-Signature": self.account_signature("POST", f"/accounts/v1/holdings/{PARTY}", b"")})[0], 401)

    def test_a_stale_or_future_signature_is_401_and_the_window_is_a_minute(self):
        self.make_account()
        now = int(time.time())
        self.assertEqual(self.holdings(at=now - 120)[0], 401)
        self.assertEqual(self.holdings(at=now + 120)[0], 401)
        self.assertEqual(self.holdings(at=now - 50)[0], 200)

    def test_a_replayed_signature_is_401(self):
        self.make_account()
        header = {"X-Account-Signature": self.account_signature("GET", f"/accounts/v1/holdings/{PARTY}", b"")}
        self.assertEqual(self.holdings(headers=header)[0], 200)
        self.assertEqual(self.holdings(headers=header)[0], 401)

    def test_the_replay_memory_is_dropped_when_the_window_is_over(self):
        now = [1000.0]
        replays = A.Replays(wall=lambda: now[0])
        self.assertTrue(replays.add(PARTY, 1000, b"s"))
        self.assertFalse(replays.add(PARTY, 1000, b"s"))
        self.assertTrue(replays.add("other", 1000, b"s"))   # another account's
        now[0] = 1061
        replays.prune()
        self.assertEqual(replays.seen, {})


class Quota(Case):
    """H3: the account quota cannot be used up by one client or by all of them."""
    def test_ipv6_clients_count_by_their_64_and_ipv4_by_address(self):
        key = A.client_key
        self.assertEqual(key("2001:db8:1:2:aaaa::1"), key("2001:db8:1:2:bbbb:cccc:dddd:eeee"))
        self.assertNotEqual(key("2001:db8:1:2::1"), key("2001:db8:1:3::1"))
        self.assertEqual(key("203.0.113.7"), "203.0.113.7")
        self.assertNotEqual(key("203.0.113.7"), key("203.0.113.8"))
        self.assertEqual(key("::ffff:203.0.113.7"), "203.0.113.7")
        self.start(rate=A.Limiter(1, 60))
        get = lambda ip: self.service.handle("GET", "/accounts/v1/holdings/x", None, ip)
        for ip in ("2001:db8:1:2::1", "2001:db8:1:3::1", "203.0.113.7"):
            with self.assertRaises(A.HttpError) as e:
                get(ip)
            self.assertEqual(e.exception.status, 404)
        with self.assertRaises(A.HttpError) as e:
            get("2001:db8:1:2:ffff::9")   # the same /64 as the first
        self.assertEqual(e.exception.status, 429)

    def test_new_accounts_have_a_global_cap_a_day(self):
        self.assertEqual(A.Accounts(None, "svc", None, []).new_total.count, 200)
        self.start(new_total=A.Limiter(1, DAY), creates=A.Limiter(5, DAY))
        self.assertEqual(self.make_account()[0], 200)
        self.ledger.fail["/v2/parties/external/generate-topology"] = (200, {"partyId": "bridge::1220" + "ef" * 32, "publicKeyFingerprint": "1220" + "ef" * 32,
                                                                           "topologyTransactions": ["t"], "multiHash": "bQ=="})
        _, t2, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": OTHER_KEY})
        status, _, headers = self.req("POST", "/accounts/v1/allocate", {"blob": t2["blob"], "signature": self.sig(t2["multiHash"], OTHER_SEED)})
        self.assertEqual(status, 429)
        self.assertTrue(int(headers["retry-after"]) > 0)
        self.assertEqual(len(self.calls_to("/external/allocate")), 1)


class StateAndRights(Case):
    """M3: the state file can lose a line; the user's rights say which parties are held."""
    def holdings(self):
        return self.req("GET", f"/accounts/v1/holdings/{PARTY}")

    def test_a_torn_last_line_is_ignored_and_the_next_append_starts_a_new_line(self):
        self.make_account()
        line = open(self.state).read()
        with open(self.state, "w") as f:
            f.write(line + line[:40])   # a second write that stopped half way, with no newline
        parties = A.Parties(self.state)
        self.assertEqual(list(parties.parties), [PARTY])
        self.assertTrue(parties.torn)
        other = "bridge::1220" + "ef" * 32
        parties.add(other, public_key(OTHER_SEED))
        self.assertEqual(set(A.Parties(self.state).parties), {PARTY, other})

    def test_the_rights_are_read_at_start_and_again_on_a_miss(self):
        self.service.load_rights(force=True)
        self.assertEqual(self.service.rights, set())
        self.assertEqual(self.calls_to("/rights")[0][:2], ("GET", "/v2/users/svc/rights"))
        self.ledger.rights.append(PARTY)   # a party the file does not have: held, key unknown
        status, out, _ = self.holdings()
        self.assertEqual(status, 409)
        self.assertIn("register it again", out["error"])
        self.assertEqual(self.service.rights, {PARTY})   # the read on the miss; a CanReadAs right is not a held party
        self.assertEqual(self.req("GET", "/accounts/v1/holdings/stranger::1220" + "99" * 32)[0], 404)

    def test_the_rights_are_not_read_for_an_id_that_cannot_be_a_party(self):
        for junk in ("x", "bridge::1220" + "AB" * 32, "bridge::" + "ab" * 32, "a" * 5000):
            self.assertEqual(self.req("GET", f"/accounts/v1/holdings/{junk}")[0], 404, junk)
        self.assertEqual(self.calls_to("/rights"), [])
        self.assertEqual(self.req("GET", f"/accounts/v1/holdings/{PARTY}")[0], 404)
        self.assertEqual(len(self.calls_to("/rights")), 1)

    def test_a_lost_line_is_restored_by_a_fresh_topology_and_allocate_for_the_same_key(self):
        self.make_account()
        with open(self.state) as f:
            text = f.read()
        with open(self.state, "w") as f:
            f.write(text[:20])   # the line is torn
        self.start()
        self.service.load_rights(force=True)
        self.assertEqual(self.holdings()[0], 409)
        self.assertEqual(self.req("POST", "/accounts/v1/prepare", {"party": PARTY, "commands": []})[0], 409)
        _, t, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        self.assertEqual(t["exists"], False)
        self.assertEqual(self.req("POST", "/accounts/v1/allocate", {"blob": t["blob"], "signature": self.sig(t["multiHash"], OTHER_SEED)})[0], 401)   # not the key's
        status, out, _ = self.req("POST", "/accounts/v1/allocate", {"blob": t["blob"], "signature": self.sig(t["multiHash"])})
        self.assertEqual((status, out), (200, {"party": PARTY, "created": False, "restored": True}))
        self.assertEqual(len(self.calls_to("/external/allocate")), 1)   # the participant was not asked again
        self.assertEqual(self.holdings()[0], 200)
        self.start()   # and it holds after a restart: the new line began on a line of its own
        self.assertEqual(self.holdings()[0], 200)


class Proxies(Case):
    """M4: the header is read only from a trusted peer, and the n-th entry from the right."""
    def test_the_nth_entry_from_the_right_of_a_trusted_peer(self):
        trusted = A.TRUSTED_ADDRESSES
        header = "6.6.6.6, 1.1.1.1, 9.9.9.1"
        self.assertEqual([A.client_address("127.0.0.1", header, n, trusted) for n in (1, 2, 3)], ["9.9.9.1", "1.1.1.1", "6.6.6.6"])
        self.assertEqual(A.client_address("127.0.0.1", header, 4, trusted), "127.0.0.1")   # fewer entries than proxies: not written by the whole chain
        self.assertEqual(A.client_address("::1", header, 1, trusted), "9.9.9.1")
        self.assertEqual(A.client_address("::ffff:127.0.0.1", header, 1, trusted), "9.9.9.1")
        self.assertEqual(A.client_address("203.0.113.9", header, 1, trusted), "203.0.113.9")   # a peer that is not a proxy: the header is a client's own
        self.assertEqual(A.client_address("127.0.0.1", "", 1, trusted), "127.0.0.1")
        self.assertEqual(A.client_address("127.0.0.1", "1.1.1.1, not-an-address", 1, trusted), "127.0.0.1")
        self.assertEqual(A.client_address("10.1.2.3", header, 1, [ipaddress.ip_network("10.0.0.0/8")]), "9.9.9.1")

    def test_a_header_from_a_peer_that_is_not_trusted_is_ignored(self):
        self.http.shutdown()
        self.service.rate = A.Limiter(1, 60)
        self.http = A.make_server(self.service, "127.0.0.1", 0, "X-Forwarded-For", 1, [ipaddress.ip_network("10.0.0.0/8")])
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.http.server_address[1]}"
        spoofed = lambda real: {"X-Forwarded-For": real}
        self.assertEqual(self.req("GET", "/accounts/v1/holdings/x", headers=spoofed("9.9.9.1"))[0], 404)
        self.assertEqual(self.req("GET", "/accounts/v1/holdings/x", headers=spoofed("9.9.9.2"))[0], 429)   # both are the peer


class Upkeep(Case):
    """L3: health is cached; limiters and pending maps are pruned by the timer, not by requests."""
    def test_health_asks_the_ledger_once_in_five_seconds(self):
        now = [100.0]
        self.service.clock = lambda: now[0]
        for _ in range(5):
            self.assertTrue(self.req("GET", "/healthz")[1]["ok"])
        self.assertEqual(len(self.calls_to("/v2/version")), 1)
        now[0] = 106
        self.ledger.fail["/v2/version"] = (503, {})
        self.assertFalse(self.req("GET", "/healthz")[1]["ok"])
        self.assertFalse(self.req("GET", "/healthz")[1]["ok"])
        self.assertEqual(len(self.calls_to("/v2/version")), 2)

    def test_health_serves_the_last_answer_while_a_refresh_runs(self):
        now = [100.0]
        self.service.clock = lambda: now[0]
        self.assertTrue(self.service.health()["ok"])
        now[0] = 106
        started, release = threading.Event(), threading.Event()

        class Slow:
            def call(self, *a):
                started.set()
                release.wait(10)
                raise A.HttpError(502, "down")
        self.service.ledger = Slow()
        refresh = threading.Thread(target=self.service.health)
        refresh.start()
        self.assertTrue(started.wait(10))
        self.assertTrue(self.service.health()["ok"])   # at once: the last answer, not a wait for the refresh
        release.set(); refresh.join(10)
        self.assertEqual(self.service.health(), {"ok": False, "error": "down"})

    def test_expired_entries_wait_for_the_sweep(self):
        now = [0.0]
        limiter, pending = A.Limiter(5, 10, clock=lambda: now[0]), A.Pending(ttl=10, clock=lambda: now[0])
        for i in range(20):
            limiter.hit(f"k{i}")
            pending.put(f"p{i}", i, f"o{i}")
        now[0] = 11
        limiter.hit("fresh"); pending.put("fresh", 1)
        self.assertEqual((len(limiter.hits), len(pending.items)), (21, 21))   # a request did not prune
        limiter.prune(); pending.prune()
        self.assertEqual((list(limiter.hits), list(pending.items)), (["fresh"], ["fresh"]))
        self.service.sweep()   # all of the service's own, without error


class Limits(Case):
    def test_requests_per_minute_are_limited_per_client_and_health_is_not(self):
        self.start(rate=A.Limiter(2, 60))
        statuses = [self.req("GET", "/accounts/v1/holdings/x")[0] for _ in range(3)]
        self.assertEqual(statuses, [404, 404, 429])
        self.assertEqual(self.req("GET", "/healthz")[1], {"ok": True, "accounts": 0})

    def test_the_client_is_the_address_the_proxy_wrote(self):
        self.http.shutdown()
        self.service.rate = A.Limiter(1, 60)
        self.http = A.make_server(self.service, "127.0.0.1", 0, "X-Forwarded-For")
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.http.server_address[1]}"
        spoofed = lambda real: {"X-Forwarded-For": f"1.1.1.1, {real}"}
        self.assertEqual(self.req("GET", "/accounts/v1/holdings/x", headers=spoofed("9.9.9.1"))[0], 404)
        self.assertEqual(self.req("GET", "/accounts/v1/holdings/x", headers=spoofed("9.9.9.2"))[0], 404)
        self.assertEqual(self.req("GET", "/accounts/v1/holdings/x", headers=spoofed("9.9.9.1"))[0], 429)

    def test_a_body_over_the_cap_or_not_json_is_refused(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.http.server_address[1])   # says the size, sends nothing: the service answers at once
        conn.putrequest("POST", "/accounts/v1/topology"); conn.putheader("Content-Length", str(A.MAX_BODY + 1)); conn.endheaders()
        self.assertEqual(conn.getresponse().status, 400)
        conn.close()
        self.assertEqual(self.req("POST", "/accounts/v1/topology", raw=b"{nope")[0], 400)

    def test_unknown_routes_are_404_json(self):
        self.assertEqual(self.req("GET", "/nope")[0], 404)
        self.assertEqual(self.req("POST", "/accounts/v1/nope", {})[0], 404)

    def test_health_says_when_the_ledger_is_down(self):
        self.ledger.fail["/v2/version"] = (503, {})
        self.assertFalse(self.req("GET", "/healthz")[1]["ok"])

    def test_the_token_is_read_from_its_file_for_each_call(self):
        path = os.path.join(self.dir.name, "token")
        self.service.ledger = A.Ledger(self.ledger.url, token_file=path)
        for token, key in (("one", KEY), ("two", OTHER_KEY)):
            with open(path, "w") as f:
                f.write(token + "\n")
            self.req("POST", "/accounts/v1/topology", {"publicKey": key})
        self.assertEqual(self.ledger.tokens[-3:], ["Bearer one", "Bearer one", "Bearer two"])   # the first topology also asked for the synchronizer


class Config(unittest.TestCase):
    def test_every_allowed_create_needs_an_open_limit(self):
        thing = "#other:Mod:Thing"
        allow = [*A.DEFAULT_ALLOW, thing, thing + "#Choice"]
        with self.assertRaises(SystemExit):
            A.open_limits_from(allow, 3, None)
        self.assertEqual(A.open_limits_from(allow, 3, [thing + "=2"])[thing], 2)
        self.assertIsNone(A.open_limits_from(allow, 3, [thing + "=none"])[thing])
        for bad in (thing + "=0", thing + "=x", "#nope:Mod:X=1", thing + "#Choice=1", thing):
            with self.assertRaises(SystemExit, msg=bad):
                A.open_limits_from(allow, 3, [bad])
        self.assertEqual(A.open_limits_from(A.DEFAULT_ALLOW, 4, None), {ACCEPT: 1, DEPOSIT: 4})

    def test_the_service_does_not_start_with_an_unlimited_create(self):
        with tempfile.TemporaryDirectory() as d, unittest.mock.patch.dict(os.environ, {"LEDGER_TOKEN": "t"}):
            argv = ["--ledger-url", "http://127.0.0.1:1", "--user-id", "u", "--state-file", os.path.join(d, "s"), "--allow", "#other:Mod:Thing"]
            with self.assertRaises(SystemExit) as e:
                A.main(argv)
            self.assertIn("no open limit", str(e.exception))

    def test_the_built_in_list_is_well_formed(self):
        self.assertTrue(all(A.ALLOW_ENTRY.match(e) for e in A.DEFAULT_ALLOW))


if __name__ == "__main__":
    unittest.main()
