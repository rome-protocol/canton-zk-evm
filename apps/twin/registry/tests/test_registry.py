import http.client, json, os, sys, tempfile, threading, unittest, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import registry as R

ADMIN = "gateway::1220aa"
TOKEN = "a" * 40
VAULT = "b" * 40
RECEIVER = "alice::1220" + "b" * 64
CHAIN_ID = 7
SYNC = "sync::1"


def rules_event(token=TOKEN, cid="rules-1", decimals=6, name="Test USD"):
    return {"contractId": cid, "templateId": "pkg:Twin.Twin:TwinRules", "createdEventBlob": "blob-" + cid,
            "createArgument": {"admin": ADMIN, "token": token, "name": name, "symbol": "TUSD", "decimals": decimals}}


class Fake:
    """A fake ledger (the JSON Ledger API reads) and a fake Ostia (eth_call), on one port each."""
    def __init__(self):
        self.chains = [{"contractId": "chain-1", "createArgument": {"gateway": ADMIN, "chainId": str(CHAIN_ID), "contracts": [
            {"contractAddress": "c" * 40, "contractKind": "Gateway"}, {"contractAddress": VAULT, "contractKind": "Vault"}]}}]
        self.set_rules([rules_event()])
        self.balance = 1_500_000
        self.rpc_calls, self.tokens_seen, self.rpc_down = [], [], False
        fake = self

        class Ledger(BaseHTTPRequestHandler):
            def reply(self, obj):
                data = json.dumps(obj).encode()
                self.send_response(200); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

            def do_GET(self):
                fake.tokens_seen.append(self.headers.get("authorization"))
                self.reply({"offset": 7})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                fake.tokens_seen.append(self.headers.get("authorization"))
                template = list(body["eventFormat"]["filtersByParty"][ADMIN]["cumulative"][0]["identifierFilter"]["TemplateFilter"]["value"].items())[0][1]
                events = fake.rules if template == R.RULES else fake.chains
                self.reply([{"contractEntry": {"JsActiveContract": {"createdEvent": e, "synchronizerId": SYNC}}} for e in events])

            def log_message(self, *a): pass

        class Rpc(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                fake.rpc_calls.append(body["params"][0])
                if fake.rpc_down:
                    self.send_response(500); self.send_header("content-length", "0"); self.end_headers(); return
                data = json.dumps({"jsonrpc": "2.0", "id": 1, "result": "0x" + format(fake.balance, "064x")}).encode()
                self.send_response(200); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

            def log_message(self, *a): pass

        self.servers = [ThreadingHTTPServer(("127.0.0.1", 0), h) for h in (Ledger, Rpc)]
        for s in self.servers:
            threading.Thread(target=lambda s=s: s.serve_forever(0.01), daemon=True).start()
        self.ledger_url, self.rpc_url = (f"http://127.0.0.1:{s.server_address[1]}" for s in self.servers)

    def set_rules(self, events, pinned=None):
        """The active TwinRules, and the chain's pins of them (every one of them unless `pinned` says which)."""
        self.rules = events
        pins = [{"twinToken": e["createArgument"]["token"], "twinDecimals": e["createArgument"]["decimals"], "twinRules": e["contractId"]}
                for e in events if pinned is None or e["contractId"] in pinned]
        self.chains[0]["createArgument"]["twins"] = pins

    def close(self):
        for s in self.servers:
            s.shutdown(); s.server_close()


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.fake = Fake()
        self.addCleanup(self.fake.close)
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.state = os.path.join(self.dir.name, "parts.jsonl")
        self.now = 1_000_000.0
        self.start()

    def start(self):
        reg = R.Registry(R.Ledger(self.fake.ledger_url, "read-token"), R.Ostia(self.fake.rpc_url), ADMIN, R.LockParts(self.state, 100, clock=lambda: self.now), CHAIN_ID, ttl=0, supply_ttl=0)
        self.registry = reg
        if getattr(self, "server", None):
            self.server.shutdown(); self.server.server_close()
        self.server = R.make_server(reg, "127.0.0.1", 0)
        threading.Thread(target=lambda s=self.server: s.serve_forever(0.01), daemon=True).start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def call(self, path, body=None, method=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data, {"content-type": "application/json"}, method=method)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def transfer_args(self, **over):
        t = {"sender": RECEIVER, "receiver": "bob::1220cc", "amount": "1.0", "instrumentId": {"admin": ADMIN, "id": "erc20:" + TOKEN}}
        return {"choiceArguments": {"expectedAdmin": ADMIN, "transfer": {**t, **over}, "extraArgs": {}}}

    def test_info_lists_the_standards(self):
        status, out = self.call("/registry/metadata/v1/info")
        self.assertEqual((status, out["adminId"]), (200, ADMIN))
        self.assertEqual(out["supportedApis"]["splice-api-token-transfer-instruction-v1"], 1)

    def test_metadata_has_the_supply_the_vault_holds(self):
        status, out = self.call("/registry/metadata/v1/instruments/erc20%3A" + TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual((out["id"], out["name"], out["symbol"], out["decimals"], out["totalSupply"]), ("erc20:" + TOKEN, "Test USD", "TUSD", 6, "1.5000000000"))
        self.assertTrue(out["totalSupplyAsOf"].endswith("Z"))
        call = self.fake.rpc_calls[-1]
        self.assertEqual((call["to"], call["data"]), ("0x" + TOKEN, "0x70a08231" + "0" * 24 + VAULT))
        self.assertEqual(set(self.fake.tokens_seen), {"Bearer read-token"})

    def test_supply_is_left_out_when_ostia_is_down(self):
        self.fake.rpc_down = True
        status, out = self.call("/registry/metadata/v1/instruments/erc20:" + TOKEN)
        self.assertEqual(status, 200)
        self.assertNotIn("totalSupply", out)

    def test_supply_follows_the_token_decimals(self):
        self.assertEqual(R.twin_amount(1, 18), "0.0000000000")   # finer than the twin's 10 places: rounded down
        self.assertEqual(R.twin_amount(10**18 + 5 * 10**8, 18), "1.0000000005")
        self.assertEqual(R.twin_amount(123, 0), "123.0000000000")

    def test_the_metadata_decimals_are_the_pinned_ones_capped_at_ten(self):
        self.fake.set_rules([rules_event(token="1" * 40, cid="r6", decimals=6), rules_event(token="2" * 40, cid="r18", decimals=18)])
        self.assertEqual(self.call("/registry/metadata/v1/instruments/erc20:" + "1" * 40)[1]["decimals"], 6)
        self.assertEqual(self.call("/registry/metadata/v1/instruments/erc20:" + "2" * 40)[1]["decimals"], 10)

    def test_list_instruments_pages(self):
        self.fake.set_rules([rules_event(token=c * 40, cid="r" + c) for c in "123"])
        status, out = self.call("/registry/metadata/v1/instruments?pageSize=2")
        self.assertEqual((status, len(out["instruments"]), out["nextPageToken"]), (200, 2, "2"))
        status, out = self.call("/registry/metadata/v1/instruments?pageSize=2&pageToken=2")
        self.assertEqual((len(out["instruments"]), "nextPageToken" in out), (1, False))

    def test_unknown_instrument_is_404(self):
        self.assertEqual(self.call("/registry/metadata/v1/instruments/erc20:" + "d" * 40)[0], 404)

    def test_transfer_factory_with_disclosed_rules(self):
        status, out = self.call("/registry/transfer-instruction/v1/transfer-factory", self.transfer_args())
        self.assertEqual(status, 200)
        self.assertEqual((out["factoryId"], out["transferKind"]), ("rules-1", "direct"))
        self.assertEqual(out["choiceContext"]["choiceContextData"], {"values": {}})
        self.assertEqual(out["choiceContext"]["disclosedContracts"], [{"templateId": "pkg:Twin.Twin:TwinRules", "contractId": "rules-1", "createdEventBlob": "blob-rules-1", "synchronizerId": SYNC}])
        self.assertEqual(self.call("/registry/transfer-instruction/v1/transfer-factory", self.transfer_args(receiver=RECEIVER))[1]["transferKind"], "self")

    def test_transfer_factory_refuses_another_admin_or_token(self):
        wrong = self.transfer_args()
        wrong["choiceArguments"]["expectedAdmin"] = "other::1"
        self.assertEqual(self.call("/registry/transfer-instruction/v1/transfer-factory", wrong)[0], 400)
        self.assertEqual(self.call("/registry/transfer-instruction/v1/transfer-factory", self.transfer_args(instrumentId={"admin": "other::1", "id": "erc20:" + TOKEN}))[0], 400)
        self.assertEqual(self.call("/registry/transfer-instruction/v1/transfer-factory", self.transfer_args(instrumentId={"admin": ADMIN, "id": "erc20:" + "d" * 40}))[0], 404)
        self.assertEqual(self.call("/registry/transfer-instruction/v1/transfer-factory", {})[0], 400)
        self.assertEqual(self.call("/registry/transfer-instruction/v1/transfer-factory", {"choiceArguments": {"expectedAdmin": ADMIN, "transfer": 5}})[0], 400)

    def test_allocation_factory(self):
        args = {"choiceArguments": {"expectedAdmin": ADMIN, "allocation": {"transferLeg": {"instrumentId": {"admin": ADMIN, "id": "erc20:" + TOKEN}}}}}
        status, out = self.call("/registry/allocation-instruction/v1/allocation-factory", args)
        self.assertEqual((status, out["factoryId"], len(out["choiceContext"]["disclosedContracts"])), (200, "rules-1", 1))
        self.assertNotIn("transferKind", out)

    def test_choice_contexts(self):
        for name in ("execute-transfer", "withdraw", "cancel"):
            status, out = self.call(f"/registry/allocations/v1/alloc-1/choice-contexts/{name}", {})
            self.assertEqual((status, out["disclosedContracts"]), (200, []))
        self.assertEqual(self.call("/registry/allocations/v1/alloc-1/choice-contexts/other", {})[0], 404)
        for name in ("accept", "reject", "withdraw"):
            self.assertEqual(self.call(f"/registry/transfer-instruction/v1/ti-1/choice-contexts/{name}", {})[0], 404)

    def test_only_the_pinned_rules_are_served(self):
        self.fake.set_rules([rules_event(cid="r1"), rules_event(cid="r2", decimals=18), rules_event(token="e" * 40, cid="r3")], pinned={"r1"})
        self.assertEqual(self.call("/registry/transfer-instruction/v1/transfer-factory", self.transfer_args())[1]["factoryId"], "r1")
        self.assertEqual([i["id"] for i in self.call("/registry/metadata/v1/instruments")[1]["instruments"]], ["erc20:" + TOKEN])
        self.assertEqual(self.call("/registry/metadata/v1/instruments/erc20:" + "e" * 40)[0], 404)   # active but not pinned
        twins = self.call("/twin/v1/twins")[1]["twins"]
        self.assertEqual([(t["rulesContractId"], t["decimals"]) for t in twins], [("r1", 6)])
        health = self.call("/healthz")[1]
        self.assertEqual((health["ok"], health["twins"], health["unpinnedRules"]), (True, 1, ["r2", "r3"]))

    def test_a_pin_whose_rules_are_not_active_serves_nothing(self):
        self.fake.set_rules([rules_event(cid="r1")])
        self.fake.rules = []
        self.assertEqual(self.call("/registry/transfer-instruction/v1/transfer-factory", self.transfer_args())[0], 404)
        self.assertEqual(self.call("/registry/metadata/v1/instruments")[1]["instruments"], [])
        health = self.call("/healthz")[1]
        self.assertEqual((health["ok"], health["pinnedWithoutRules"]), (False, [TOKEN]))

    def test_a_chain_without_pins_serves_no_twin(self):
        del self.fake.chains[0]["createArgument"]["twins"]
        self.assertEqual(self.call("/registry/metadata/v1/instruments")[1]["instruments"], [])

    def test_rules_of_another_admin_are_ignored(self):
        other = rules_event(token="e" * 40, cid="x")
        other["createArgument"]["admin"] = "other::1"
        self.fake.set_rules([rules_event(), other])
        self.assertEqual([i["id"] for i in self.call("/registry/metadata/v1/instruments")[1]["instruments"]], ["erc20:" + TOKEN])

    def test_exactly_one_chain_is_served(self):
        other = {"contractId": "chain-2", "createArgument": {**self.fake.chains[0]["createArgument"], "chainId": "8", "contracts": [{"contractAddress": "9" * 40, "contractKind": "Vault"}]}}
        self.fake.chains.append(other)
        self.assertEqual(self.call("/twin/v1/twins")[1]["vaults"], [VAULT])   # the other chain's vault is not mixed in
        self.fake.chains.append({"contractId": "chain-3", "createArgument": {**self.fake.chains[0]["createArgument"]}})   # a second record of chain 7
        self.assertEqual(self.call("/twin/v1/twins")[0], 500)
        self.assertEqual(self.call("/registry/metadata/v1/instruments")[0], 500)
        self.assertEqual(self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "r"})[0], 500)
        health = self.call("/healthz")[1]
        self.assertFalse(health["ok"])
        self.fake.chains[:] = self.fake.chains[1:2]   # no record of chain 7
        self.assertFalse(self.call("/healthz")[1]["ok"])

    def test_lock_parts_give_the_id_the_chain_makes(self):
        status, out = self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "order-1"})
        self.assertEqual(status, 200)
        # Chain.daml: lockId = sha256 "lock,<party id>,<ref>"
        import hashlib
        self.assertEqual(out["lockId"], hashlib.sha256(f"lock,{RECEIVER},order-1".encode()).hexdigest())
        self.assertEqual(out["vaults"], [VAULT])
        status, got = self.call("/twin/v1/lock-parts/" + out["lockId"])
        self.assertEqual((status, got["receiver"], got["ref"]), (200, RECEIVER, "order-1"))
        self.assertEqual(self.call("/twin/v1/lock-parts/" + "0" * 64)[0], 404)

    def test_lock_parts_survive_a_restart(self):
        lid = self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "r"})[1]["lockId"]
        self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "r"})   # the same twice: kept once
        with open(self.state) as f:
            self.assertEqual(len(f.readlines()), 1)
        self.start()
        self.assertEqual(self.call("/twin/v1/lock-parts/" + lid)[1]["ref"], "r")

    def test_lock_parts_are_checked(self):
        for body in ({}, {"receiver": RECEIVER}, {"receiver": RECEIVER, "ref": ""}, {"receiver": "alice", "ref": "r"},
                     {"receiver": "a,b::1", "ref": "r"}, {"receiver": " ::1220" + "b" * 64, "ref": "r"}, {"receiver": RECEIVER + " ", "ref": "r"},
                     {"receiver": "a::b::c", "ref": "r"}, {"receiver": "alice::1220bb", "ref": "r"}, {"receiver": "alice::1220" + "B" * 64, "ref": "r"},
                     {"receiver": RECEIVER, "ref": "\ud800"}, {"receiver": RECEIVER, "ref": "r", "token": "XYZ"}, {"receiver": RECEIVER, "ref": "x" * 300}, {"receiver": 5, "ref": "r"}, []):
            self.assertEqual(self.call("/twin/v1/lock-parts", body)[0], 400, body)

    def test_lock_parts_are_bounded(self):
        self.registry.parts.limit = 1
        self.assertEqual(self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "1"})[0], 200)
        self.assertEqual(self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "2"})[0], 503)
        self.assertEqual(self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "1"})[0], 200)   # a known one still answers

    def test_lock_parts_of_a_known_token_are_accepted(self):
        self.assertEqual(self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "r", "token": TOKEN})[0], 200)
        self.assertEqual(self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "r", "token": "d" * 40})[0], 404)   # no twin of it

    def test_lock_parts_expire_and_a_new_announcement_brings_them_back(self):
        lid = self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "old"})[1]["lockId"]
        self.now += R.LOCK_PARTS_TTL - 10
        self.assertEqual(self.call("/twin/v1/lock-parts/" + lid)[0], 200)
        self.now += 20
        self.assertEqual(self.call("/twin/v1/lock-parts/" + lid)[0], 404)
        self.assertEqual(self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "old"})[1]["lockId"], lid)   # the same id again
        self.assertEqual(self.call("/twin/v1/lock-parts/" + lid)[0], 200)

    def test_a_full_store_makes_room_by_dropping_what_expired(self):
        self.registry.parts.limit = 2
        for ref in ("1", "2"):
            self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": ref})
        self.assertEqual(self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "3"})[0], 503)
        self.now += R.LOCK_PARTS_TTL + 1
        self.assertEqual(self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "3"})[0], 200)
        with open(self.state) as f:
            self.assertEqual([json.loads(l)["ref"] for l in f], ["3"])   # the file is compacted too

    def test_a_full_store_is_swept_once_a_minute(self):
        self.registry.parts.limit = 2
        for ref in ("1", "2"):
            self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": ref})
        calls = []
        real = self.registry.parts.sweep
        self.registry.parts.sweep = lambda force=False: (calls.append(1), real(force))[1]
        for i in range(5):
            self.now += 5
            self.assertEqual(self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "x%d" % i})[0], 503)
        self.assertEqual(calls, [])   # a full store costs a lookup per request, not a scan
        self.now += 60
        self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "y"})
        self.assertEqual(len(calls), 1)

    def test_the_state_file_is_compacted_when_it_loads(self):
        old = self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "old"})[1]["lockId"]
        self.now += R.LOCK_PARTS_TTL + 1
        new = self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "new"})[1]["lockId"]
        with open(self.state, "a") as f:
            f.write(json.dumps({"lockId": old, "receiver": RECEIVER, "ref": "old", "at": self.now - R.LOCK_PARTS_TTL - 5}) + "\n")
        self.start()
        self.assertEqual((self.call("/twin/v1/lock-parts/" + old)[0], self.call("/twin/v1/lock-parts/" + new)[0]), (404, 200))
        with open(self.state) as f:
            self.assertEqual([json.loads(l)["lockId"] for l in f], [new])

    def test_a_truncated_or_tampered_state_file_still_starts(self):
        good = self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "good"})[1]["lockId"]
        with open(self.state, "a") as f:
            f.write(json.dumps({"lockId": "f" * 64, "receiver": RECEIVER, "ref": "forged", "at": self.now}) + "\n")   # not the id of its parts
            f.write(json.dumps({"lockId": good, "receiver": RECEIVER}) + "\n")   # a part missing
            f.write('{"lockId": "' + "e" * 64 + '", "recei')   # a crash in the middle of an append
        self.start()
        self.assertEqual(self.call("/twin/v1/lock-parts/" + good)[1]["ref"], "good")
        self.assertEqual(self.call("/twin/v1/lock-parts/" + "f" * 64)[0], 404)
        self.assertEqual(self.call("/twin/v1/lock-parts/" + "e" * 64)[0], 404)
        self.assertEqual(self.call("/twin/v1/lock-parts", {"receiver": RECEIVER, "ref": "after"})[0], 200)   # the file takes new lines again
        self.start()
        self.assertEqual(self.call("/twin/v1/lock-parts/" + good)[0], 200)

    def post_raw(self, length, body=b"{}"):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        conn.putrequest("POST", "/twin/v1/lock-parts")
        conn.putheader("content-length", length)
        conn.endheaders(body)
        try:
            return conn.getresponse().status
        finally:
            conn.close()

    def test_the_body_length_is_checked_before_the_body_is_read(self):
        self.assertEqual(self.post_raw("-1", b"x" * 70000), 400)
        self.assertEqual(self.post_raw("abc"), 400)
        self.assertEqual(self.post_raw("1.5"), 400)
        self.assertEqual(self.post_raw(str(R.MAX_BODY + 1), b"x" * (R.MAX_BODY + 1)), 400)
        body = json.dumps({"receiver": RECEIVER, "ref": "r"}).encode()
        self.assertEqual(self.post_raw(str(len(body)), body), 200)

    def test_page_token_is_not_negative(self):
        self.assertEqual(self.call("/registry/metadata/v1/instruments?pageToken=-1")[0], 400)
        self.assertEqual(self.call("/registry/metadata/v1/instruments?pageSize=x")[0], 400)

    def test_the_answers_carry_the_keys_of_the_standards_schemas(self):
        info = self.call("/registry/metadata/v1/info")[1]
        self.assertTrue({"adminId", "supportedApis"} <= set(info))
        listing = self.call("/registry/metadata/v1/instruments")[1]
        self.assertIn("instruments", listing)
        for inst in listing["instruments"] + [self.call("/registry/metadata/v1/instruments/erc20:" + TOKEN)[1]]:
            self.assertTrue({"id", "name", "symbol", "decimals", "supportedApis"} <= set(inst))   # Instrument (metadata 1.2.0)
            self.assertIsInstance(inst["decimals"], int)
            self.assertTrue({"totalSupply", "totalSupplyAsOf"} <= set(inst))
        for path, body in (("/registry/transfer-instruction/v1/transfer-factory", self.transfer_args()),
                           ("/registry/allocation-instruction/v1/allocation-factory",
                            {"choiceArguments": {"expectedAdmin": ADMIN, "allocation": {"transferLeg": {"instrumentId": {"admin": ADMIN, "id": "erc20:" + TOKEN}}}}})):
            out = self.call(path, body)[1]
            self.assertTrue({"factoryId", "choiceContext"} <= set(out))
            self.assertTrue({"choiceContextData", "disclosedContracts"} <= set(out["choiceContext"]))
            for d in out["choiceContext"]["disclosedContracts"]:
                self.assertTrue({"templateId", "contractId", "createdEventBlob", "synchronizerId"} <= set(d))   # DisclosedContract
        self.assertIn(self.call("/registry/transfer-instruction/v1/transfer-factory", self.transfer_args())[1]["transferKind"], ("self", "direct"))
        ctx = self.call("/registry/allocations/v1/a/choice-contexts/withdraw", {})[1]
        self.assertTrue({"choiceContextData", "disclosedContracts"} <= set(ctx))   # ChoiceContext

    def test_twins_list_for_the_builder(self):
        out = self.call("/twin/v1/twins")[1]
        self.assertEqual((out["vaults"], out["twins"][0]["token"], out["twins"][0]["rulesContractId"], out["twins"][0]["decimals"]), ([VAULT], TOKEN, "rules-1", 6))

    def test_a_ledger_failure_is_a_500_without_details(self):
        self.fake.servers[0].shutdown(); self.fake.servers[0].server_close()
        status, out = self.call("/registry/metadata/v1/info/")
        self.assertEqual(status, 404)
        status, out = self.call("/registry/metadata/v1/instruments")
        self.assertEqual((status, out), (500, {"error": "the registry could not read what it needs"}))

    def test_bad_body_and_unknown_route(self):
        req = urllib.request.Request(self.url + "/twin/v1/lock-parts", b"not json", method="POST")
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req)
        self.assertEqual(e.exception.code, 400)
        self.assertEqual(self.call("/nothing")[0], 404)
        self.assertEqual(self.call("/registry/metadata/v1/info", {})[0], 404)


if __name__ == "__main__":
    unittest.main()
