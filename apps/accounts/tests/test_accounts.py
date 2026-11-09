"""The accounts service against a fake JSON Ledger API. Run: python3 -m unittest discover -s apps/accounts/tests -v (pytest collects them too)."""
import base64, calendar, hashlib, http.client, ipaddress, json, os, secrets, sys, tempfile, threading, time, unittest, unittest.mock, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import accounts as A
from test_ed25519 import public_key, sign

SEED, OTHER_SEED = bytes(range(32)), bytes(range(1, 33))
KEY, OTHER_KEY = (base64.b64encode(public_key(seed)).decode() for seed in (SEED, OTHER_SEED))
SIG = base64.b64encode(bytes(64)).decode()
DAY = 86400
FINGERPRINT = "1220" + "ab" * 32
PARTY = "rome::" + FINGERPRINT
SYNC = "da::1220" + "cd" * 32
ACCEPT, DEPOSIT = A.ACCEPTANCE, A.DEPOSIT
CHAIN = {f: f + "::1220" + "0%d" % i * 32 for i, f in enumerate(A.CHAIN_FIELDS, 1)}
HOLDER = "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding"


class FakeLedger:
    """Answers the endpoints the service uses, records every call, and can be told to refuse."""
    def __init__(self):
        self.calls, self.fail, self.holdings, self.tokens, self.open, self.cost, self.prepared = [], {}, [], [], {}, 1000, 0
        self.created, self.allocations, self.transfers = {}, [], []   # created events by template (a read of open contracts); (contract id, view) of the Allocation and of the TransferInstruction interface
        self.rights = []   # the parties the service's user can act as
        self.archived = set()   # contract ids the participant's own events show archived (the rest show as created)
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
            return 200, {"version": "3.7.2"}
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
        if path.endswith("/events/events-by-contract-id"):
            return 200, ({"archived": {"archivedEvent": {}}} if body["contractId"] in self.archived else {"created": {"createdEvent": {}}})
        if path.endswith("/active-contracts-page") and "TemplateFilter" in json.dumps(body):   # the account's own contracts of one template
            template = json.dumps(body).split('"templateId": "')[1].split('"')[0]
            if template in self.created:
                return 200, {"activeAtOffset": 9, "activeContracts": [{"contractEntry": {"JsActiveContract": {"createdEvent": e}}} for e in self.created[template]]}
            return 200, {"activeAtOffset": 9, "activeContracts": [{}] * min(self.open.get(template, 0), body["maxPageSize"])}
        if path.endswith("/active-contracts-page") and "TransferInstructionV1:TransferInstruction" in json.dumps(body):
            return 200, {"activeAtOffset": 9, "activeContracts": [{"contractEntry": {"JsActiveContract": {"createdEvent": {
                "contractId": cid, "packageName": "splice-amulet", "interfaceViews": [{"interfaceId": "pkg:TransferInstructionV1:TransferInstruction", "viewValue": view}]}}}} for cid, view in self.transfers]}
        if path.endswith("/active-contracts-page") and "AllocationV1:Allocation" in json.dumps(body):
            return 200, {"activeAtOffset": 9, "activeContracts": [{"contractEntry": {"JsActiveContract": {"createdEvent": {
                "contractId": cid, "interfaceViews": [{"interfaceId": "pkg:AllocationV1:Allocation", "viewValue": view}]}}}} for cid, view in self.allocations]}
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
        if signed and (path in ("/accounts/v1/prepare", "/accounts/v1/execute", "/accounts/v1/faucet")
                       or path.startswith(("/accounts/v1/holdings/", "/accounts/v1/allocations/", "/accounts/v1/open/", "/accounts/v1/transfers/", "/accounts/v1/registry/"))) and "X-Account-Signature" not in headers:
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

    def replayed(self, path, body):
        """The same signed POST sent twice with one X-Account-Signature: what the first answers (anything but 401), and what the second answers."""
        header = {"X-Account-Signature": self.account_signature("POST", path, json.dumps(body).encode())}
        first = self.req("POST", path, body, headers=header)[0]
        self.assertNotEqual(first, 401, path)
        return first, self.req("POST", path, body, headers=header)[0]

    def execute_body(self, prepared, seed=SEED):
        return {"preparedTransaction": prepared["preparedTransaction"], "partySignatures": [{"party": PARTY, "signature": self.sig(prepared["preparedTransactionHash"], seed)}]}

    def calls_to(self, suffix):
        return [c for c in self.ledger.calls if c[1].endswith(suffix)]


