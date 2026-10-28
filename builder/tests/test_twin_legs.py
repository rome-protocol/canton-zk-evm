"""The twin legs (Daml 0.5.0): a payment into a registered vault is a LockLeg, with the parts of the lock's id from the twin registry service; a payment
whose id is the release id of a redeem request is a ReleaseLeg. Both name the twin pinned for the token in `ZkChain.twins`. Against the same fakes as
test_builder.py, and a fake registry service."""
import hashlib, json, sys, threading, time, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from test_legs_limits import at, quota
from fakes import PAYMENT, Leg, tx

ALICE, TKA, PAYEE, named = tb.ALICE, tb.TKA, tb.PAYEE, tb.named
VAULT, OTHER_VAULT = "ca" * 20, "cb" * 20
RECEIVER, REF = "alice::1220" + "ab" * 32, "order-7"
RULES = "rules-1"
USDC_DECIMALS = 6


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


LOCK_ID = sha(f"lock,{RECEIVER},{REF}")
RELEASE_ID = sha(f"vault-release,{VAULT},{REF}")
VAULT_ENTRY = {"contractAddress": VAULT, "contractCodeHash": "c1" * 32, "contractKind": "Vault"}
PIN = {"twinToken": TKA, "twinDecimals": str(USDC_DECIMALS), "twinRules": RULES}
LOCK = Leg(PAYMENT, LOCK_ID, TKA, VAULT, 2_500_000)   # 2.5 of a 6-decimal token
RELEASE = Leg(PAYMENT, RELEASE_ID, TKA, PAYEE, 2_500_000)
REDEEM = ("redeem-1", {**named, "gateway": "gw", "holder": RECEIVER, "token": TKA, "holdings": ["th-1"], "amount": "2.5", "recipient": PAYEE, "ref": REF})


TWIN = {"admin": "gw", "id": "erc20:" + TKA}
HOLDING = tb.holding("th-1", "2.5", instrument=TWIN, owner=RECEIVER)
RULES_ARGS = (RULES, {"admin": "gw", "token": TKA, "decimals": str(USDC_DECIMALS), "name": "USD Coin", "symbol": "USDC"})
REF2 = "order-8"
RELEASE2 = Leg(PAYMENT, sha(f"vault-release,{VAULT},{REF2}"), TKA, PAYEE, 2_500_000)
REDEEM2 = ("redeem-2", {**REDEEM[1], "holdings": ["th-2"], "ref": REF2})
HOLDING2 = tb.holding("th-2", "2.5", instrument=TWIN, owner=RECEIVER)
QUOTA_NAME = f"gw/erc20:{TKA}"


class Registry:
    """A fake twin registry service: GET /twin/v1/lock-parts/<id>."""

    def __init__(self, parts=None, status=None, raw=None, delay=0, trickle=False):
        self.parts, self.status, self.asked = dict(parts or {}), status, []
        self.raw, self.delay, self.trickle = raw, delay, trickle   # raw: bytes to answer with; delay: seconds before the answer; trickle: a body that never ends
        registry = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def do_GET(self):
                registry.asked.append(self.path)
                lock_id = self.path.rsplit("/", 1)[1]
                time.sleep(registry.delay)
                if registry.trickle == "headers":   # the status line, then a byte now and then, and the headers never end
                    try:
                        self.wfile.write(b"HTTP/1.1 200 OK\r\n"); self.wfile.flush()
                        for _ in range(100):
                            self.wfile.write(b"x"); self.wfile.flush(); time.sleep(0.1)
                    except OSError:
                        pass
                    return
                if registry.trickle:
                    self.send_response(200)
                    self.send_header("content-length", "100000")
                    self.end_headers()
                    try:
                        for _ in range(100):
                            self.wfile.write(b" "); self.wfile.flush(); time.sleep(0.1)
                    except OSError:
                        pass
                    return
                if registry.raw is not None:
                    code, body = 200, registry.raw
                elif registry.status:
                    code, body = registry.status, b"{}"
                elif lock_id in registry.parts:
                    code, body = 200, json.dumps({"lockId": lock_id, **registry.parts[lock_id]}).encode()
                else:
                    code, body = 404, b"{}"
                try:
                    self.send_response(code)
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except OSError:   # the builder hung up: it has read what it will
                    pass
        self.server = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown(); self.server.server_close()


