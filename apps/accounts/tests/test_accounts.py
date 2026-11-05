"""The accounts service against a fake JSON Ledger API. Run: python3 -m unittest discover -s apps/accounts/tests -v (pytest collects them too)."""
import base64, http.client, json, os, sys, tempfile, threading, unittest, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import accounts as A

KEY = base64.b64encode(bytes(range(32))).decode()
SIG = base64.b64encode(bytes(64)).decode()
FINGERPRINT = "1220" + "ab" * 32
PARTY = "bridge::" + FINGERPRINT
SYNC = "da::1220" + "cd" * 32
ACCEPT = "#canton-zk-evm:Zk.Chain:WithdrawalAcceptance"
HOLDER = "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding"


class FakeLedger:
    """Answers the endpoints the service uses, records every call, and can be told to refuse."""
    def __init__(self):
        self.calls, self.fail, self.holdings, self.tokens = [], {}, [], []
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
            return 200, {"partyId": PARTY}
        if path.endswith("/prepare"):
            return 200, {"preparedTransaction": "cHJlcGFyZWQ=", "preparedTransactionHash": "aGFzaA==", "hashingSchemeVersion": "HASHING_SCHEME_VERSION_V2"}
        if path.endswith("/executeAndWait"):
            return 200, {"updateId": "u-1", "completionOffset": 5}
        if path.endswith("/active-contracts-page"):
            pages = self.holdings
            at = int(body["pageToken"]) if body.get("pageToken") else 0
            page = pages[at] if at < len(pages) else []
            out = {"activeAtOffset": 9, "activeContracts": [{"contractEntry": {"JsActiveContract": {"createdEvent": {
                "contractId": cid, "interfaceViews": [{"interfaceId": "pkg:HoldingV1:Holding", "viewValue": {
                    "owner": PARTY, "instrumentId": {"admin": "reg::1", "id": "TKB"}, "amount": amount, "lock": None, "meta": {"values": {}}}}]}}}} for cid, amount in page]}
            if at + 1 < len(pages):
                out["nextPageToken"] = str(at + 1)
            return 200, out
        return 404, {}


class Case(unittest.TestCase):
    def setUp(self):
        self.ledger = FakeLedger()
        self.dir = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.dir.name, "accounts.jsonl")
        self.start()

    def start(self, **kw):
        if getattr(self, "http", None):
            self.http.shutdown()
        kw.setdefault("allow", A.DEFAULT_ALLOW)
        self.service = A.Accounts(A.Ledger(self.ledger.url, token="tok"), "svc", A.Parties(self.state), **kw)
        self.http = A.make_server(self.service, "127.0.0.1", 0)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.http.server_address[1]}"

    def tearDown(self):
        self.http.shutdown(); self.ledger.server.shutdown(); self.dir.cleanup()

    def req(self, method, path, body=None, headers=None, raw=None):
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        r = urllib.request.Request(self.base + path, data, headers or {}, method=method)
        try:
            with urllib.request.urlopen(r) as f:
                return f.status, json.load(f), f.headers
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.load(e), e.headers

    def make_account(self):
        _, t, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        return self.req("POST", "/accounts/v1/allocate", {"blob": t["blob"], "signature": SIG})

    def calls_to(self, suffix):
        return [c for c in self.ledger.calls if c[1].endswith(suffix)]