class TopologyAndAllocate(Case):
    def test_topology_wraps_a_raw_key_and_names_the_synchronizer(self):
        status, out, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        self.assertEqual((status, out["party"], out["exists"], out["multiHash"], out["topologyTransactions"]), (200, PARTY, False, "bXVsdGk=", ["t1", "t2"]))
        self.assertEqual(self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})[1]["topologyTransactions"], ["t1", "t2"])   # asked again: the same blob, with its transactions
        sent = self.calls_to("/generate-topology")[0][2]
        self.assertEqual(sent["synchronizer"], SYNC)
        self.assertEqual(sent["partyHint"], "rome")
        self.assertEqual(base64.b64decode(sent["publicKey"]["keyData"]), A.SPKI_ED25519 + public_key(SEED))
        self.assertEqual(sent["publicKey"]["keySpec"], "SIGNING_KEY_SPEC_EC_CURVE25519")
        self.assertNotIn("protocolVersion", sent)
        self.assertEqual(set(self.ledger.tokens), {"Bearer tok"})

    def test_the_protocol_version_is_passed_through_when_set(self):
        self.start(topology_version=36)
        self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        self.assertEqual(self.calls_to("/generate-topology")[0][2]["protocolVersion"], 36)

    def test_a_key_with_a_small_order_part_is_refused(self):
        e = A.ed25519
        mixed = base64.b64encode(e.encode(e._add(e.B, (0, e.P - 1, 1, 0)))).decode()   # the base point plus the point of order 2
        self.assertEqual(self.req("POST", "/accounts/v1/topology", {"publicKey": mixed})[0], 400)
        self.assertEqual(self.calls_to("/generate-topology"), [])

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
        self.ledger.fail["/v2/parties/external/generate-topology"] = (200, {"partyId": "rome::1220" + "ef" * 32, "publicKeyFingerprint": "1220" + "ef" * 32,
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


class TakeBack(Case):
    """An account takes back a deposit that cannot settle: it withdraws its own allocation, and archives its own open deposit request, only once the builder can no longer settle them."""
    CID = "00" + "a1" * 40
    REQUEST = "00" + "b2" * 40

    def at(self, seconds):
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(seconds))

    def setUp(self):
        super().setUp()
        self.make_account()
        self.NOW = int(time.time())
        self.stranger = "other::1220" + "99" * 32

    def allocate(self, settle_before, cid=CID, sender=None):
        leg = {"transferLeg": {"sender": sender or PARTY, "receiver": CHAIN["gateway"], "amount": "5.0", "instrumentId": {"admin": "reg::1", "id": "Amulet"}}}
        self.ledger.allocations.append((cid, {"allocation": {"settlement": {"settlementRef": {"id": "dep1"}, "settleBefore": settle_before}, **leg}, "holdingCids": []}))

    def request(self, allocation=CID, depositor=None, cid=REQUEST):
        self.ledger.created = {DEPOSIT: [{"contractId": cid, "createArgument": {"depositor": depositor or PARTY, "allocation": allocation, "label": "dep1"}}]}

    def withdraw(self, cid=CID):
        return self.req("POST", "/accounts/v1/prepare", {"party": PARTY, "commands": [{"ExerciseCommand": {
            "templateId": A.ALLOCATION, "contractId": cid, "choice": "Allocation_Withdraw", "choiceArgument": {"extraArgs": {"context": {"values": {}}, "meta": {"values": {}}}}}}]})

    def archive(self, cid=REQUEST):
        return self.req("POST", "/accounts/v1/prepare", {"party": PARTY, "commands": [{"ExerciseCommand": {"templateId": DEPOSIT, "contractId": cid, "choice": "Archive", "choiceArgument": {}}}]})

    def test_the_margin_is_counted_from_the_settle_before_time_to_the_second(self):
        self.service.wall = lambda: 1_800_000_000
        late = lambda seconds: self.service.passed({"allocation": {"settlement": {"settleBefore": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(1_800_000_000 - seconds))}}})
        self.assertEqual([late(59), late(60), late(61)], [False, True, True])
        self.assertEqual(A.TAKE_BACK_MARGIN, 60)   # Canton's default record-time tolerance
        fraction = {"allocation": {"settlement": {"settleBefore": "2027-01-15T07:58:59.5Z"}}}   # 1_800_000_000 is 2027-01-15T08:00:00Z: 60.5 s past
        self.assertTrue(self.service.passed(fraction))
        self.assertFalse(self.service.passed({"allocation": {"settlement": {"settleBefore": "2027-01-15T07:59:00.5Z"}}}))

    def test_both_choices_are_on_the_built_in_list_and_need_no_open_limit(self):
        self.assertIn(A.ALLOCATION_WITHDRAW, A.DEFAULT_ALLOW)
        self.assertIn(A.DEPOSIT_ARCHIVE, A.DEFAULT_ALLOW)
        self.assertEqual(A.open_limits_from(A.DEFAULT_ALLOW, 3, None), {ACCEPT: 1, DEPOSIT: 3})

    def test_an_allocation_is_withdrawn_once_its_settle_before_time_has_passed_by_the_margin(self):
        self.allocate(self.at(self.NOW - 61))
        status, out, _ = self.withdraw()
        self.assertEqual((status, out["hashingSchemeVersion"]), (200, "HASHING_SCHEME_VERSION_V2"))
        self.assertEqual(self.calls_to("/prepare")[0][2]["commands"][0]["ExerciseCommand"]["choice"], "Allocation_Withdraw")

    def test_an_allocation_the_builder_can_still_settle_is_not_withdrawn(self):
        for settle_before in (self.at(self.NOW + 3600), self.at(self.NOW), self.at(self.NOW - 1), self.at(self.NOW - 50), "not a time"):
            self.ledger.allocations = []
            self.allocate(settle_before)
            status, out, _ = self.withdraw()
            self.assertEqual((status, out["error"]), (409, "not_yet"), settle_before)
        self.assertEqual(self.calls_to("/prepare"), [])

    def test_only_the_accounts_own_allocation_is_withdrawn(self):
        self.allocate(self.at(self.NOW - 3600), cid="00" + "c3" * 40, sender=self.stranger)
        self.assertEqual(self.withdraw("00" + "c3" * 40)[0], 404)   # another party's allocation: not among the account's own
        self.assertEqual(self.withdraw("00" + "d4" * 40)[0], 404)   # one that is not there
        self.assertEqual(self.req("POST", "/accounts/v1/prepare", {"party": PARTY, "commands": [{"ExerciseCommand": {"templateId": A.ALLOCATION, "choice": "Allocation_Withdraw"}}]})[0], 400)
        self.assertEqual(self.calls_to("/prepare"), [])

    def test_a_deposit_request_is_archived_when_its_allocation_is_past_or_gone(self):
        self.request()
        self.ledger.archived.add(self.CID)
        self.assertEqual(self.archive()[0], 200)   # the allocation is archived
        self.allocate(self.at(self.NOW - 61))
        self.assertEqual(self.archive()[0], 200)   # the allocation is past its time and the margin
        self.assertEqual(len(self.calls_to("/prepare")), 2)

    def test_a_deposit_request_whose_allocation_is_missing_from_the_list_but_active_is_not_archived(self):
        self.request()   # the account's list shows no allocation, but the participant's events show it created and not archived
        status, out, _ = self.archive()
        self.assertEqual((status, out["error"]), (409, "not_yet"))
        self.assertEqual(self.calls_to("/prepare"), [])

    def test_a_deposit_request_whose_allocation_the_participant_does_not_know_is_archived(self):
        self.request()
        self.ledger.fail["/v2/events/events-by-contract-id"] = (404, {"code": "CONTRACT_EVENTS_NOT_FOUND", "cause": "x"})
        self.assertEqual(self.archive()[0], 200)

    def test_a_deposit_request_whose_allocation_is_past_its_time_but_not_the_margin_is_not_archived(self):
        self.allocate(self.at(self.NOW - 50))
        self.request()
        status, out, _ = self.archive()
        self.assertEqual((status, out["error"]), (409, "not_yet"))
        self.assertEqual(self.calls_to("/prepare"), [])

    def test_a_deposit_request_whose_allocation_can_still_settle_is_not_archived(self):
        self.allocate(self.at(self.NOW + 3600))
        self.request()
        status, out, _ = self.archive()
        self.assertEqual((status, out["error"]), (409, "not_yet"))
        self.assertEqual(self.calls_to("/prepare"), [])

    def test_only_the_accounts_own_open_deposit_request_is_archived(self):
        self.request(depositor=self.stranger)
        self.assertEqual(self.archive()[0], 404)
        self.request()
        self.assertEqual(self.archive("00" + "e5" * 40)[0], 404)
        self.assertEqual(self.calls_to("/prepare"), [])

    def redeem_request(self, cid="00" + "f6" * 40, holder=None):
        self.ledger.created = {A.REDEEM: [{"contractId": cid, "createArgument": {"holder": holder or PARTY, "ref": "r1", "holdings": []}}]}

    def archive_redeem(self, cid="00" + "f6" * 40):
        return self.req("POST", "/accounts/v1/prepare", {"party": PARTY, "commands": [{"ExerciseCommand": {"templateId": A.REDEEM, "contractId": cid, "choice": "Archive", "choiceArgument": {}}}]})

    def test_the_redeem_archive_is_on_the_built_in_list(self):
        self.assertIn(A.REDEEM_ARCHIVE, A.DEFAULT_ALLOW)
        self.assertEqual(A.open_limits_from(A.DEFAULT_ALLOW, 3, None), {ACCEPT: 1, DEPOSIT: 3})

    def test_an_account_removes_its_own_open_redeem_request_at_any_time(self):
        self.start(allow=(*A.DEFAULT_ALLOW, A.REDEEM), open_limits={ACCEPT: 1, DEPOSIT: 3, A.REDEEM: 3})
        self.redeem_request()
        status, out, _ = self.archive_redeem()
        self.assertEqual((status, out["hashingSchemeVersion"]), (200, "HASHING_SCHEME_VERSION_V2"))
        self.assertEqual(self.calls_to("/prepare")[0][2]["commands"][0]["ExerciseCommand"]["choice"], "Archive")

    def test_only_the_accounts_own_open_redeem_request_is_removed(self):
        self.start(allow=(*A.DEFAULT_ALLOW, A.REDEEM), open_limits={ACCEPT: 1, DEPOSIT: 3, A.REDEEM: 3})
        self.redeem_request(holder=self.stranger)
        self.assertEqual(self.archive_redeem()[0], 404)   # another party's request
        self.redeem_request()
        self.assertEqual(self.archive_redeem("00" + "e7" * 40)[0], 404)   # one that is not there
        self.assertEqual(self.calls_to("/prepare"), [])

    def test_a_deployment_that_does_not_list_the_redeem_archive_refuses_it(self):
        self.start(allow=(*A.DEFAULT_ALLOW[:-1], A.REDEEM), open_limits={ACCEPT: 1, DEPOSIT: 3, A.REDEEM: 3})
        self.redeem_request()
        self.assertEqual(self.archive_redeem()[0], 403)

    OFFER = "00" + "ab" * 40

    def transfer_offer(self, sender=None, receiver=None, cid=OFFER, before=None):
        self.ledger.transfers.append((cid, {"transfer": {"sender": sender or PARTY, "receiver": receiver or self.stranger, "amount": "3.0", "instrumentId": {"admin": "reg::1", "id": "TKB"},
                                                         "requestedAt": "2026-11-09T10:00:00Z", "executeBefore": before or self.at(self.NOW + 3600)}}))

    def withdraw_transfer(self, cid=OFFER):
        return self.req("POST", "/accounts/v1/prepare", {"party": PARTY, "commands": [{"ExerciseCommand": {
            "templateId": A.TRANSFER_INSTRUCTION, "contractId": cid, "choice": "TransferInstruction_Withdraw", "choiceArgument": {"extraArgs": {"context": {"values": {}}, "meta": {"values": {}}}}}}]})

    def test_the_transfer_withdraw_is_on_the_built_in_list_and_needs_no_open_limit(self):
        self.assertIn(A.TRANSFER_WITHDRAW, A.DEFAULT_ALLOW)
        self.assertEqual(A.open_limits_from(A.DEFAULT_ALLOW, 3, None), {ACCEPT: 1, DEPOSIT: 3})

    def test_an_account_takes_back_a_transfer_it_sent_whether_or_not_the_offer_has_lapsed(self):
        self.transfer_offer()
        self.transfer_offer(cid="00" + "ac" * 40, before=self.at(self.NOW - 3600))
        for cid in (self.OFFER, "00" + "ac" * 40):
            status, out, _ = self.withdraw_transfer(cid)
            self.assertEqual((status, out["hashingSchemeVersion"]), (200, "HASHING_SCHEME_VERSION_V2"), cid)
        self.assertEqual([c[2]["commands"][0]["ExerciseCommand"]["choice"] for c in self.calls_to("/prepare")], ["TransferInstruction_Withdraw"] * 2)

    def test_an_account_does_not_take_back_a_transfer_it_did_not_send(self):
        self.transfer_offer(cid="00" + "af" * 40)   # a send of the account's own, so that the refusals below are about the named contract
        self.transfer_offer(sender=self.stranger, receiver=PARTY)   # offered to the account: the account is the receiver
        self.transfer_offer(sender=self.stranger, receiver="third::1220" + "88" * 32, cid="00" + "ad" * 40)
        self.assertEqual(self.withdraw_transfer()[0], 404)
        self.assertEqual(self.withdraw_transfer("00" + "ad" * 40)[0], 404)
        self.assertEqual(self.withdraw_transfer("00" + "ae" * 40)[0], 404)   # one that is not there
        self.assertEqual(self.req("POST", "/accounts/v1/prepare", {"party": PARTY, "commands": [{"ExerciseCommand": {"templateId": A.TRANSFER_INSTRUCTION, "choice": "TransferInstruction_Withdraw"}}]})[0], 400)
        self.assertEqual(self.calls_to("/prepare"), [])

    def test_a_transfer_is_taken_back_though_strangers_offered_more_than_the_list_holds(self):
        for i in range(A.TRANSFERS_MAX + 5):
            self.transfer_offer(sender=self.stranger, receiver=PARTY, cid="00" + "%02x" % (i % 256) * 40)
        self.transfer_offer()
        self.assertEqual(self.withdraw_transfer()[0], 200)

    def test_a_deployment_that_does_not_list_the_transfer_withdraw_refuses_it(self):
        self.start(allow=tuple(e for e in A.DEFAULT_ALLOW if e != A.TRANSFER_WITHDRAW))
        self.transfer_offer()
        self.assertEqual(self.withdraw_transfer()[0], 403)

    def test_prepare_says_the_time_it_can_be_recorded_by(self):
        self.start(allow=(*A.DEFAULT_ALLOW, A.REDEEM), open_limits={ACCEPT: 1, DEPOSIT: 3, A.REDEEM: 3})
        self.redeem_request()
        _, out, _ = self.archive_redeem()
        self.assertEqual(out["maxRecordTime"], self.calls_to("/prepare")[0][2]["maxRecordTime"])

    def test_a_deployment_that_does_not_list_them_refuses_both(self):
        self.start(allow=A.DEFAULT_ALLOW[:5])
        self.allocate(self.at(self.NOW - 3600))
        self.request()
        self.assertEqual((self.withdraw()[0], self.archive()[0]), (403, 403))


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

    def test_each_conflict_has_its_own_stable_code_and_a_message(self):
        self.make_account()
        self.ledger.open[ACCEPT] = 1
        status, out, _ = self.prepare()   # the account has this acceptance
        self.assertEqual((status, out), (409, {"error": "already_accepted", "message": "this account already has this acceptance"}))
        self.ledger.open[DEPOSIT] = 3
        status, out, _ = self.prepare(DEPOSIT)   # the limit of a request that may be made again
        self.assertEqual((status, out["error"]), (409, "too_many_open"))
        self.assertIn("3 open already", out["message"])
        self.ledger.open.clear()
        self.assertEqual(self.prepare()[0], 200)   # one waits for its signature
        status, out, _ = self.prepare()
        self.assertEqual((status, out["error"]), (409, "waiting_for_signature"))
        self.assertIn("execute it first", out["message"])
        self.service.prepared.items.clear()
        _, p, _ = self.prepare()   # sent after another acceptance was made: the same answer as at the prepare
        self.ledger.open[ACCEPT] = 1
        status, out, _ = self.req("POST", "/accounts/v1/execute", self.execute_body(p))
        self.assertEqual((status, out["error"]), (409, "already_accepted"))

    def test_the_twin_acceptance_is_an_acceptance_too(self):
        self.start(allow=(*A.DEFAULT_ALLOW, A.TWIN_ACCEPTANCE), open_limits={ACCEPT: 1, DEPOSIT: 3, A.TWIN_ACCEPTANCE: 1})
        self.make_account()
        self.ledger.open[A.TWIN_ACCEPTANCE] = 1
        status, out, _ = self.prepare(A.TWIN_ACCEPTANCE, party=PARTY, admin=CHAIN["gateway"])
        self.assertEqual((status, out["error"]), (409, "already_accepted"))

    def test_other_errors_keep_the_plain_shape(self):
        self.make_account()
        status, out, _ = self.req("POST", "/accounts/v1/prepare", {"party": PARTY, "commands": []})
        self.assertEqual((status, list(out)), (400, ["error"]))

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
        self.service.prepared.put(hashlib.sha256(tx.encode()).hexdigest(), {"party": PARTY, "version": "V", "hash": b"hash", "cost": 1000, "template": template, "record_by": int(time.time()) + 630}, "x", PARTY)
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

    def test_long_label_and_ref_and_big_arguments_are_refused_but_contract_ids_are_not(self):
        self.make_account()
        self.assertEqual(self.prepare(label="x" * 129)[0], 400)
        self.assertEqual(self.prepare(DEPOSIT, label={"ref": ["x" * 129]})[0], 400)
        self.assertEqual(self.prepare(DEPOSIT, extra="y" * 2100)[0], 400)   # the whole of the arguments is at most 2 KiB
        self.assertEqual(self.calls_to("/prepare"), [])
        self.assertEqual(self.prepare(DEPOSIT, label="x" * 128)[0], 200)

    def test_a_real_contract_id_is_no_text_to_cap(self):
        self.make_account()
        cid = "00" + "ab" * 32 + "ca12" + "1220" + "cd" * 32   # a Canton contract id: 138 characters
        self.assertEqual(len(cid), 138)
        self.assertEqual(self.prepare(DEPOSIT, allocation=cid)[0], 200)
        self.assertEqual(self.prepare(ACCEPT, holdings=[cid, cid, cid])[0], 200)   # a list of contract ids, as a redeem request has

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

    # round 5: the caps are checked before the participant is asked

    def test_a_client_over_its_caps_makes_no_ledger_call(self):
        self.start(topologies=A.Pending(per_owner=1), prepared=A.Pending(per_owner=1, per_group=1), open_limits={})
        self.assertEqual(self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})[0], 200)
        self.ledger.calls.clear()
        self.assertEqual(self.req("POST", "/accounts/v1/topology", {"publicKey": OTHER_KEY})[0], 503)
        self.assertEqual(self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})[0], 200)   # the key that has its blob is answered from it
        self.assertEqual(self.ledger.calls, [])
        self.make_account()
        self.assertEqual(self.prepare()[0], 200)
        self.ledger.calls.clear()
        self.assertEqual(self.prepare()[0], 503)   # the client's cap and the account's, both full
        self.assertEqual(self.ledger.calls, [])
        pending = A.Pending(per_owner=2)
        pending.room("x"); pending.put("a", 1, "x"); pending.put("b", 1, "x")
        with self.assertRaises(A.HttpError):
            pending.room("x")
        pending.room("y")
        self.assertEqual(len(pending.items), 2)   # room adds nothing

    def test_an_unusable_key_is_checked_only_when_it_has_no_blob(self):
        self.start(topologies=A.Pending(per_owner=1))
        self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        with unittest.mock.patch.object(A.ed25519, "usable_key", side_effect=AssertionError("checked again")):
            self.assertEqual(self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})[0], 200)
            self.assertEqual(self.req("POST", "/accounts/v1/topology", {"publicKey": OTHER_KEY})[0], 503)   # at the cap: no key check either

    def test_prepare_execute_and_holdings_have_a_rate_per_account(self):
        self.start(account_rate=A.Limiter(3, 60), open_limits={})
        self.make_account()
        self.assertEqual([self.prepare()[0] for _ in range(3)], [200, 200, 200])
        calls = len(self.ledger.calls)
        status, _, headers = self.prepare()
        self.assertEqual(status, 429)
        self.assertTrue(headers["retry-after"])
        self.assertEqual(self.req("GET", f"/accounts/v1/holdings/{PARTY}")[0], 429)   # one rate for the three
        self.assertEqual(len(self.ledger.calls), calls)
        self.assertEqual(self.req("GET", "/accounts/v1/holdings/other")[0], 404)   # another party is no one's rate: unsigned junk does not use it up
        self.assertEqual(self.service.account_rate.hits.get("other"), None)

    def test_a_client_network_has_a_rate_over_its_64s(self):
        self.start(network_rate=A.Limiter(3, 60))
        get = lambda ip: self.service.handle("GET", "/accounts/v1/holdings/x", None, ip)
        for ip in ("2001:db8:1:1::1", "2001:db8:1:2::1", "2001:db8:1:3::1"):   # three /64s of one /48
            with self.assertRaises(A.HttpError) as e:
                get(ip)
            self.assertEqual(e.exception.status, 404)
        with self.assertRaises(A.HttpError) as e:
            get("2001:db8:1:4::1")
        self.assertEqual(e.exception.status, 429)
        with self.assertRaises(A.HttpError) as e:
            get("2001:db8:2:1::1")   # another /48
        self.assertEqual(e.exception.status, 404)

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

    def test_failed_verifies_count_per_client_and_junk_for_a_party_does_not_lock_its_owner(self):
        self.start(failures=A.Limiter(1, 60))
        self.make_account()
        other = "rome::1220" + "ee" * 32
        self.service.parties.parties[other] = public_key(OTHER_SEED)
        path = "/accounts/v1/holdings/x"

        def status(party, ip, header=None):
            try:
                self.service.authenticate(party, "GET", path, b"", header or f"{int(time.time())}.{SIG}", ip)
                return 200
            except A.HttpError as e:
                return e.status
        self.assertEqual(status(PARTY, "198.51.100.1"), 401)   # junk for the victim's party from one client
        self.assertEqual(status(PARTY, "198.51.100.1"), 429)
        self.assertEqual(status(other, "198.51.100.1"), 429)   # that client has failed enough, for whichever party
        self.assertEqual(status(PARTY, "198.51.100.2", self.account_signature("GET", path, b"")), 200)   # the owner, from another client, is not hindered
        self.assertEqual(status(other, "198.51.100.3"), 401)
        v6 = A.client_key
        self.assertEqual(status(other, v6("2001:db8:1:2::1")), 401)
        self.assertEqual(status(other, v6("2001:db8:1:3::1")), 429)   # another /64 of the same /48
        self.assertEqual(status(other, v6("2001:db8:2:2::1")), 401)

    def test_a_start_without_the_cryptography_package_warns(self):
        with tempfile.TemporaryDirectory() as d, unittest.mock.patch.dict(os.environ, {"LEDGER_TOKEN": "t"}), unittest.mock.patch.object(A.ed25519, "Ed25519PublicKey", None), \
                unittest.mock.patch.object(A, "make_server", side_effect=SystemExit("stop")), unittest.mock.patch("sys.stderr") as err:
            with self.assertRaises(SystemExit):
                A.main(["--ledger-url", "http://127.0.0.1:1", "--user-id", "u", "--state-file", os.path.join(d, "s")])
        self.assertIn(A.SLOW_VERIFY_WARNING, "".join(c.args[0] for c in err.write.call_args_list))

    # round 4: what has no answer yet, and creates with no limit

    def test_an_execute_that_got_no_answer_counts_as_open_until_its_max_record_time(self):
        self.make_account()
        _, p, _ = self.prepare()
        self.ledger.fail["/v2/interactive-submission/executeAndWait"] = (503, {})
        self.assertEqual(self.req("POST", "/accounts/v1/execute", self.execute_body(p))[0], 502)
        del self.ledger.fail["/v2/interactive-submission/executeAndWait"]
        self.assertEqual(self.prepare()[0], 409)   # the ledger shows none open, the unanswered execute is counted
        self.assertEqual(len(self.calls_to("/prepare")), 1)
        sent = self.calls_to("/prepare")[0][2]["maxRecordTime"]
        self.assertAlmostEqual(calendar.timegm(time.strptime(sent, "%Y-%m-%dT%H:%M:%SZ")), time.time() + A.PENDING_TTL + A.RECORD_MARGIN, delta=5)
        later = time.monotonic() + A.IN_FLIGHT_TTL + 1   # past the old guess, but not past the end time
        self.service.in_flight.clock = lambda: later
        self.assertEqual(self.prepare()[0], 409)
        later = time.monotonic() + A.PENDING_TTL + A.RECORD_MARGIN + 5
        self.service.in_flight.clock = lambda: later
        self.assertEqual(self.prepare()[0], 200)

    def test_a_refused_execute_is_not_counted_as_open(self):
        self.make_account()
        _, p, _ = self.prepare()
        self.ledger.fail["/v2/interactive-submission/executeAndWait"] = (400, {"code": "INVALID_ARGUMENT", "cause": "no"})
        self.assertEqual(self.req("POST", "/accounts/v1/execute", self.execute_body(p))[0], 422)
        self.assertEqual(self.prepare()[0], 200)

    def test_a_create_with_no_open_limit_names_the_account_alone(self):
        thing = "#other:Mod:Thing"
        self.start(allow=[*A.DEFAULT_ALLOW, thing], open_limits={ACCEPT: 1, DEPOSIT: 3, thing: None})
        self.make_account()
        create = lambda arguments: self.req("POST", "/accounts/v1/prepare", {"party": PARTY, "commands": [{"CreateCommand": {"templateId": thing, "createArguments": arguments}}]})[0]
        self.assertEqual(create({"owner": PARTY, "note": "hi"}), 200)
        for arguments in ({"observers": [CHAIN["operator"]]}, {"owner": CHAIN["builder"]}):
            self.assertEqual(create(arguments), 403, arguments)


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