class Twins(tb.LegCase):
    def setUp(self):
        super().setUp()
        b.REGISTRY_DOWN.clear()

    def setup_twin(self, leg, parts=True, pins=(PIN,), vaults=(VAULT_ENTRY,), redeems=(), registry=True, holdings=(HOLDING,), rules=(RULES_ARGS,), quota=None, **k):
        s = self.setup({ALICE: []}, **k)
        s.ledger.chain_extra = {"contracts": list(vaults), "twins": list(pins) if pins is not None else None, **(quota or {})}
        s.ledger.redeems = list(redeems)
        s.ledger.holdings = list(holdings)
        s.ledger.twin_rules = list(rules)
        t = self.leg_tx(s, leg)
        s.reth.pool[ALICE] = [t]
        if registry:
            s.registry = Registry({LOCK_ID: {"receiver": RECEIVER, "ref": REF}} if parts is True else parts or {})
            self.addCleanup(s.registry.close)
            s.cfg.twin_registry_url = s.registry.url
        return s, t

    # ---- the lock
    def test_a_payment_into_a_vault_is_a_lock_naming_the_pinned_rules(self):
        s, t = self.setup_twin(LOCK)
        result = self.build(s)
        self.assertEqual(self.attached(s, "LockLeg"), {"lockRules": RULES, "lockReceiver": RECEIVER, "lockRef": REF, "lockVault": VAULT, "lockAmount": f"{2_500_000:064x}"})
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))
        self.assertEqual(s.registry.asked, [f"/twin/v1/lock-parts/{LOCK_ID}"])

    def test_a_lock_the_registry_has_no_parts_for_is_left_out(self):
        s, t = self.setup_twin(LOCK, parts={})
        self.assert_left_out(s, t, "no parts")

    def test_parts_that_do_not_make_the_id_leave_the_lock_out(self):
        s, t = self.setup_twin(LOCK, parts={LOCK_ID: {"receiver": "bob::1220" + "cd" * 32, "ref": REF}})
        self.assert_left_out(s, t, "do not make the lock's id")

    def test_a_failing_registry_leaves_the_lock_out(self):
        s, t = self.setup_twin(LOCK)
        s.registry.status = 500
        self.assert_left_out(s, t, "HTTP 500")

    def test_an_unreachable_registry_leaves_the_lock_out(self):
        s, t = self.setup_twin(LOCK)
        s.cfg.twin_registry_url = "http://127.0.0.1:1"
        self.assert_left_out(s, t, "cannot be read")

    def test_a_builder_with_no_registry_leaves_the_lock_out(self):
        s, t = self.setup_twin(LOCK, registry=False)
        self.assert_left_out(s, t, "no twin registry")

    def test_a_lock_of_an_unpinned_token_is_left_out(self):
        for pins in (None, [], [{**PIN, "twinToken": "44" * 20}]):
            s, t = self.setup_twin(LOCK, pins=pins)
            self.assert_left_out(s, t, "not pinned")

    def test_a_lock_finer_than_the_twin_is_left_out(self):
        s, t = self.setup_twin(LOCK, pins=[{**PIN, "twinDecimals": "18"}], rules=[(RULES, {**RULES_ARGS[1], "decimals": "18"})])   # 2_500_000 base units of 18 decimals: not a multiple of 10^8
        self.assert_left_out(s, t, "not exact")

    def test_an_18_decimal_lock_that_is_a_multiple_is_attached(self):
        s, t = self.setup_twin(Leg(PAYMENT, LOCK_ID, TKA, VAULT, 3 * 10**18), pins=[{**PIN, "twinDecimals": "18"}], rules=[(RULES, {**RULES_ARGS[1], "decimals": "18"})])
        self.build(s)
        self.assertEqual(self.attached(s, "LockLeg")["lockAmount"], f"{3 * 10**18:064x}")

    def test_a_payment_to_another_address_is_not_a_lock(self):
        s, t = self.setup_twin(Leg(PAYMENT, LOCK_ID, TKA, OTHER_VAULT, 10))
        self.assert_left_out(s, t, "no terms of this chain")

    def test_a_receiver_that_is_not_a_party_id_is_left_out(self):
        for bad in ("\u00e9::1220" + "ab" * 32, "alice::1220" + "AB" * 32, "alice::1220abcd", "a b::1220" + "ab" * 32, "x" * 250 + "::1220" + "ab" * 32):
            s, t = self.setup_twin(LOCK, parts={LOCK_ID: {"receiver": bad, "ref": REF}})
            self.assert_left_out(s, t, "not the parts")

    def test_a_receiver_the_participant_does_not_know_is_left_out(self):
        s, t = self.setup_twin(LOCK)
        s.ledger.known_parties = set()
        self.assert_left_out(s, t, "not a known Canton party")

    def test_a_known_receiver_is_attached_and_asked_once_a_block(self):
        s, t = self.setup_twin(LOCK)
        s.ledger.known_parties = {RECEIVER}
        self.build(s)
        self.assertEqual(self.attached(s, "LockLeg")["lockReceiver"], RECEIVER)
        self.assertEqual([g for g in s.ledger.gets if g.startswith("/v2/parties/")], ["/v2/parties/" + RECEIVER.replace(":", "%3A")])

    def test_a_participant_that_cannot_answer_for_the_receiver_leaves_the_lock_out(self):
        s, t = self.setup_twin(LOCK)
        s.ledger.get_failures = {"/v2/parties/": 500}
        self.assert_left_out(s, t, "cannot say whether")

    def test_a_hostile_registry_answer_leaves_the_lock_out_and_never_stops_the_block(self):
        good = {"receiver": RECEIVER, "ref": REF}
        for raw in (json.dumps({**good, "ref": "\ud800"}).encode(), json.dumps({**good, "ref": "r" * 257}).encode(), json.dumps({**good, "ref": ""}).encode(),
                    b'{"receiver":"' + RECEIVER.encode() + b'","ref":"' + b"a" * 70000 + b'"}', b"[1]", b"\xff\xfe", json.dumps({**good, "receiver": 5}).encode(),
                    b"[" * 10000 + b"]" * 10000, b'{"a":' * 10000 + b"1" + b"}" * 10000, b"[" * 70000,   # nested deeper than the parser's stack
                    b'{"receiver":"\xc3\x28","ref":"r"}', b'{"receiver":"\xed\xa0\x80","ref":"r"}',   # bytes that are no UTF-8
                    b" " * (5 * 1024 * 1024) + b"{}"):   # far past the cap
            s, t = self.setup_twin(LOCK)
            s.registry.raw = raw
            self.assert_left_out(s, t, "not the parts of a lock's id")

    def test_a_hanging_registry_is_asked_once_for_every_lock_waiting(self):
        registry = Registry(delay=1.5)
        self.addCleanup(registry.close)
        read = b.twin_registry_reader(registry.url, timeout=0.2, deadline=0.2)
        for lock_id in ("aa" * 32, "bb" * 32):
            with self.assertRaises(b.NoCantonSide) as e:
                read(lock_id)
            self.assertIn("cannot be read", str(e.exception))
        self.assertEqual(len(registry.asked), 1)
        # a reader made for the next block keeps off the registry too, until the backoff has passed
        with self.assertRaises(b.NoCantonSide):
            b.twin_registry_reader(registry.url, timeout=0.2, deadline=0.2)("cc" * 32)
        self.assertEqual(len(registry.asked), 1)
        b.REGISTRY_DOWN[registry.url] = (time.monotonic() - 1, "")
        with self.assertRaises(b.NoCantonSide):
            b.twin_registry_reader(registry.url, timeout=0.2, deadline=0.2)("dd" * 32)
        for _ in range(40):   # the registry handles one request at a time: the first is still being answered
            if len(registry.asked) == 2:
                break
            time.sleep(0.1)
        self.assertEqual(len(registry.asked), 2)

    def test_a_registry_that_trickles_its_answer_is_given_up_on_at_the_deadline(self):
        registry = Registry(trickle=True)
        self.addCleanup(registry.close)
        started = time.monotonic()
        with self.assertRaises(b.NoCantonSide) as e:
            b.twin_registry_reader(registry.url, timeout=5, deadline=0.5)("aa" * 32)
        self.assertLess(time.monotonic() - started, 3)
        self.assertIn("cannot be read", str(e.exception))

    def test_a_registry_that_trickles_its_status_line_and_headers_is_given_up_on_at_the_deadline(self):
        registry = Registry(trickle="headers")
        self.addCleanup(registry.close)
        started = time.monotonic()
        with self.assertRaises(b.NoCantonSide) as e:
            b.twin_registry_reader(registry.url, timeout=5, deadline=0.5)("aa" * 32)
        self.assertLess(time.monotonic() - started, 3)
        self.assertIn("cannot be read", str(e.exception))

    def test_a_registry_that_is_slow_for_every_lock_costs_the_block_one_budget(self):
        registry = Registry(delay=0.3)
        self.addCleanup(registry.close)
        read = b.twin_registry_reader(registry.url, timeout=5, deadline=1, budget=0.5)
        started = time.monotonic()
        self.assertIsNone(read("aa" * 32))   # 404, after 0.3 s
        for lock_id in ("bb" * 32, "cc" * 32, "dd" * 32):   # the second is cut at the budget's end, the rest are not asked
            with self.assertRaises(b.NoCantonSide):
                read(lock_id)
        self.assertLess(time.monotonic() - started, 0.9)
        self.assertEqual(len(registry.asked), 2)

    def test_a_parser_that_runs_out_of_stack_leaves_the_lock_out(self):   # a 10,000-deep array parses on Python 3.14 and not on 3.12: make the failure certain
        registry = Registry(raw=b"[1]")
        self.addCleanup(registry.close)
        def deep(raw):
            raise RecursionError("maximum recursion depth exceeded")
        original, b.json.loads = b.json.loads, deep
        try:
            with self.assertRaises(b.NoCantonSide) as e:
                b.twin_registry_reader(registry.url)("aa" * 32)
        finally:
            b.json.loads = original
        self.assertIn("not the parts of a lock's id", str(e.exception))

    def test_a_registry_that_answers_with_a_redirect_is_not_followed(self):
        registry = Registry(status=302)
        self.addCleanup(registry.close)
        with self.assertRaises(b.NoCantonSide) as e:
            b.twin_registry_reader(registry.url)("aa" * 32)
        self.assertIn("HTTP 302", str(e.exception))

    def test_a_lock_is_exact_in_what_daml_accepts(self):
        self.assertIsNone(b.twin_units(10**36, 24))
        self.assertEqual(b.twin_units(10**35, 24), 10**21)
        self.assertEqual(b.twin_units(10**36 - 10**26, 36), 10**10 - 1)
        self.assertIsNone(b.twin_units(10**27, 10))
        self.assertEqual(b.twin_units(10**27 - 1, 10), 10**27 - 1)

    def test_a_release_is_exact_in_what_daml_accepts(self):
        self.assertIsNone(b.twin_base_units(10**27, 6))   # 10^17 whole twin units or more
        self.assertEqual(b.twin_base_units(10**27 - 10**4, 6), 10**23 - 1)
        self.assertIsNone(b.twin_base_units(10**22, 24))   # 10^36 base units or more
        self.assertEqual(b.twin_base_units(10**22 - 1, 24), (10**22 - 1) * 10**14)
        self.assertIsNone(b.twin_base_units(-1, 6))

    # ---- the release
    def test_a_vault_payment_with_a_redeem_request_is_a_release(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM])
        result = self.build(s)
        self.assertEqual(self.attached(s, "ReleaseLeg"), {"releaseRequest": "redeem-1", "releaseRules": RULES, "releaseVault": VAULT})
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))

    def test_a_release_with_no_request_is_left_out(self):
        s, t = self.setup_twin(RELEASE)
        self.assert_left_out(s, t, "no terms of this chain")

    def test_a_release_whose_request_differs_is_left_out(self):
        for field, value, words in (("token", "55" * 20, "another token"), ("recipient", "dd" * 20, "another recipient"), ("amount", "2.4", "amount"),
                                    ("operator", "other-op", "no terms")):
            s, t = self.setup_twin(RELEASE, redeems=[(REDEEM[0], {**REDEEM[1], field: value})])
            self.assert_left_out(s, t, words)

    def test_a_release_of_an_unpinned_token_is_left_out(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM], pins=None)
        self.assert_left_out(s, t, "not pinned")

    def test_the_second_release_of_one_request_is_left_out(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM])
        t2 = self.leg_tx(s, RELEASE, nonce=0, sender=tb.BOB)
        s.reth.pool[tb.BOB] = [t2]
        result = self.build(s)
        self.assertEqual(result["legs"], 1)
        self.assertEqual(len(result["leftOut"]), 1)

    def test_a_participant_without_the_redeem_template_leaves_the_release_out(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM])
        s.ledger.no_040 = True
        self.assert_left_out(s, t, "no terms of this chain")

    # ---- what Canton would refuse is not proven
    def test_a_release_whose_holdings_are_not_all_the_holders_unlocked_twin_is_left_out(self):
        lock = {"holders": ["x"], "expiresAt": None, "expiresAfter": None, "context": None}
        for holdings, words in (([], "not active, or not visible"),
                                ([tb.holding("th-1", "2.5", instrument=TWIN, owner="someone")], "not the holder's unlocked twin"),
                                ([tb.holding("th-1", "2.5", instrument={"admin": "gw", "id": "erc20:" + "55" * 20}, owner=RECEIVER)], "not the holder's unlocked twin"),
                                ([tb.holding("th-1", "2.5", instrument=TWIN, owner=RECEIVER, lock=lock)], "not the holder's unlocked twin"),
                                ([tb.holding("th-1", "2.4", instrument=TWIN, owner=RECEIVER)], "less than its amount"),
                                ([tb.holding("th-1", "2.5", instrument=TWIN, owner=RECEIVER)], None)):
            s, t = self.setup_twin(RELEASE, redeems=[REDEEM], holdings=holdings)
            if words is None:
                self.build(s)
                self.assertEqual(self.attached(s, "ReleaseLeg")["releaseRequest"], "redeem-1")
            else:
                self.assert_left_out(s, t, words)

    def test_a_release_whose_holdings_add_up_is_attached(self):
        s, t = self.setup_twin(RELEASE, redeems=[(REDEEM[0], {**REDEEM[1], "holdings": ["th-1", "th-2"]})],
                               holdings=[tb.holding("th-1", "1.0", instrument=TWIN, owner=RECEIVER), tb.holding("th-2", "1.5", instrument=TWIN, owner=RECEIVER)])
        self.build(s)
        self.attached(s, "ReleaseLeg")

    def test_a_release_that_lists_a_holding_twice_is_left_out(self):
        s, t = self.setup_twin(RELEASE, redeems=[(REDEEM[0], {**REDEEM[1], "holdings": ["th-1", "th-1"]})])
        self.assert_left_out(s, t, "lists no holdings, or one twice")

    def test_a_request_with_no_holdings_is_left_out(self):
        s, t = self.setup_twin(RELEASE, redeems=[(REDEEM[0], {**REDEEM[1], "holdings": []})])
        self.assert_left_out(s, t, "lists no holdings")

    def test_a_bogus_request_ahead_of_a_good_one_does_not_block_it(self):
        bogus = ("redeem-0", {**REDEEM[1], "holdings": ["ghost"], "holder": "mallory"})   # the same ref, token, recipient and amount, holdings that are not there
        s, t = self.setup_twin(RELEASE, redeems=[bogus, REDEEM])
        result = self.build(s)
        self.assertEqual(self.attached(s, "ReleaseLeg")["releaseRequest"], "redeem-1")
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))

    def test_two_requests_that_share_a_holding_are_not_both_in_a_block(self):
        shared = (REDEEM2[0], {**REDEEM2[1], "holdings": ["th-1"]})
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM, shared], holdings=[HOLDING])
        t2 = self.leg_tx(s, RELEASE2, nonce=0, sender=tb.BOB)
        s.reth.pool[tb.BOB] = [t2]
        result = self.build(s)
        self.assertEqual(self.attached(s, "ReleaseLeg")["releaseRequest"], "redeem-1")
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [t2["hash"]])
        self.assertIn("same holding", result["leftOut"][0]["reason"])

    def test_two_requests_with_their_own_holdings_both_go_in(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM, REDEEM2], holdings=[HOLDING, HOLDING2])
        t2 = self.leg_tx(s, RELEASE2, nonce=0, sender=tb.BOB)
        s.reth.pool[tb.BOB] = [t2]
        result = self.build(s)
        self.assertEqual((result["legs"], result["leftOut"]), (2, []))

    def test_a_release_over_the_withdrawal_quota_is_left_out(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM], quota=quota("2.0"))
        self.assert_left_out(s, t, "over the whole withdrawal quota")

    def test_a_release_within_the_quota_is_attached(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM], quota=quota("2.5"))
        self.build(s)
        self.attached(s, "ReleaseLeg")

    def test_a_release_that_the_quota_used_up_is_left_out_with_the_time(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM], quota=quota("5.0", [(QUOTA_NAME, at(3600), "3.0")]))
        self.assert_left_out(s, t, "used up until")

    def test_two_releases_that_each_fit_the_quota_alone_but_not_together(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM, REDEEM2], holdings=[HOLDING, HOLDING2], quota=quota("4.0"))
        t2 = self.leg_tx(s, RELEASE2, nonce=0, sender=tb.BOB)
        s.reth.pool[tb.BOB] = [t2]
        result = self.build(s)
        self.assertEqual(self.attached(s, "ReleaseLeg")["releaseRequest"], "redeem-1")
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [t2["hash"]])
        self.assertIn("withdrawal quota", result["leftOut"][0]["reason"])

    def test_a_release_with_no_quota_on_the_chain_is_not_held_to_one(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM], quota={"withdrawalQuota": None, "quotaWindow": None})
        self.build(s)
        self.attached(s, "ReleaseLeg")

    # ---- the pinned rules
    def test_a_token_whose_pinned_rules_are_archived_is_left_out(self):
        for kind, kw in (("lock", dict(leg=LOCK)), ("release", dict(leg=RELEASE, redeems=[REDEEM]))):
            s, t = self.setup_twin(rules=[], **kw)
            self.assert_left_out(s, t, "TwinRules is not active")

    def test_pinned_rules_that_are_not_the_pin_are_left_out(self):
        for args in ({**RULES_ARGS[1], "admin": "other"}, {**RULES_ARGS[1], "token": "55" * 20}, {**RULES_ARGS[1], "decimals": "18"}):
            s, t = self.setup_twin(LOCK, rules=[(RULES, args)])
            self.assert_left_out(s, t, "not the admin, token and decimals")

    def test_rules_other_than_the_pinned_are_no_use(self):
        s, t = self.setup_twin(LOCK, rules=[("rules-2", RULES_ARGS[1])])
        self.assert_left_out(s, t, "TwinRules is not active")

    def test_rules_that_are_only_disclosed_to_the_builder_are_used(self):
        s, t = self.setup_twin(LOCK, rules=[])
        s.cfg.disclosed = [{"templateId": "pkg:Twin.Twin:TwinRules", "contractId": RULES, "createdEventBlob": "beef", "synchronizerId": "sync::1"}]
        self.build(s)
        self.attached(s, "LockLeg")

    # ---- a release to a registered vault
    def test_a_release_whose_recipient_is_another_registered_vault_is_attached(self):
        to_vault = Leg(PAYMENT, RELEASE_ID, TKA, OTHER_VAULT, 2_500_000)
        s, t = self.setup_twin(to_vault, redeems=[(REDEEM[0], {**REDEEM[1], "recipient": OTHER_VAULT})],
                               vaults=[VAULT_ENTRY, {**VAULT_ENTRY, "contractAddress": OTHER_VAULT, "contractCodeHash": "c2" * 32}])
        self.build(s)
        self.assertEqual(self.attached(s, "ReleaseLeg")["releaseRequest"], "redeem-1")

    # ---- the readers
    def test_the_amount_conversions_are_exact(self):
        self.assertEqual(b.twin_units(2_500_000, 6), 25_000_000_000)
        self.assertEqual(b.twin_units(10**8, 18), 1)
        self.assertIsNone(b.twin_units(10**8 + 1, 18))
        self.assertIsNone(b.twin_units(0, 6))
        self.assertEqual(b.twin_base_units(25_000_000_000, 6), 2_500_000)
        self.assertEqual(b.twin_base_units(1, 18), 10**8)
        self.assertIsNone(b.twin_base_units(25_000_000_001, 6))

    def test_pinned_twins_reads_the_record_and_refuses_a_bad_entry(self):
        self.assertEqual(b.pinned_twins({}), {})
        self.assertEqual(b.pinned_twins({"twins": [PIN]}), {TKA: (RULES, 6)})
        for bad in ({"twinToken": "xx"}, {**PIN, "twinDecimals": "37"}, {**PIN, "twinRules": ""}):
            with self.assertRaises(b.BuilderError):
                b.pinned_twins({"twins": [bad]})


if __name__ == "__main__":
    unittest.main()