class TopologyAndAllocate(Case):
    def test_topology_wraps_a_raw_key_and_names_the_synchronizer(self):
        status, out, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        self.assertEqual((status, out["party"], out["exists"], out["multiHash"]), (200, PARTY, False, "bXVsdGk="))
        sent = self.calls_to("/generate-topology")[0][2]
        self.assertEqual(sent["synchronizer"], SYNC)
        self.assertEqual(sent["partyHint"], "bridge")
        self.assertEqual(base64.b64decode(sent["publicKey"]["keyData"]), A.SPKI_ED25519 + bytes(range(32)))
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
        self.assertEqual(sent["multiHashSignatures"], [{"format": "SIGNATURE_FORMAT_RAW", "signature": SIG, "signedBy": FINGERPRINT,
                                                         "signingAlgorithmSpec": "SIGNING_ALGORITHM_SPEC_ED25519"}])
        self.assertEqual((sent["userId"], sent["synchronizer"]), ("svc", SYNC))
        self.assertEqual(self.calls_to("/rights"), [])   # no separate grant: the service's user has no admin right

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
        status, out, _ = self.req("POST", "/accounts/v1/allocate", {"blob": t["blob"], "signature": SIG})
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
        _, t2, _ = self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        self.assertEqual(self.req("POST", "/accounts/v1/allocate", {"blob": t1["blob"], "signature": SIG})[0], 200)
        status, out, headers = self.req("POST", "/accounts/v1/allocate", {"blob": t2["blob"], "signature": SIG})
        self.assertEqual(status, 429)
        self.assertTrue(int(headers["retry-after"]) > 0)


class PrepareAndExecute(Case):
    def command(self, template=ACCEPT, kind="CreateCommand", **more):
        return {"party": PARTY, "commands": [{kind: {"templateId": template, "createArguments": {}, **more}}]}

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
        self.assertEqual(self.ledger.calls, [])

    def test_execute_sends_the_signature_and_returns_the_update_id(self):
        self.make_account()
        _, p, _ = self.req("POST", "/accounts/v1/prepare", self.command())
        body = {"preparedTransaction": p["preparedTransaction"], "partySignatures": [{"party": PARTY, "signature": SIG}]}
        status, out, _ = self.req("POST", "/accounts/v1/execute", body)
        self.assertEqual((status, out), (200, {"updateId": "u-1"}))
        sent = self.calls_to("/executeAndWait")[0][2]
        self.assertEqual(sent["hashingSchemeVersion"], "HASHING_SCHEME_VERSION_V2")
        self.assertEqual(sent["partySignatures"]["signatures"], [{"party": PARTY, "signatures": [{
            "format": "SIGNATURE_FORMAT_RAW", "signature": SIG, "signedBy": FINGERPRINT, "signingAlgorithmSpec": "SIGNING_ALGORITHM_SPEC_ED25519"}]}])
        self.assertEqual(self.req("POST", "/accounts/v1/execute", body)[0], 404)   # once

    def test_a_transaction_this_service_did_not_prepare_is_not_executed(self):
        self.make_account()
        body = {"preparedTransaction": "b3RoZXI=", "partySignatures": [{"party": PARTY, "signature": SIG}]}
        self.assertEqual(self.req("POST", "/accounts/v1/execute", body)[0], 404)
        self.assertEqual(self.calls_to("/executeAndWait"), [])

    def test_a_prepared_transaction_expires(self):
        now = [0.0]
        self.start(pending=A.Pending(ttl=10, clock=lambda: now[0]))
        self.make_account()
        _, p, _ = self.req("POST", "/accounts/v1/prepare", self.command())
        now[0] = 11
        body = {"preparedTransaction": p["preparedTransaction"], "partySignatures": [{"party": PARTY, "signature": SIG}]}
        self.assertEqual(self.req("POST", "/accounts/v1/execute", body)[0], 404)


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

    def test_no_holdings_is_an_empty_list(self):
        self.make_account()
        self.assertEqual(self.req("GET", f"/accounts/v1/holdings/{PARTY}")[1], {"party": PARTY, "holdings": []})


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
        for token in ("one", "two"):
            with open(path, "w") as f:
                f.write(token + "\n")
            self.req("POST", "/accounts/v1/topology", {"publicKey": KEY})
        self.assertEqual(self.ledger.tokens[-3:], ["Bearer one", "Bearer one", "Bearer two"])   # the first topology also asked for the synchronizer


class Config(unittest.TestCase):
    def test_the_built_in_list_is_well_formed(self):
        self.assertTrue(all(A.ALLOW_ENTRY.match(e) for e in A.DEFAULT_ALLOW))


if __name__ == "__main__":
    unittest.main()