class AllocationsAndOpen(Case):
    LEG = lambda self, sender: {"transferLeg": {"sender": sender, "receiver": CHAIN["gateway"], "amount": "5.0", "instrumentId": {"admin": "reg::1", "id": "TKB"}}}

    def test_the_allocations_the_party_sends_with_the_committed_contract_id(self):
        self.make_account()
        self.ledger.allocations = [("a1", {"allocation": {"settlement": {"settlementRef": {"id": "dep1"}}, **self.LEG(PARTY)}, "holdingCids": ["h1"]}),
                                   ("a2", {"allocation": self.LEG("other::1220" + "99" * 32), "holdingCids": []})]
        status, out, _ = self.req("GET", f"/accounts/v1/allocations/{PARTY}")
        self.assertEqual(status, 200)
        self.assertEqual([(a["contractId"], a["holdingCids"], a["allocation"]["settlement"]["settlementRef"]["id"]) for a in out["allocations"]], [("a1", ["h1"], "dep1")])
        sent = self.calls_to("/active-contracts-page")[0][2]
        self.assertEqual(sent["eventFormat"]["filtersByParty"][PARTY]["cumulative"][0]["identifierFilter"]["InterfaceFilter"]["value"]["interfaceId"], A.ALLOCATION)

    def test_the_transfers_the_party_sends_or_is_offered(self):
        self.make_account()
        stranger, other = "other::1220" + "99" * 32, "third::1220" + "88" * 32
        move = lambda sender, receiver, amount="3.0": {"transfer": {"sender": sender, "receiver": receiver, "amount": amount, "instrumentId": {"admin": "reg::1", "id": "TKB"}, "requestedAt": "2026-11-09T10:00:00Z",
                                                                  "executeBefore": "2026-11-10T10:00:00Z", "inputHoldingCids": ["h1"], "meta": {"values": {}}}, "status": {"tag": "TransferPendingReceiverAcceptance", "value": {}}}
        self.ledger.transfers = [("t1", move(stranger, PARTY)), ("t2", move(PARTY, stranger, "1.5")), ("t3", move(stranger, other)), ("t4", {"status": None})]   # t3 is not the account's, t4 has no transfer
        status, out, _ = self.req("GET", f"/accounts/v1/transfers/{PARTY}")
        self.assertEqual(status, 200)
        self.assertEqual([(t["contractId"], t["transfer"]["sender"] == PARTY, t["transfer"]["amount"]) for t in out["transfers"]], [("t2", True, "1.5"), ("t1", False, "3.0")])   # its own send first
        self.assertEqual(out["transfers"][1]["transfer"], {k: v for k, v in move(stranger, PARTY)["transfer"].items() if k not in ("inputHoldingCids", "meta")})   # the holdings and the meta are not passed on
        self.assertEqual((out["transfers"][1]["status"], out["more"]), ({"tag": "TransferPendingReceiverAcceptance", "value": {}}, False))
        self.assertEqual([t["packageName"] for t in out["transfers"]], ["splice-amulet", "splice-amulet"])   # the ledger's package name of each contract
        sent = self.calls_to("/active-contracts-page")[0][2]
        self.assertEqual(sent["eventFormat"]["filtersByParty"][PARTY]["cumulative"][0]["identifierFilter"]["InterfaceFilter"]["value"]["interfaceId"], A.TRANSFER_INSTRUCTION)

    def test_the_accounts_own_sends_come_first_and_each_group_newest_first(self):
        self.make_account()
        stranger = "other::1220" + "99" * 32
        move = lambda sender, receiver, at: {"transfer": {"sender": sender, "receiver": receiver, "amount": "1.0", "instrumentId": {"admin": "reg::1", "id": "TKB"}, "requestedAt": at}}
        self.ledger.transfers = [("o1", move(stranger, PARTY, "2026-11-09T10:00:00Z")), ("s1", move(PARTY, stranger, "2026-11-09T09:00:00Z")), ("o2", move(stranger, PARTY, "2026-11-09T11:00:00Z")),
                                 ("s2", move(PARTY, stranger, "2026-11-09T09:30:00Z")), ("s3", {"transfer": {**move(PARTY, stranger, "")["transfer"], "requestedAt": None}})]
        out = self.req("GET", f"/accounts/v1/transfers/{PARTY}")[1]
        self.assertEqual([t["contractId"] for t in out["transfers"]], ["s2", "s1", "s3", "o2", "o1"])

    def test_the_accounts_own_sends_stay_in_the_list_when_strangers_offer_more_than_it_holds(self):
        self.make_account()
        stranger = "other::1220" + "99" * 32
        view = lambda sender, receiver: {"transfer": {"sender": sender, "receiver": receiver, "amount": "1.0", "instrumentId": {"admin": "reg::1", "id": "TKB"}, "requestedAt": "2026-11-09T10:00:00Z"}}
        self.ledger.transfers = [(f"t{i}", view(stranger, PARTY)) for i in range(A.TRANSFERS_MAX + 5)] + [("mine", view(PARTY, stranger))]
        out = self.req("GET", f"/accounts/v1/transfers/{PARTY}")[1]
        self.assertEqual((out["transfers"][0]["contractId"], len(out["transfers"]), out["more"]), ("mine", A.TRANSFERS_MAX, True))

    def test_the_transfers_are_bounded_and_need_the_accounts_signature(self):
        self.make_account()
        stranger = "other::1220" + "99" * 32
        self.ledger.transfers = [(f"t{i}", {"transfer": {"sender": stranger, "receiver": PARTY, "amount": "1.0", "instrumentId": {"admin": "reg::1", "id": "TKB"}}}) for i in range(A.TRANSFERS_MAX + 5)]
        out = self.req("GET", f"/accounts/v1/transfers/{PARTY}")[1]
        self.assertEqual((len(out["transfers"]), out["more"]), (A.TRANSFERS_MAX, True))
        self.assertEqual(self.req("GET", f"/accounts/v1/transfers/{PARTY}", signed=False)[0], 401)
        self.assertEqual(self.req("GET", f"/accounts/v1/transfers/{'rome::1220' + 'ff' * 32}")[0], 404)   # an account the service did not make

    def test_the_open_requests_the_party_made(self):
        self.start(allow=(*A.DEFAULT_ALLOW, A.REDEEM), open_limits={ACCEPT: 1, DEPOSIT: 3, A.REDEEM: 3})
        self.make_account()
        self.ledger.created = {DEPOSIT: [{"contractId": "d1", "createArgument": {"depositor": PARTY, "label": "x"}}, {"contractId": "d2", "createArgument": {"depositor": "other::1220" + "99" * 32}}],
                               A.REDEEM: [{"contractId": "r1", "createArgument": {"holder": PARTY, "ref": "y"}}]}
        status, out, _ = self.req("GET", f"/accounts/v1/open/{PARTY}")
        self.assertEqual((status, out), (200, {"party": PARTY, "depositRequests": [{"contractId": "d1", "arguments": {"depositor": PARTY, "label": "x"}}],
                                              "redeemRequests": [{"contractId": "r1", "arguments": {"holder": PARTY, "ref": "y"}}], "twinAcceptance": None, "withdrawalAcceptance": None}))

    def test_the_two_acceptances_are_listed_with_their_contract_ids_or_null(self):
        self.start(allow=(*A.DEFAULT_ALLOW, A.TWIN_ACCEPTANCE), open_limits={ACCEPT: 1, DEPOSIT: 3, A.TWIN_ACCEPTANCE: 1})
        self.make_account()
        out = self.req("GET", f"/accounts/v1/open/{PARTY}")[1]   # none made
        self.assertEqual((out["twinAcceptance"], out["withdrawalAcceptance"]), (None, None))
        stranger = "other::1220" + "99" * 32
        self.ledger.created = {A.TWIN_ACCEPTANCE: [{"contractId": "t0", "createArgument": {"party": stranger}}, {"contractId": "t1", "createArgument": {"party": PARTY, "admin": "g"}}],
                               ACCEPT: [{"contractId": "w1", "createArgument": {"party": PARTY, "chainId": "1"}}]}
        status, out, _ = self.req("GET", f"/accounts/v1/open/{PARTY}")
        self.assertEqual(status, 200)
        self.assertEqual(out["twinAcceptance"], {"contractId": "t1", "arguments": {"party": PARTY, "admin": "g"}})   # another party's is not the account's
        self.assertEqual(out["withdrawalAcceptance"], {"contractId": "w1", "arguments": {"party": PARTY, "chainId": "1"}})
        self.ledger.created = {A.TWIN_ACCEPTANCE: [{"contractId": "t1", "createArgument": {"party": PARTY}}]}   # only the twin one
        out = self.req("GET", f"/accounts/v1/open/{PARTY}")[1]
        self.assertEqual((out["twinAcceptance"]["contractId"], out["withdrawalAcceptance"]), ("t1", None))

    def paged_twin(self, pages):
        """The twin acceptance is served in pages: `pages(n)` is the n-th page's (items, whether another follows). Returns the bodies of the reads."""
        self.start(allow=(*A.DEFAULT_ALLOW, A.TWIN_ACCEPTANCE), open_limits={ACCEPT: 1, DEPOSIT: 3, A.TWIN_ACCEPTANCE: 1})
        self.make_account()
        reads, original = [], self.ledger.answer

        def answer(method, path, body):
            if path.endswith("/active-contracts-page") and A.TWIN_ACCEPTANCE in json.dumps(body):
                reads.append(body)
                items, more = pages(len(reads))
                page = {"activeAtOffset": 7, "activeContracts": [{"contractEntry": {"JsActiveContract": {"createdEvent": {"contractId": c, "createArgument": {"party": PARTY}}}}} for c in items]}
                return 200, {**page, **({"nextPageToken": str(len(reads))} if more else {})}
            return original(method, path, body)
        self.ledger.answer = answer
        return reads

    def test_an_acceptance_is_read_in_pages_of_one_snapshot(self):
        reads = self.paged_twin(lambda n: ([] if n < 3 else ["t-late"], n < 3))
        status, out, _ = self.req("GET", f"/accounts/v1/open/{PARTY}")
        self.assertEqual((status, out["twinAcceptance"]["contractId"]), (200, "t-late"))   # found on the third page
        self.assertEqual([r.get("pageToken") for r in reads], [None, "1", "2"])
        self.assertEqual([r.get("activeAtOffset") for r in reads], [None, 7, 7])   # the offset the first page gave, for every page after it

    def test_the_read_of_an_acceptance_stops_at_the_existing_page_limit(self):
        reads = self.paged_twin(lambda n: ([], True))   # a list that never ends
        status, _, _ = self.req("GET", f"/accounts/v1/open/{PARTY}")
        self.assertEqual((status, len(reads)), (500, A.HOLDINGS_PAGES))

    def test_a_template_the_service_does_not_allow_is_not_read(self):
        self.make_account()
        self.ledger.created = {DEPOSIT: []}
        self.assertEqual(self.req("GET", f"/accounts/v1/open/{PARTY}")[1], {"party": PARTY, "depositRequests": [], "redeemRequests": [], "twinAcceptance": None, "withdrawalAcceptance": None})
        self.assertEqual(len(self.calls_to("/active-contracts-page")), 2)   # the deposit requests and the withdrawal acceptance, the two it allows

    def test_both_need_the_account_signature_and_an_account_the_service_made(self):
        self.make_account()
        for what in ("allocations", "open", "transfers"):
            self.assertEqual(self.req("GET", f"/accounts/v1/{what}/{PARTY}", signed=False)[0], 401, what)
            self.assertEqual(self.req("GET", f"/accounts/v1/{what}/{PARTY}", seed=OTHER_SEED)[0], 401, what)
            self.assertEqual(self.req("GET", f"/accounts/v1/{what}/nobody::1220" + "0" * 64)[0], 404, what)


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

    def test_two_identical_signed_reads_in_the_same_second_both_answer(self):
        self.make_account()
        at = int(time.time())
        header = {"X-Account-Signature": self.account_signature("GET", f"/accounts/v1/holdings/{PARTY}", b"", at=at)}
        self.assertEqual(self.holdings(headers=header)[0], 200)
        self.assertEqual(self.holdings(headers=header)[0], 200)   # the very same signature: a read changes nothing
        for route in ("open", "transfers", "allocations"):
            path = f"/accounts/v1/{route}/{PARTY}"
            h = {"X-Account-Signature": self.account_signature("GET", path, b"", at=at)}
            self.assertEqual(self.req("GET", path, headers=h)[0], 200, route)
            self.assertEqual(self.req("GET", path, headers=h)[0], 200, route)

    def test_a_replayed_signature_of_a_request_that_changes_something_is_401(self):
        self.make_account()
        path, body = "/accounts/v1/prepare", {"party": PARTY, "commands": []}
        header = {"X-Account-Signature": self.account_signature("POST", path, json.dumps(body).encode())}
        self.assertNotEqual(self.req("POST", path, body, headers=header)[0], 401)
        self.assertEqual(self.req("POST", path, body, headers=header)[0], 401)
        # and the memory of a POST does not make a GET refused, nor the other way round
        self.assertEqual(self.holdings()[0], 200)

    def test_a_replayed_execute_is_401(self):
        self.make_account()
        _, p, _ = self.req("POST", "/accounts/v1/prepare", {"party": PARTY, "commands": [{"CreateCommand": {"templateId": DEPOSIT, "createArguments": {"party": PARTY, **CHAIN}}}]})
        _, second = self.replayed("/accounts/v1/execute", self.execute_body(p))
        self.assertEqual(second, 401)   # not the 404 of a transaction that is spent: the signature is refused first

    def test_a_read_outside_the_time_window_is_still_401_and_still_counts_against_the_account_rate(self):
        self.start(account_rate=A.Limiter(2, 60))
        self.make_account()
        now = int(time.time())
        self.assertEqual(self.holdings(at=now - 120)[0], 401)
        header = {"X-Account-Signature": self.account_signature("GET", f"/accounts/v1/holdings/{PARTY}", b"", at=now)}
        self.assertEqual(self.holdings(headers=header)[0], 200)
        self.assertEqual(self.holdings(headers=header)[0], 200)
        self.assertEqual(self.holdings(headers=header)[0], 429)   # repeats are not free: the per-account rate still applies

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
        self.ledger.fail["/v2/parties/external/generate-topology"] = (200, {"partyId": "rome::1220" + "ef" * 32, "publicKeyFingerprint": "1220" + "ef" * 32,
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
        other = "rome::1220" + "ef" * 32
        parties.add(other, public_key(OTHER_SEED))
        self.assertEqual(set(A.Parties(self.state).parties), {PARTY, other})

    def test_the_rights_are_read_at_start_and_again_on_a_miss(self):
        self.service.load_rights(force=True)
        self.assertEqual(self.service.rights, set())
        self.assertEqual(self.calls_to("/rights")[0][:2], ("GET", "/v2/users/svc/rights"))
        self.ledger.rights.append(PARTY)   # a party the file does not have: held, key unknown
        status, out, _ = self.holdings()
        self.assertEqual(status, 409)
        self.assertEqual(out["error"], "account_key_unknown")
        self.assertIn("register it again", out["message"])
        self.assertEqual(self.service.rights, {PARTY})   # the read on the miss; a CanReadAs right is not a held party
        self.assertEqual(self.req("GET", "/accounts/v1/holdings/stranger::1220" + "99" * 32)[0], 404)

    def test_the_rights_are_not_read_for_an_id_that_cannot_be_a_party(self):
        for junk in ("x", "rome::1220" + "AB" * 32, "rome::" + "ab" * 32, "a" * 5000):
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


ADMIN = "DSO::1220" + "dd" * 32
INSTRUCTION = "00" + "ab" * 40
FACTORY = {"factoryId": "00" + "cd" * 40, "choiceContext": {"choiceContextData": {"values": {}}, "disclosedContracts": [{"templateId": "#p:M:E", "contractId": "00" + "cd" * 40}]}}
HANDLE = secrets.token_hex(8)


# Splice 0.10.0 wallet-internal.yaml, TransferInstructionResultResponse: a completed transfer names the receiver's holdings, with no discriminator field.
COMPLETED = {"output": {"receiver_holding_cids": ["00" + "ef" * 40]}, "sender_change_cids": [], "meta": {"values": {}}}


class FakeOutside:
    """A registry or a wallet: records each request (path, body, authorization, user agent) and answers with what it is told, after `delay` seconds."""
    def __init__(self, status=200, answer=None, headers=None, raw=None, delay=0):
        self.calls, self.status, self.answer, self.headers, self.raw, self.delay = [], status, answer if answer is not None else FACTORY, headers or {}, raw, delay
        fake = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("content-length") or 0)
                fake.calls.append((self.path, json.loads(self.rfile.read(n) or b"null"), self.headers.get("authorization"), self.headers.get("user-agent")))
                time.sleep(fake.delay)
                data = fake.raw if fake.raw is not None else json.dumps(fake.answer).encode()
                try:
                    self.send_response(fake.status)
                    for k, v in {"content-length": str(len(data)), **fake.headers}.items():
                        self.send_header(k, v)
                    self.end_headers(); self.wfile.write(data)
                except OSError:
                    pass

            def log_message(self, *a): pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


class OutsideCase(Case):
    def setUp(self):
        super().setUp()
        self.outside = FakeOutside()
        self.bearer_file = os.path.join(self.dir.name, "token")
        with open(self.bearer_file, "w") as f:
            f.write(HANDLE + "\n")
        os.chmod(self.bearer_file, 0o600)

    def tearDown(self):
        self.outside.server.shutdown()
        super().tearDown()

    def on_connect(self, before=None, fail=None):
        """Patch the connect of a call to the fake outside server only (the test's own requests to the service connect as always): `before` runs first, `fail` is raised instead."""
        connect, port = A.http.client.HTTPConnection.connect, int(self.outside.url.rsplit(":", 1)[1])

        def patched(conn):
            if conn.port == port:
                if fail:
                    raise fail
                if before:
                    before()
            connect(conn)
        return unittest.mock.patch.object(A.http.client.HTTPConnection, "connect", patched)

    def with_registry(self, **kw):
        self.start(registries={ADMIN: (self.outside.url + "/scan-proxy", self.bearer_file)}, **kw)
        self.assertEqual(self.make_account()[0], 200)

    def factory(self, body=None, admin=ADMIN, **kw):
        return self.req("POST", f"/accounts/v1/registry/{admin}/allocation-factory", {"party": PARTY, "choiceArguments": {"x": 1}} if body is None else body, **kw)

    def accept(self, cid=INSTRUCTION, **kw):
        return self.req("POST", f"/accounts/v1/registry/{ADMIN}/transfer-instruction/{cid}/accept-context", {"party": PARTY, "meta": {}, "excludeDebugFields": True}, **kw)


class RegistryRelay(OutsideCase):
    def test_the_allocation_factory_goes_to_the_registry_and_the_answer_comes_back_as_it_is(self):
        self.with_registry()
        status, out, _ = self.factory()
        self.assertEqual((status, out), (200, FACTORY))
        # the party is the account's proof, not the registry's business; the token and the contact go along
        self.assertEqual(self.outside.calls, [("/scan-proxy/registry/allocation-instruction/v1/allocation-factory", {"choiceArguments": {"x": 1}}, "Bearer " + HANDLE, A.USER_AGENT)])

    def test_a_replayed_signature_is_401_on_every_registry_relay_post(self):
        self.outside.answer = {**FACTORY, "transferKind": "offer"}
        self.with_registry()
        body = {"party": PARTY, "meta": {}, "excludeDebugFields": True}
        for name, path in (("allocation-factory", f"/accounts/v1/registry/{ADMIN}/allocation-factory"),
                           ("transfer-factory", f"/accounts/v1/registry/{ADMIN}/transfer-factory"),
                           ("transfer accept-context", f"/accounts/v1/registry/{ADMIN}/transfer-instruction/{INSTRUCTION}/accept-context"),
                           ("transfer withdraw-context", f"/accounts/v1/registry/{ADMIN}/transfer-instruction/{INSTRUCTION}/withdraw-context"),
                           ("allocation withdraw-context", f"/accounts/v1/registry/{ADMIN}/allocation/{INSTRUCTION}/withdraw-context")):
            with self.subTest(name):
                self.assertEqual(self.replayed(path, body)[1], 401)

    def transfer_factory(self, body=None, admin=ADMIN, **kw):
        return self.req("POST", f"/accounts/v1/registry/{admin}/transfer-factory", {"party": PARTY, "choiceArguments": {"x": 1}, "excludeDebugFields": True} if body is None else body, **kw)

    def test_the_transfer_factory_goes_to_the_registry_and_the_answer_comes_back_as_it_is(self):
        self.outside.answer = {**FACTORY, "transferKind": "offer"}
        self.with_registry()
        status, out, _ = self.transfer_factory()
        self.assertEqual((status, out), (200, self.outside.answer))
        self.assertEqual(self.outside.calls, [("/scan-proxy/registry/transfer-instruction/v1/transfer-factory", {"choiceArguments": {"x": 1}, "excludeDebugFields": True}, "Bearer " + HANDLE, A.USER_AGENT)])

    def test_the_transfer_factory_has_the_same_limits_as_the_allocation_factory(self):
        self.with_registry(account_rate=A.Limiter(2, 60))
        self.assertEqual(self.transfer_factory(admin="DSO::1220" + "ee" * 32)[0], 404)   # an admin with no registry (counts against the rate, and asks nobody)
        self.assertEqual(self.outside.calls, [])
        self.assertEqual([self.transfer_factory()[0] for _ in range(2)], [200, 429])
        self.assertEqual(len(self.outside.calls), 1)

    def test_the_transfer_factory_needs_the_accounts_signature_and_a_small_request_and_answer(self):
        self.with_registry()
        self.assertEqual(self.transfer_factory(signed=False)[0], 401)
        self.assertEqual(self.transfer_factory(seed=OTHER_SEED)[0], 401)
        self.assertEqual(self.transfer_factory({"party": "rome::1220" + "ff" * 32})[0], 404)
        self.assertEqual(self.transfer_factory({"party": PARTY, "pad": "x" * A.RELAY_MAX_BODY})[0], 400)
        self.assertEqual(self.outside.calls, [])
        self.outside.answer = {"pad": "x" * (A.RELAY_MAX_ANSWER + 10)}
        self.assertEqual(self.transfer_factory()[0], 502)
        self.outside.raw = b"[1]"
        self.assertEqual(self.transfer_factory()[0], 502)   # not a JSON object
        self.outside.raw = None
        self.outside.status, self.outside.raw = 302, b"{}"
        status, out, _ = self.transfer_factory()
        self.assertEqual((status, out["registryStatus"]), (502, 302))   # a redirect is not followed

    def test_the_transfer_factory_peer_is_checked_and_the_deadline_holds(self):
        self.with_registry()
        with unittest.mock.patch.object(A, "is_loopback_address", return_value=False):
            self.assertEqual(self.transfer_factory()[0], 502)
        self.assertEqual(self.outside.calls, [])
        with unittest.mock.patch.object(A, "OUTSIDE_DEADLINE", 0.2), self.on_connect(before=lambda: time.sleep(0.3)):
            self.assertEqual(self.transfer_factory()[0], 502)
        self.assertEqual(self.outside.calls, [])

    def test_the_accept_context_of_an_instruction(self):
        self.outside.answer = {"choiceContextData": {"values": {}}, "disclosedContracts": []}
        self.with_registry()
        status, out, _ = self.accept()
        self.assertEqual((status, out), (200, self.outside.answer))
        self.assertEqual(self.outside.calls[0][:2], (f"/scan-proxy/registry/transfer-instruction/v1/{INSTRUCTION}/choice-contexts/accept", {"meta": {}, "excludeDebugFields": True}))

    def test_the_withdraw_context_of_a_transfer_instruction(self):
        self.outside.answer = {"choiceContextData": {"values": {}}, "disclosedContracts": []}
        self.with_registry()
        status, out, _ = self.req("POST", f"/accounts/v1/registry/{ADMIN}/transfer-instruction/{INSTRUCTION}/withdraw-context", {"party": PARTY, "meta": {}, "excludeDebugFields": True})
        self.assertEqual((status, out), (200, self.outside.answer))
        self.assertEqual(self.outside.calls[0][:2], (f"/scan-proxy/registry/transfer-instruction/v1/{INSTRUCTION}/choice-contexts/withdraw", {"meta": {}, "excludeDebugFields": True}))
        self.assertEqual(self.req("POST", f"/accounts/v1/registry/{ADMIN}/transfer-instruction/nope/withdraw-context", {"party": PARTY})[0], 404)
        self.assertEqual(self.req("POST", f"/accounts/v1/registry/{ADMIN}/transfer-instruction/{INSTRUCTION}/reject-context", {"party": PARTY})[0], 404)   # nothing else is relayed

    def test_the_withdraw_context_of_an_allocation(self):
        self.outside.answer = {"choiceContextData": {"values": {}}, "disclosedContracts": []}
        self.with_registry()
        status, out, _ = self.req("POST", f"/accounts/v1/registry/{ADMIN}/allocation/{INSTRUCTION}/withdraw-context", {"party": PARTY, "meta": {}, "excludeDebugFields": True})
        self.assertEqual((status, out), (200, self.outside.answer))
        self.assertEqual(self.outside.calls[0][:2], (f"/scan-proxy/registry/allocations/v1/{INSTRUCTION}/choice-contexts/withdraw", {"meta": {}, "excludeDebugFields": True}))
        self.assertEqual(self.req("POST", f"/accounts/v1/registry/{ADMIN}/allocation/nope/withdraw-context", {"party": PARTY})[0], 404)

    def test_an_unknown_admin_is_404_and_a_registry_without_a_token_gets_none(self):
        self.with_registry()
        self.assertEqual(self.factory(admin="DSO::1220" + "ee" * 32)[0], 404)
        self.assertEqual(self.outside.calls, [])
        self.start(registries={ADMIN: (self.outside.url, None)})   # the account is in the state file
        self.assertEqual(self.factory()[0], 200)
        self.assertIsNone(self.outside.calls[0][2])

    def test_no_registry_is_configured_by_default(self):
        self.make_account()
        self.assertEqual(self.factory()[0], 404)

    def test_the_account_must_have_signed_and_a_bad_instruction_id_is_no_route(self):
        self.with_registry()
        self.assertEqual(self.factory(signed=False)[0], 401)
        self.assertEqual(self.factory(seed=OTHER_SEED)[0], 401)   # another key's signature
        self.assertEqual(self.factory({"party": "rome::1220" + "ff" * 32})[0], 404)
        self.assertEqual(self.factory({})[0], 404)
        self.assertEqual(self.accept(cid="nope")[0], 404)
        self.assertEqual(self.accept(cid="00" + "AB" * 40)[0], 404)
        self.assertEqual(self.outside.calls, [])

    def test_each_call_counts_against_the_accounts_rate(self):
        self.with_registry(account_rate=A.Limiter(2, 60))
        self.assertEqual([self.factory()[0] for _ in range(3)], [200, 200, 429])
        self.assertEqual(len(self.outside.calls), 2)

    def test_the_answer_is_capped_at_one_mebibyte(self):
        self.assertEqual(A.RELAY_MAX_ANSWER, 1024 * 1024)
        self.outside.answer = {"pad": "x" * (A.RELAY_MAX_ANSWER + 10)}
        self.with_registry()
        status, out, _ = self.factory()
        self.assertEqual((status, out), (502, {"error": "the token registry could not be used"}))
        self.outside.answer = {"pad": "x" * (A.RELAY_MAX_ANSWER - 100)}   # under the cap: passes
        self.assertEqual(self.factory()[0], 200)

    def test_the_request_is_capped(self):
        self.with_registry()
        self.assertEqual(self.factory({"party": PARTY, "pad": "x" * A.RELAY_MAX_BODY})[0], 400)
        self.assertEqual(self.outside.calls, [])

    def test_a_redirect_is_not_followed(self):
        other = FakeOutside()
        self.outside.status, self.outside.headers, self.outside.raw = 302, {"location": other.url + "/stolen"}, b"{}"
        self.with_registry()
        status, out, _ = self.factory()
        self.assertEqual((status, out["error"], out["registryStatus"]), (502, "the token registry answered HTTP 302", 302))
        self.assertEqual(other.calls, [])
        other.server.shutdown()

    def test_the_deadline_covers_the_connect_and_the_read_together(self):
        self.with_registry()
        self.outside.delay = 0.6   # each part is inside the deadline, the two together are not
        started = time.monotonic()
        with unittest.mock.patch.object(A, "OUTSIDE_DEADLINE", 1.0), self.on_connect(before=lambda: time.sleep(0.6)):
            status, out, _ = self.factory()
        self.assertEqual((status, out), (502, {"error": "the token registry could not be used"}))
        self.assertLess(time.monotonic() - started, 1.5)
        self.outside.delay = 0.1   # in time: it passes
        with unittest.mock.patch.object(A, "OUTSIDE_DEADLINE", 1.0), self.on_connect(before=lambda: time.sleep(0.6)):
            self.assertEqual(self.factory()[0], 200)

    def test_a_connect_that_used_the_whole_deadline_sends_nothing(self):
        self.with_registry()
        with unittest.mock.patch.object(A, "OUTSIDE_DEADLINE", 0.2), self.on_connect(before=lambda: time.sleep(0.3)):
            self.assertEqual(self.factory()[0], 502)
        self.assertEqual(self.outside.calls, [])

    def test_an_answer_that_is_not_a_json_object_is_refused(self):
        self.with_registry()
        for raw in (b"not json", b"[1]", b"NaN", b'{"a": NaN}', b"\xff", b""):
            self.outside.raw = raw
            self.assertEqual(self.factory()[0], 502, raw)

    def test_a_registry_that_refuses_is_a_502_with_its_status_and_none_of_its_text(self):
        self.outside.status, self.outside.raw = 404, json.dumps({"error": HANDLE + " secret"}).encode()
        self.with_registry()
        status, out, _ = self.factory()
        self.assertEqual((status, out), (502, {"error": "the token registry answered HTTP 404", "registryStatus": 404}))

    def test_the_peer_is_checked_before_anything_is_sent(self):
        self.with_registry()
        with unittest.mock.patch.object(A, "is_loopback_address", return_value=False):
            self.assertEqual(self.factory()[0], 502)
        self.assertEqual(self.outside.calls, [])

    def test_a_slow_registry_is_cut_off(self):
        self.outside.delay = 3
        self.with_registry()
        started = time.monotonic()
        with unittest.mock.patch.object(A, "OUTSIDE_DEADLINE", 0.5):
            self.assertEqual(self.factory()[0], 502)
        self.assertLess(time.monotonic() - started, 2.5)

    def test_a_registry_that_is_not_there_is_a_502(self):
        self.start(registries={ADMIN: ("http://127.0.0.1:1", None)})
        self.make_account()
        self.assertEqual(self.factory()[0], 502)

    def test_the_token_is_read_from_its_file_for_each_request(self):
        self.with_registry()
        self.factory()
        with open(self.bearer_file, "w") as f:
            f.write("rotated\n")
        self.factory({"party": PARTY, "choiceArguments": {"x": 2}})
        self.assertEqual([c[2] for c in self.outside.calls], ["Bearer " + HANDLE, "Bearer rotated"])
        with open(self.bearer_file, "w") as f:
            f.write("two tokens\n")
        self.assertEqual(self.factory()[0], 502)   # a file with two in it: nothing is sent
        self.assertEqual(len(self.outside.calls), 2)


class PublicRegistryRelay(OutsideCase):
    """The registry relay for wallets this service did not make: no account, no signature."""
    BODY = {"choiceArguments": {"x": 1, "nested": {"y": [1, 2]}}, "excludeDebugFields": True}

    def setUp(self):
        super().setUp()
        self.start(registries={ADMIN: (self.outside.url + "/scan-proxy", self.bearer_file)})   # no account is made: the callers have none here

    def public(self, suffix, body=None, admin=ADMIN, **kw):
        return self.req("POST", f"/accounts/v1/public-registry/{admin}/{suffix}", self.BODY if body is None else body, **kw)

    def test_each_suffix_reaches_its_registry_path_and_the_answer_comes_back_as_it_is(self):
        for suffix, path in (("allocation-factory", "/registry/allocation-instruction/v1/allocation-factory"),
                             ("transfer-factory", "/registry/transfer-instruction/v1/transfer-factory"),
                             (f"transfer-instruction/{INSTRUCTION}/accept-context", f"/registry/transfer-instruction/v1/{INSTRUCTION}/choice-contexts/accept"),
                             (f"transfer-instruction/{INSTRUCTION}/withdraw-context", f"/registry/transfer-instruction/v1/{INSTRUCTION}/choice-contexts/withdraw"),
                             (f"allocation/{INSTRUCTION}/withdraw-context", f"/registry/allocations/v1/{INSTRUCTION}/choice-contexts/withdraw")):
            with self.subTest(suffix):
                self.outside.calls.clear()
                status, out, _ = self.public(suffix)
                self.assertEqual((status, out), (200, self.outside.answer))
                self.assertEqual(self.outside.calls, [("/scan-proxy" + path, self.BODY, "Bearer " + HANDLE, A.USER_AGENT)])

    def test_the_body_goes_on_unchanged(self):
        body = {"party": "someone::1220" + "11" * 32, "meta": {"k": "v"}, "choiceArguments": {"a": [1, {"b": None}]}}
        self.assertEqual(self.public("allocation-factory", body)[0], 200)
        self.assertEqual(self.outside.calls[0][1], body)   # not even `party` is taken out: there is no account to prove
        self.assertEqual(self.public("allocation-factory", raw=b"")[0], 200)   # no body: an empty request
        self.assertEqual(self.outside.calls[1][1], {})

    def test_no_signature_and_no_account_are_needed(self):
        self.assertEqual(self.service.parties.parties, {})
        self.assertEqual(self.public("transfer-factory", signed=False)[0], 200)
        self.assertEqual(self.public("transfer-factory", headers={"X-Account-Signature": "1.AAAA"})[0], 200)   # a header that is no use is not read

    def test_two_identical_requests_are_both_answered_and_the_account_rate_is_not_used(self):
        self.start(registries={ADMIN: (self.outside.url + "/scan-proxy", self.bearer_file)}, account_rate=A.Limiter(1, 60))
        self.assertEqual([self.public("allocation-factory")[0] for _ in range(3)], [200, 200, 200])
        self.assertEqual(len(self.outside.calls), 3)
        self.assertEqual(self.service.replays.seen, {})   # nothing is remembered: there is no signature

    def test_an_unknown_admin_or_path_is_404_and_asks_nobody(self):
        self.assertEqual(self.public("allocation-factory", admin="DSO::1220" + "ee" * 32)[0], 404)
        for suffix in ("reject-context", f"transfer-instruction/{INSTRUCTION}/reject-context", "transfer-instruction/nope/accept-context", f"allocation/{INSTRUCTION}/accept-context", "allocation-factory/more"):
            with self.subTest(suffix):
                self.assertEqual(self.public(suffix)[0], 404)
        self.assertEqual(self.req("GET", f"/accounts/v1/public-registry/{ADMIN}/allocation-factory")[0], 404)   # a POST only
        self.assertEqual(self.outside.calls, [])

    def test_a_request_longer_than_the_limit_is_400(self):
        status, out, _ = self.public("allocation-factory", {"choiceArguments": {"x": "a" * A.RELAY_MAX_BODY}})
        self.assertEqual(status, 400)
        self.assertEqual(self.outside.calls, [])

    def test_each_client_has_its_own_rate(self):
        self.assertEqual(A.PUBLIC_RELAY_RATE, 30)
        self.start(registries={ADMIN: (self.outside.url + "/scan-proxy", self.bearer_file)}, public_relay_rate=A.Limiter(2, 60))
        status = [self.public("allocation-factory")[0] for _ in range(3)]
        self.assertEqual(status, [200, 200, 429])
        self.assertEqual(len(self.outside.calls), 2)
        self.assertIn("Retry-After", self.public("allocation-factory")[2])
        # another client is not held back by it
        self.service.handle("POST", f"/accounts/v1/public-registry/{ADMIN}/allocation-factory", {}, "203.0.113.9")
        self.assertEqual(len(self.outside.calls), 3)

    def test_the_signed_relay_still_demands_a_signature(self):
        self.assertEqual(self.make_account()[0], 200)
        self.assertEqual(self.factory(signed=False)[0], 401)
        self.assertEqual(self.factory(seed=OTHER_SEED)[0], 401)
        self.assertEqual(self.outside.calls, [])
        self.assertEqual(self.factory()[0], 200)


class Faucets(OutsideCase):
    WALLET = "/v0/wallet/token-standard/transfers"

    def with_faucet(self, **kw):
        self.start(faucet=A.Faucet("20.0", self.outside.url + "/api/validator", self.bearer_file, **kw))
        self.assertEqual(self.make_account()[0], 200)

    def ask(self, **kw):
        return self.req("POST", "/accounts/v1/faucet", {"party": PARTY}, **kw)

    def test_a_replayed_signature_is_401_on_the_faucet(self):
        self.outside.answer = COMPLETED
        self.with_faucet(per_day=100)
        self.faucet_reset()
        self.assertEqual(self.replayed("/accounts/v1/faucet", {"party": PARTY})[1], 401)

    def faucet_reset(self):
        self.service.faucet.per_account = A.Limiter(1, DAY)
        self.service.faucet.per_client = A.Limiter(1, DAY)

    def test_the_faucet_is_off_unless_it_is_set(self):
        self.make_account()
        self.assertEqual(self.ask()[0], 404)
        self.assertEqual(self.outside.calls, [])
        self.assertIsNone(A.faucet_from(None, None, None, 200))
        with unittest.mock.patch.dict(os.environ, {"LEDGER_TOKEN": "t"}), self.assertRaises(SystemExit):   # the amount alone does not turn it on
            A.main(["--ledger-url", "http://127.0.0.1:1", "--user-id", "u", "--state-file", os.path.join(self.dir.name, "s"), "--faucet-amount", "20"])

    def test_a_pending_transfer_gives_the_instruction_the_account_accepts(self):
        self.outside.answer = {"output": {"transfer_instruction_cid": INSTRUCTION}, "sender_change_cids": [], "meta": {"values": {}}}
        self.with_faucet()
        status, out, _ = self.ask()
        self.assertEqual((status, out), (200, {"transferInstructionCid": INSTRUCTION}))
        [(path, body, auth, agent)] = self.outside.calls
        self.assertEqual((path, auth, agent), ("/api/validator" + self.WALLET, "Bearer " + HANDLE, A.USER_AGENT))
        self.assertEqual((body["receiver_party_id"], body["amount"]), (PARTY, "20.0"))
        self.assertTrue(body["tracking_id"].startswith("faucet-") and body["expires_at"] > time.time() * 1_000_000)

    def test_a_completed_transfer(self):
        self.outside.answer = COMPLETED
        self.with_faucet()
        self.assertEqual(self.ask()[1], {"completed": True})

    def test_an_answer_that_made_no_transfer_is_a_502(self):
        self.with_faucet(per_day=100)
        for answer in ({"output": {"dummy": {}}}, {"output": {"transfer_instruction_cid": "x"}}, {"output": {"receiver_holding_cids": "x"}}, {"output": 1}, {}):
            self.outside.answer = answer
            self.faucet_reset()
            self.assertEqual(self.ask()[0], 502, answer)

    def test_the_account_must_have_signed(self):
        self.with_faucet()
        self.assertEqual(self.ask(signed=False)[0], 401)
        self.assertEqual(self.ask(seed=OTHER_SEED)[0], 401)
        self.assertEqual(self.req("POST", "/accounts/v1/faucet", {"party": "rome::1220" + "ff" * 32})[0], 404)
        self.assertEqual(self.outside.calls, [])

    def test_once_a_day_for_an_account_with_retry_after(self):
        self.outside.answer = COMPLETED
        self.with_faucet()
        self.assertEqual(self.ask()[0], 200)
        status, _, headers = self.ask()
        self.assertEqual(status, 429)
        self.assertGreater(int(headers["Retry-After"]), 80000)
        self.assertEqual(len(self.outside.calls), 1)

    def test_the_limits_of_the_account_the_client_and_the_day(self):
        with unittest.mock.patch.object(A, "outside_post", return_value=COMPLETED) as sent:
            f = A.Faucet("20.0", "https://wallet.example", self.bearer_file, per_day=2)
            self.assertEqual(f.grant("p1", "1.1.1.1"), {"completed": True})
            for party, client in (("p1", "2.2.2.2"), ("p2", "1.1.1.1")):   # the same account, the same client
                with self.assertRaises(A.HttpError) as e:
                    f.grant(party, client)
                self.assertEqual(e.exception.status, 429)
            self.assertEqual(f.grant("p2", "2.2.2.2"), {"completed": True})
            with self.assertRaises(A.HttpError) as e:   # the day's total of 2
                f.grant("p3", "3.3.3.3")
            self.assertEqual(e.exception.status, 429)
            self.assertEqual(sent.call_count, 2)   # a refused request charged nothing and sent nothing
            for limiter in f.limiters():   # a day later
                limiter.clock = lambda: time.monotonic() + DAY + 1
            self.assertEqual(f.grant("p1", "1.1.1.1"), {"completed": True})

    def test_a_client_is_an_ipv4_address_or_an_ipv6_48(self):
        self.assertEqual(A.pending_owner(A.client_key("2001:db8:1:2::5")), A.pending_owner(A.client_key("2001:db8:1:ffff::9")))
        self.assertNotEqual(A.pending_owner(A.client_key("2001:db8:1::5")), A.pending_owner(A.client_key("2001:db8:2::5")))

    def test_requests_at_once_cannot_both_pass(self):
        self.outside.answer, self.outside.delay = COMPLETED, 0.3
        self.with_faucet()
        statuses = []
        threads = [threading.Thread(target=lambda: statuses.append(self.ask()[0])) for _ in range(4)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(sorted(statuses), [200, 429, 429, 429])
        self.assertEqual(len(self.outside.calls), 1)

    def test_the_wallet_gets_the_peer_check_and_no_redirect(self):
        other = FakeOutside()
        self.outside.status, self.outside.headers, self.outside.raw = 307, {"location": other.url}, b"{}"
        self.with_faucet(per_day=100)
        self.assertEqual(self.ask()[0], 502)
        self.assertEqual(other.calls, [])
        other.server.shutdown()
        self.outside.status, self.outside.raw, self.outside.answer = 200, None, COMPLETED
        self.faucet_reset()
        with unittest.mock.patch.object(A, "is_loopback_address", return_value=False):
            self.assertEqual(self.ask()[0], 502)
        self.assertEqual(len(self.outside.calls), 1)   # only the redirected try reached it

    def test_a_failure_before_anything_was_sent_gives_the_allowance_back(self):
        self.with_faucet()
        os.remove(self.bearer_file)   # the token cannot be read: nothing is sent
        self.assertEqual(self.ask()[0], 502)
        self.assertEqual(self.outside.calls, [])
        self.assertEqual([len(q) for q in (*self.service.faucet.per_account.hits.values(), *self.service.faucet.per_client.hits.values(), *self.service.faucet.total.hits.values())], [0, 0, 0])
        with open(self.bearer_file, "w") as f:
            f.write(HANDLE + "\n")
        os.chmod(self.bearer_file, 0o600)
        self.outside.answer = COMPLETED
        self.assertEqual(self.ask()[0], 200)   # the same account asks again the same day
        self.assertEqual(self.ask()[0], 429)   # and now it has had its one

    def test_a_connection_that_cannot_be_made_or_a_peer_that_is_not_this_machine_gives_it_back(self):
        self.outside.answer = COMPLETED
        self.with_faucet()
        with self.on_connect(fail=ConnectionRefusedError()):
            self.assertEqual(self.ask()[0], 502)
        with unittest.mock.patch.object(A, "is_loopback_address", return_value=False):
            self.assertEqual(self.ask()[0], 502)
        self.assertEqual(self.outside.calls, [])
        self.assertEqual(self.ask()[0], 200)   # neither of them used the day's one

    def test_a_failure_after_the_request_was_sent_keeps_the_allowance(self):
        self.with_faucet(per_day=100)
        for status, raw in ((500, b"{}"), (404, b"{}"), (200, b"not json"), (200, b'{"output": {"dummy": {}}}')):   # an answer, of any kind, may follow a transfer
            self.outside.status, self.outside.raw = status, raw
            self.faucet_reset()
            self.assertEqual(self.ask()[0], 502, (status, raw))
            self.assertEqual(self.ask()[0], 429, (status, raw))   # still counted
        self.outside.status, self.outside.raw, self.outside.delay = 200, None, 0.3   # no answer in time: unknown
        self.faucet_reset()
        with unittest.mock.patch.object(A, "OUTSIDE_DEADLINE", 0.1):
            self.assertEqual(self.ask()[0], 502)
        self.assertEqual(self.ask()[0], 429)

    def test_a_request_that_died_while_it_was_written_is_unknown_too(self):
        with unittest.mock.patch.object(A, "outside_post", side_effect=A.HttpError(502, "the validator's wallet could not be used")):
            f = A.Faucet("20.0", "https://wallet.example", self.bearer_file)
            with self.assertRaises(A.HttpError):
                f.grant("p1", "1.1.1.1")
            with self.assertRaises(A.HttpError) as e:
                f.grant("p1", "1.1.1.1")
            self.assertEqual(e.exception.status, 429)
        with unittest.mock.patch.object(A, "outside_post", side_effect=A.NotSent(502, "x")):   # and one that was not sent is given back
            f = A.Faucet("20.0", "https://wallet.example", self.bearer_file)
            for _ in range(3):
                with self.assertRaises(A.HttpError) as e:
                    f.grant("p1", "1.1.1.1")
                self.assertEqual(e.exception.status, 502)

    def test_the_faucets_limits_are_swept(self):
        self.with_faucet()
        self.service.faucet.per_account.hit("x")
        self.service.faucet.per_account.clock = lambda: time.monotonic() + DAY + 1
        self.service.sweep()
        self.assertEqual(self.service.faucet.per_account.hits, {})


class OutsideConfig(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.bearer_file = os.path.join(self.dir.name, "t")
        with open(self.bearer_file, "w") as f:
            f.write("tok\n")
        os.chmod(self.bearer_file, 0o600)

    def tearDown(self):
        self.dir.cleanup()

    def test_a_registry_is_https_or_on_this_machine(self):
        ok = A.parse_registries([f"{ADMIN}=https://validator.example/api/validator/v0/scan-proxy/", f"DSO2::1220{'aa' * 32}=http://127.0.0.1:5003", f"DSO3::1220{'bb' * 32}=http://localhost/x",
                                 f"DSO4::1220{'cc' * 32}=http://[::1]:1"], [f"{ADMIN}={self.bearer_file}"])
        self.assertEqual(ok[ADMIN], ("https://validator.example/api/validator/v0/scan-proxy", self.bearer_file))
        self.assertEqual(A.parse_registries(None, None), {})
        for bad in (f"{ADMIN}=http://validator.example/x", f"{ADMIN}=http://10.0.0.1/x", f"{ADMIN}=ftp://127.0.0.1/", f"{ADMIN}=https://u:p@validator.example/", f"{ADMIN}=https://validator.example/?a=1",
                    f"{ADMIN}=https://validator.example/#f", f"{ADMIN}=https://validator.example:99999/", f"{ADMIN}=https://", f"{ADMIN}=", "nobody=https://validator.example/",
                    f"DSO::1220{'zz' * 32}=https://v.example/"):
            with self.assertRaises(SystemExit, msg=bad):
                A.parse_registries([bad], None)
        with self.assertRaises(SystemExit):   # two registries for one admin
            A.parse_registries([f"{ADMIN}=https://a.example", f"{ADMIN}=https://b.example"], None)

    def test_a_name_under_dot_localhost_must_resolve_to_loopback_only(self):
        item = f"{ADMIN}=http://validator.localhost:5003/api"
        for found, fine in (([(2, 1, 6, "", ("127.0.0.1", 0)), (10, 1, 6, "", ("::1", 0, 0, 0))], True), ([(2, 1, 6, "", ("127.0.0.1", 0)), (2, 1, 6, "", ("10.1.2.3", 0))], False), ([], False)):
            with unittest.mock.patch.object(A.socket, "getaddrinfo", return_value=found):
                if fine:
                    self.assertIn(ADMIN, A.parse_registries([item], None))
                else:
                    with self.assertRaises(SystemExit):
                        A.parse_registries([item], None)
        with unittest.mock.patch.object(A.socket, "getaddrinfo", side_effect=OSError), self.assertRaises(SystemExit):
            A.parse_registries([item], None)

    def test_a_registry_token_needs_its_registry_and_one_token(self):
        for items in ([f"other::1220{'ee' * 32}={self.bearer_file}"], [f"{ADMIN}=/nonexistent"], [f"{ADMIN}={self.dir.name}"]):
            with self.assertRaises(SystemExit):
                A.parse_registries([f"{ADMIN}=https://v.example"], items)
        for content in ("", "a b", "a\nb"):
            with open(self.bearer_file, "w") as f:
                f.write(content)
            with self.assertRaises(SystemExit, msg=content):
                A.parse_registries([f"{ADMIN}=https://v.example"], [f"{ADMIN}={self.bearer_file}"])

    def test_a_registry_token_file_is_for_its_owner_only(self):
        item, registry = [f"{ADMIN}={self.bearer_file}"], [f"{ADMIN}=https://v.example"]
        for mode in (0o600, 0o400):
            os.chmod(self.bearer_file, mode)
            self.assertEqual(A.parse_registries(registry, item)[ADMIN][1], self.bearer_file)
        for mode in (0o644, 0o640, 0o604, 0o660, 0o606, 0o666):
            os.chmod(self.bearer_file, mode)
            with self.assertRaises(SystemExit, msg=oct(mode)) as e:
                A.parse_registries(registry, item)
            self.assertIn("readable by its owner only", str(e.exception))
            self.assertIn(self.bearer_file, str(e.exception))

    def test_the_service_does_not_start_with_a_registry_token_readable_by_others(self):
        os.chmod(self.bearer_file, 0o644)
        with unittest.mock.patch.dict(os.environ, {"LEDGER_TOKEN": "t"}), self.assertRaises(SystemExit) as e:
            A.main(["--ledger-url", "http://127.0.0.1:1", "--user-id", "u", "--state-file", os.path.join(self.dir.name, "s"), "--registry", f"{ADMIN}=https://v.example",
                    "--registry-token-file", f"{ADMIN}={self.bearer_file}"])
        self.assertIn("mode 0600", str(e.exception))

    def test_the_faucet_needs_its_options_and_a_token_file_for_its_owner_only(self):
        ok = A.faucet_from("20", "https://validator.example/api/validator/", self.bearer_file, 200)
        self.assertEqual((ok.amount, ok.url, ok.total.count), ("20.0", "https://validator.example/api/validator", 200))
        self.assertEqual(A.faucet_from("0.5", "http://127.0.0.1:1", self.bearer_file, 5).amount, "0.5")
        for amount, url, bearer_file, per_day in (("0", "https://v.example", self.bearer_file, 1), ("-1", "https://v.example", self.bearer_file, 1), ("1.00000000001", "https://v.example", self.bearer_file, 1),
                                                 ("abc", "https://v.example", self.bearer_file, 1), ("20", None, self.bearer_file, 1), ("20", "https://v.example", None, 1), ("20", "https://v.example", self.bearer_file, 0),
                                                 ("20", "http://validator.example", self.bearer_file, 1), ("20", "https://v.example", "/nonexistent", 1), ("20", "https://v.example", self.dir.name, 1)):
            with self.assertRaises(SystemExit, msg=(amount, url, bearer_file, per_day)):
                A.faucet_from(amount, url, bearer_file, per_day)
        for mode in (0o644, 0o640, 0o604, 0o660):
            os.chmod(self.bearer_file, mode)
            with self.assertRaises(SystemExit, msg=oct(mode)):
                A.faucet_from("20", "https://v.example", self.bearer_file, 200)
        os.chmod(self.bearer_file, 0o400)
        self.assertIsNotNone(A.faucet_from("20", "https://v.example", self.bearer_file, 200))


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
