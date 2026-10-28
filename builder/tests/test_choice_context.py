"""The token registry's choice context (Daml 0.5.0): a deposit, withdrawal, payment or trade leg of an instrument whose registry the builder is given
(`--registry ADMIN=URL`) carries the registry's context for its choice, and the contracts the context names go with the Advance as disclosed contracts.
The registry is a fake CIP-0056 off-ledger service; the tests run against test_builder.py's fake ledger."""
import contextlib, http.client, io, json, sys, tempfile, threading, time, unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from fakes import PAYMENT, Leg
from test_builder import ALICE, BOB, DEP, PAY, PAY_ID, PAYEE, REQUEST, TERMS, TKA, TOKEN, TRADE, TRADE_PAY, WD, WD_ID, holding, ACCEPTANCE

ADMIN = "adm::1220" + "ab" * 32
TERMS_ADMIN = "a"   # the fake ledger's allocation of terms is of the instrument {"admin": "a", "id": "T"}; the others' is {"admin": "adm", ...}
TOKEN_ADMIN = "adm"
def cid(n: int, suffix: str = "ca11") -> str:
    """A contract id as Daml writes one (V1): "00", a 32-byte discriminator, a suffix; lowercase hex."""
    return "00" + ("%02x" % n) * 32 + suffix


PACKAGE = "e1" * 32   # a package id: 64 hex digits
VALUES = {"values": {"amulet-rules": {"tag": "AV_ContractId", "value": cid(0xab)}, "open-round": {"tag": "AV_ContractId", "value": cid(0xcd)}}}
ROUND = {"templateId": PACKAGE + ":Splice.Round:OpenMiningRound", "contractId": cid(0x11), "createdEventBlob": "CgMyLjES" + "QUJD" * 20, "synchronizerId": "sync::1"}
RULES = {"templateId": "#splice-amulet:Splice.AmuletRules:AmuletRules", "contractId": cid(0x22), "createdEventBlob": "CgMyLjES" + "REVG" * 20, "synchronizerId": "sync::1"}
ANSWER = {"choiceContextData": VALUES, "disclosedContracts": [ROUND, RULES]}
FACTORY = {"factoryId": "fac-1", "transferKind": "direct", "choiceContext": ANSWER}


class Registry:
    """A fake token registry: POST /registry/allocations/v1/<id>/choice-contexts/execute-transfer and POST /registry/transfer-instruction/v1/transfer-factory."""

    def __init__(self, answer=None, status=200, raw=None, delay=0, location=None, prefix="", by_path=None):
        self.answer, self.status, self.raw, self.delay, self.location, self.by_path = answer, status, raw, delay, location, by_path or {}
        self.asked = []   # (path, the JSON body, the authorization header)
        registry = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length", 0)))
                registry.asked.append((self.path, json.loads(body), self.headers.get("authorization")))
                time.sleep(registry.delay)
                answer = registry.by_path.get(self.path, registry.answer)
                data = registry.raw if registry.raw is not None else json.dumps(answer).encode()
                try:
                    self.send_response(registry.status)
                    if registry.location:
                        self.send_header("location", registry.location)
                    self.send_header("content-length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass
        self.server = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_port}{prefix}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown(); self.server.server_close()


class Odd(Exception):
    """What a registry's answer can do to the code that reads it: an error whose own text cannot be made."""
    def __str__(self):
        raise RecursionError("maximum recursion depth exceeded")


class Bomb:
    """A value from a registry whose str() raises."""
    def __str__(self):
        raise RecursionError("maximum recursion depth exceeded")
    __repr__ = __str__


class Contexts(tb.LegCase):
    def setUp(self):
        super().setUp()
        b.REGISTRY_DOWN.clear()

    def registry(self, s, admin, **k):
        r = Registry(**k)
        self.addCleanup(r.close)
        s.cfg.registries = {**s.cfg.registries, admin: r.url}
        return r

    def pay(self, **k):
        s = self.setup({ALICE: []}, terms=[TERMS])
        t = self.leg_tx(s, PAY)
        s.reth.pool[ALICE] = [t]
        return s, t

    def disclosed(self, s):
        return s.ledger.submitted[0].get("disclosedContracts")

    def test_a_payment_gets_its_allocations_context_and_the_contracts_it_names_are_disclosed(self):
        s, t = self.pay()
        r = self.registry(s, TERMS_ADMIN, answer=ANSWER)
        result = self.build(s)
        self.assertEqual(self.attached(s, "PaymentLeg"), {"terms": "terms-1", "choiceContext": VALUES})
        self.assertEqual(r.asked, [("/registry/allocations/v1/alloc-1/choice-contexts/execute-transfer", {"meta": {}, "excludeDebugFields": True}, None)])
        self.assertEqual(self.disclosed(s), [ROUND, RULES])
        self.assertEqual((result["legs"], result["leftOut"], len(s.builds())), (1, [], 1))

    def test_a_registry_under_a_path_keeps_it(self):
        s, t = self.pay()
        r = self.registry(s, TERMS_ADMIN, answer=ANSWER, prefix="/api/validator/v0/scan-proxy/")
        self.build(s)
        self.assertEqual([a[0] for a in r.asked], ["/api/validator/v0/scan-proxy/registry/allocations/v1/alloc-1/choice-contexts/execute-transfer"])

    def test_an_instrument_with_no_registry_gets_no_context_and_no_request(self):
        s, t = self.pay()
        r = self.registry(s, "other::1220" + "cd" * 32, answer=ANSWER)
        self.build(s)
        self.assertEqual(self.attached(s, "PaymentLeg"), {"terms": "terms-1"})
        self.assertEqual((r.asked, self.disclosed(s)), ([], None))

    def test_a_registry_with_an_empty_context_leaves_the_field_out_and_discloses_what_it_names(self):
        s, t = self.pay()
        self.registry(s, TERMS_ADMIN, answer={"choiceContextData": {"values": {}}, "disclosedContracts": [ROUND]})
        self.build(s)
        self.assertEqual(self.attached(s, "PaymentLeg"), {"terms": "terms-1"})
        self.assertEqual(self.disclosed(s), [ROUND])

    def test_a_deposit_gets_its_allocations_context(self):
        s = self.setup({ALICE: []})
        s.ledger.requests, s.ledger.tokens = [REQUEST], [TOKEN]
        s.reth.pool[ALICE] = [self.leg_tx(s, DEP)]
        r = self.registry(s, TOKEN_ADMIN, answer=ANSWER)
        self.build(s)
        self.assertEqual(self.attached(s, "DepositLeg"), {"request": "req-1", "token": "tok-1", "choiceContext": VALUES})
        self.assertEqual([a[0] for a in r.asked], ["/registry/allocations/v1/alloc-d1/choice-contexts/execute-transfer"])

    def test_a_trade_gets_its_allocations_context_next_to_the_venues_disclosed_allocation(self):
        s = self.setup({ALICE: []})
        s.ledger.trades, s.ledger.tokens = [TRADE], [TOKEN]
        s.cfg.venues = ("venue::1",)
        s.ledger.allocations = []   # the allocation is the seller's: the builder cannot see it
        s.reth.pool[ALICE] = [self.leg_tx(s, TRADE_PAY)]
        r = self.registry(s, TOKEN_ADMIN, answer=ANSWER)
        self.build(s)
        self.assertEqual(self.attached(s, "TradeLeg"), {"tradeCid": "trade-1", "choiceContext": VALUES})
        self.assertEqual([a[0] for a in r.asked], ["/registry/allocations/v1/" + tb.ALLOCATION_ID + "/choice-contexts/execute-transfer"])
        self.assertEqual(self.disclosed(s), [tb.DISCLOSED_ALLOCATION, ROUND, RULES])

    def withdrawal(self):
        s = self.setup({ALICE: []})
        s.ledger.acceptances, s.ledger.tokens, s.ledger.holdings = [ACCEPTANCE], [TOKEN], [holding("h-1", "6.0")]
        s.reth.pool[ALICE] = [self.leg_tx(s, WD)]
        return s

    def test_a_withdrawal_gets_the_context_of_the_transfer_it_will_make(self):
        s = self.withdrawal()
        r = self.registry(s, TOKEN_ADMIN, answer=FACTORY)
        self.build(s)
        self.assertEqual(self.attached(s, "WithdrawalLeg")["choiceContext"], VALUES)
        (path, body, _), = r.asked
        self.assertEqual(path, "/registry/transfer-instruction/v1/transfer-factory")
        args = body["choiceArguments"]
        self.assertEqual((body["excludeDebugFields"], args["expectedAdmin"], args["extraArgs"]), (True, TOKEN_ADMIN, {"context": {"values": {}}, "meta": {"values": {}}}))
        transfer = args["transfer"]
        self.assertEqual({k: transfer[k] for k in ("sender", "receiver", "amount", "instrumentId", "inputHoldingCids", "meta")},
                         {"sender": "gw", "receiver": "r::1", "amount": "4.0", "instrumentId": tb.TKB, "inputHoldingCids": ["h-1"], "meta": {"values": {}}})
        self.assertRegex(transfer["requestedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertRegex(transfer["executeBefore"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(self.disclosed(s), [ROUND, RULES])

    def test_a_withdrawal_through_another_factory_than_the_tokens_is_left_out(self):
        s = self.withdrawal()
        self.registry(s, TOKEN_ADMIN, answer={**FACTORY, "factoryId": "evil-factory"})
        self.assert_left_out(s, s.reth.pool[ALICE][0], "another transfer factory")

    # ---- two legs, each its own
    def two(self):
        twin = ("terms-2", {**TERMS[1], "dvpId": "ff" * 32, "allocation": "alloc-2"})
        s = self.setup({ALICE: [], BOB: []}, terms=[TERMS, twin])
        t1, t2 = self.leg_tx(s, PAY, ALICE), self.leg_tx(s, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10), BOB)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [t1], [t2]
        return s

    def test_two_payments_each_carry_their_own_context_and_a_shared_contract_is_disclosed_once(self):
        s = self.two()
        other = {"values": {"amulet-rules": {"tag": "AV_ContractId", "value": cid(0xab)}, "open-round": {"tag": "AV_ContractId", "value": cid(0xef)}}}
        round2 = {**ROUND, "contractId": cid(0x33)}
        base = "/registry/allocations/v1/%s/choice-contexts/execute-transfer"
        self.registry(s, TERMS_ADMIN, by_path={base % "alloc-1": ANSWER, base % "alloc-2": {"choiceContextData": other, "disclosedContracts": [round2, RULES]}})
        self.build(s)
        legs = s.advance_argument()["legs"]
        self.assertEqual([l["value"]["choiceContext"] for l in legs], [VALUES, other])
        self.assertEqual(self.disclosed(s), [ROUND, RULES, round2])

    def test_a_contract_named_differently_for_another_leg_leaves_the_later_leg_out(self):
        s = self.two()
        base = "/registry/allocations/v1/%s/choice-contexts/execute-transfer"
        self.registry(s, TERMS_ADMIN, by_path={base % "alloc-1": ANSWER, base % "alloc-2": {"choiceContextData": VALUES, "disclosedContracts": [{**ROUND, "createdEventBlob": "/+/+"}]}})
        result = self.build(s)
        self.assertEqual(len(result["leftOut"]), 1)
        self.assertIn("differently", result["leftOut"][0]["reason"])
        self.assertEqual(self.disclosed(s), [ROUND, RULES])

    def test_a_contract_that_is_given_with_disclosed_is_sent_once_whatever_its_form_and_a_different_form_leaves_the_leg_out(self):
        s, t = self.pay()
        self.registry(s, TERMS_ADMIN, answer=ANSWER)
        bare = {k: v for k, v in ROUND.items() if k != "synchronizerId"}
        s.cfg.disclosed = [bare]
        self.assert_left_out(s, t, "token registry", "differently")
        s, t = self.pay()
        self.registry(s, TERMS_ADMIN, answer=ANSWER)
        s.cfg.disclosed = [ROUND]
        self.build(s)
        self.assertEqual(self.disclosed(s), [ROUND, RULES])

    def test_a_contract_that_a_venues_allocation_names_in_another_form_leaves_the_trade_out(self):
        s = self.setup({ALICE: []})
        s.ledger.trades, s.ledger.tokens = [TRADE], [TOKEN]
        s.cfg.venues = ("venue::1",)
        s.ledger.allocations = []
        t = self.leg_tx(s, TRADE_PAY)
        s.reth.pool[ALICE] = [t]
        same = {**ROUND, "contractId": tb.DISCLOSED_ALLOCATION["contractId"], "createdEventBlob": "enp6"}
        self.registry(s, TOKEN_ADMIN, answer={"choiceContextData": VALUES, "disclosedContracts": [same]})
        self.assert_left_out(s, t, "token registry", "differently")

    def test_the_contracts_a_blocks_registries_name_are_bounded_in_bytes(self):
        s = self.two()
        big = lambda cid: {**ROUND, "contractId": cid, "createdEventBlob": "QUJD" * 300}
        base = "/registry/allocations/v1/%s/choice-contexts/execute-transfer"
        self.registry(s, TERMS_ADMIN, by_path={base % "alloc-1": {"choiceContextData": VALUES, "disclosedContracts": [big(cid(0x41))]},
                                               base % "alloc-2": {"choiceContextData": VALUES, "disclosedContracts": [big(cid(0x42))]}})
        old, b.CONTEXT_MAX_DISCLOSED_BYTES = b.CONTEXT_MAX_DISCLOSED_BYTES, 2000
        self.addCleanup(setattr, b, "CONTEXT_MAX_DISCLOSED_BYTES", old)
        result = self.build(s)
        self.assertEqual(len(result["leftOut"]), 1)
        self.assertIn("token registry", result["leftOut"][0]["reason"])
        self.assertEqual([d["contractId"] for d in self.disclosed(s)], [cid(0x41)])

    # ---- a registry trusted for nothing
    def left_out(self, **k):
        s, t = self.pay()
        r = self.registry(s, TERMS_ADMIN, **k)
        result = self.assert_left_out(s, t, "token registry")
        self.assertIsNone(self.disclosed(s))
        return r, result

    # ---- one guard for every entry point: whatever a registry's answer does, the leg is left out and the build never fails
    def test_a_payment_whose_answer_raises_anything_is_left_out(self):
        s, t = self.pay()
        self.registry(s, TERMS_ADMIN, answer=ANSWER)
        with mock.patch.object(b, "context_values", side_effect=Odd(Bomb())):
            result = self.assert_left_out(s, t, "token registry", "Odd")
        self.assertIsNone(self.disclosed(s))

    def test_a_trade_whose_answer_raises_anything_is_left_out(self):
        s = self.setup({ALICE: []})
        s.ledger.trades, s.ledger.tokens = [TRADE], [TOKEN]
        s.cfg.venues = ("venue::1",)
        s.ledger.allocations = []
        t = self.leg_tx(s, TRADE_PAY)
        s.reth.pool[ALICE] = [t]
        self.registry(s, TOKEN_ADMIN, answer=ANSWER)
        with mock.patch.object(b, "context_values", side_effect=Odd(Bomb())):
            self.assert_left_out(s, t, "token registry", "Odd")

    def test_a_withdrawal_whose_answer_raises_anything_is_left_out(self):
        s = self.withdrawal()
        self.registry(s, TOKEN_ADMIN, answer=FACTORY)
        with mock.patch.object(b, "context_values", side_effect=Odd(Bomb())):
            self.assert_left_out(s, s.reth.pool[ALICE][0], "token registry", "Odd")

    def test_a_withdrawal_whose_kind_cannot_be_shown_does_not_fail_the_build(self):
        s = self.withdrawal()
        self.registry(s, TOKEN_ADMIN, answer=FACTORY)
        with mock.patch.object(b.ChoiceContexts, "ask", return_value={**FACTORY, "transferKind": Bomb()}), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.build(s)["legs"], 1)

    def test_each_entry_point_turns_any_exception_into_a_bounded_reason(self):
        c = b.ChoiceContexts({TOKEN_ADMIN: "http://127.0.0.1:1"})
        for name, call in (("allocation", lambda: c.allocation(TOKEN_ADMIN, "a-1")), ("transfer", lambda: c.transfer(TOKEN_ADMIN, "fac-1", {"receiver": "r::1"}))):
            for error in (Odd(Bomb()), RecursionError(Bomb()), RuntimeError("x" * 100000), KeyError("\ud800" * 500), MemoryError()):
                with self.subTest(name=name, error=type(error).__name__), mock.patch.object(c, "ask", side_effect=error):
                    with self.assertRaises(b.NoCantonSide) as caught:
                        call()
                    self.assertLessEqual(len(str(caught.exception)), 300)
                    str(caught.exception).encode("ascii")   # printable and writable
        with mock.patch.object(c, "ask", side_effect=KeyboardInterrupt()), self.assertRaises(KeyboardInterrupt):
            c.allocation(TOKEN_ADMIN, "a-1")

    def test_text_from_a_registry_that_goes_into_a_reason_is_bounded(self):
        s, t = self.pay()
        self.registry(s, TERMS_ADMIN, answer=ANSWER)
        with mock.patch.object(b, "bounded_fetch", side_effect=http.client.BadStatusLine("x" * 60000)):
            result = self.assert_left_out(s, t, "token registry cannot be read")
        self.assertLess(len(result["leftOut"][0]["reason"]), 300)
        self.assertTrue(all(len(v[1]) < 300 for v in b.REGISTRY_DOWN.values()))

    def test_a_registry_that_fails_leaves_the_leg_out(self):
        _, result = self.left_out(answer=ANSWER, status=500)
        self.assertIn("HTTP 500", result["leftOut"][0]["reason"])

    def test_a_registry_that_has_no_such_allocation_leaves_the_leg_out(self):
        _, result = self.left_out(answer={"error": "no"}, status=404)
        self.assertIn("HTTP 404", result["leftOut"][0]["reason"])

    def test_a_redirect_is_not_followed(self):
        other = Registry(answer=ANSWER)
        self.addCleanup(other.close)
        self.left_out(answer=ANSWER, status=307, location=other.url + "/registry/x")
        self.assertEqual(other.asked, [])

    def test_an_answer_that_is_not_json_leaves_the_leg_out(self):
        self.left_out(raw=b"<html>")

    def test_an_answer_over_the_limit_leaves_the_leg_out(self):
        self.left_out(raw=b'{"choiceContextData": {"values": {}}, "pad": "' + b"x" * b.CONTEXT_MAX_BODY + b'"}')

    def test_answers_that_are_not_a_choice_context_leave_the_leg_out(self):
        bad = [[], {"disclosedContracts": []}, {"choiceContextData": []}, {"choiceContextData": {"values": []}}, {"choiceContextData": {}},
               {"choiceContextData": {"values": {"k": "v"}}}, {"choiceContextData": {"values": {"k": {"tag": "X", "value": 1}}}},
               {"choiceContextData": {"values": {"k": {"tag": "AV_Text", "value": "t", "more": 1}}}},
               {"choiceContextData": {"values": {f"k{i}": {"tag": "AV_Text", "value": "t"} for i in range(b.CONTEXT_MAX_VALUES + 1)}}},
               {"choiceContextData": VALUES, "disclosedContracts": [{"contractId": "x"}]},
               {"choiceContextData": VALUES, "disclosedContracts": "x"},
               {"choiceContextData": VALUES, "disclosedContracts": [{**ROUND, "createdEventBlob": 7}]},
               {"choiceContextData": VALUES, "disclosedContracts": [{**ROUND, "createdEventBlob": "not base64!"}]},
               {"choiceContextData": VALUES, "disclosedContracts": [{**ROUND, "createdEventBlob": "QUJ"}]},     # padding missing
               {"choiceContextData": VALUES, "disclosedContracts": [{**ROUND, "createdEventBlob": "===="}]},    # nothing in it
               {"choiceContextData": VALUES, "disclosedContracts": [{**ROUND, "createdEventBlob": ""}]},
               {"choiceContextData": VALUES, "disclosedContracts": [{**ROUND, "contractId": "round-cid"}]},
               {"choiceContextData": VALUES, "disclosedContracts": [{**ROUND, "contractId": ROUND["contractId"].upper()}]},
               {"choiceContextData": VALUES, "disclosedContracts": [{**ROUND, "contractId": ROUND["contractId"] + "a"}]},
               {"choiceContextData": VALUES, "disclosedContracts": [{**ROUND, "templateId": "pkg:Splice.Round:OpenMiningRound"}]},   # not a package id or a #name
               {"choiceContextData": VALUES, "disclosedContracts": [{**ROUND, "templateId": PACKAGE + ":OpenMiningRound"}]},
               {"choiceContextData": VALUES, "disclosedContracts": [{**ROUND, "templateId": PACKAGE + ":Splice.Round:Open Mining"}]},
               {"choiceContextData": VALUES, "disclosedContracts": [ROUND] * (b.CONTEXT_MAX_DISCLOSED + 1)}]
        for answer in bad:
            with self.subTest(answer=str(answer)[:60]):
                b.REGISTRY_DOWN.clear()
                self.left_out(answer=answer)

    def test_a_value_that_daml_could_not_hold_leaves_the_leg_out_before_anything_is_proven(self):
        deep = {"tag": "AV_Text", "value": "t"}
        for _ in range(40):
            deep = {"tag": "AV_List", "value": [deep]}
        wide = {"tag": "AV_List", "value": [{"tag": "AV_Bool", "value": True}] * (b.CONTEXT_MAX_NODES + 1)}
        bad = {"deep": {"choiceContextData": {"values": {"k": deep}}},
               "wide": {"choiceContextData": {"values": {"k": wide}}},
               "float": {"choiceContextData": {"values": {"k": {"tag": "AV_Decimal", "value": 1.5}}}},
               "text is a number": {"choiceContextData": {"values": {"k": {"tag": "AV_Text", "value": 7}}}},
               "unknown tag": {"choiceContextData": {"values": {"k": {"tag": "AV_Other", "value": "x"}}}},
               "list of text": {"choiceContextData": {"values": {"k": {"tag": "AV_List", "value": "x"}}}}}
        for name, tag, value in (("party", "AV_Party", "not a party"), ("party with a bad name", "AV_Party", "a b::1220" + "ab" * 32), ("decimal", "AV_Decimal", "abc"),
                                 ("decimal with an exponent", "AV_Decimal", "1e3"), ("decimal with 11 places", "AV_Decimal", "0.12345678901"),
                                 ("decimal with 29 digits", "AV_Decimal", "1" * 29), ("int", "AV_Int", "zz"), ("int over 64 bits", "AV_Int", str(2**63)),
                                 ("empty contract id", "AV_ContractId", ""), ("contract id that is not hex", "AV_ContractId", "rules-cid"),
                                 ("contract id in uppercase", "AV_ContractId", cid(0xab).upper()), ("contract id of an odd length", "AV_ContractId", cid(0xab) + "a"),
                                 ("contract id with no 00 prefix", "AV_ContractId", cid(0xab)[2:]), ("contract id that is too short", "AV_ContractId", "00ab12"),
                                 ("contract id over 254 characters", "AV_ContractId", cid(0xab, "ab" * 95)), ("contract id with no suffix", "AV_ContractId", cid(0xab, "")),
                                 ("date", "AV_Date", "29/10/2026"), ("date that is not one", "AV_Date", "2026-13-40"), ("time", "AV_Time", "yesterday"),
                                 ("time with no zone", "AV_Time", "2026-10-29T12:00:00"), ("reltime as text", "AV_RelTime", "garbage"),
                                 ("reltime with a bad count", "AV_RelTime", {"microseconds": "x"}), ("reltime with more", "AV_RelTime", {"microseconds": "1", "x": "2"}),
                                 ("bool as text", "AV_Bool", "true")):
            bad[name] = {"choiceContextData": {"values": {"k": {"tag": tag, "value": value}}}}
        for name, answer in bad.items():
            with self.subTest(name):
                b.REGISTRY_DOWN.clear()
                self.left_out(answer=answer)
        for name, raw in (("NaN", b'{"choiceContextData": {"values": {"k": {"tag": "AV_Decimal", "value": NaN}}}}'),
                          ("Infinity", b'{"choiceContextData": {"values": {"k": {"tag": "AV_Int", "value": Infinity}}}}'),
                          ("nested under the size limit", b'{"choiceContextData": {"values": {"k": ' + b'{"tag": "AV_List", "value": [' * 2000 + b'{"tag": "AV_Bool", "value": true}' + b"]}" * 2000 + b'}}}')):
            with self.subTest(name):
                b.REGISTRY_DOWN.clear()
                self.left_out(raw=raw)

    def test_every_kind_of_value_a_registry_may_give_is_taken(self):
        values = {"values": {"t": {"tag": "AV_Text", "value": "x"}, "i": {"tag": "AV_Int", "value": "7"}, "b": {"tag": "AV_Bool", "value": False},
                             "l": {"tag": "AV_List", "value": [{"tag": "AV_Party", "value": ADMIN}]},
                             "m": {"tag": "AV_Map", "value": {"a": {"tag": "AV_ContractId", "value": cid(0x0c, "ab")}, "z": {"tag": "AV_ContractId", "value": cid(0x0d, "ab" * 94)}}},
                             "d": {"tag": "AV_Decimal", "value": "-12.5"}, "n": {"tag": "AV_Decimal", "value": "7"}, "y": {"tag": "AV_Date", "value": "2026-10-29"},
                             "ts": {"tag": "AV_Time", "value": "2026-10-29T12:00:00.123456Z"}, "r": {"tag": "AV_RelTime", "value": {"microseconds": "60000000"}},
                             "big": {"tag": "AV_Int", "value": "-9223372036854775808"}}}
        r = Registry(answer={"choiceContextData": values})
        self.addCleanup(r.close)
        self.assertEqual(b.ChoiceContexts({ADMIN: r.url}).allocation(ADMIN, "a-1"), (values, []))

    def test_a_registry_that_cannot_be_reached_leaves_the_leg_out(self):
        s, t = self.pay()
        s.cfg.registries = {TERMS_ADMIN: "http://127.0.0.1:1"}
        self.assert_left_out(s, t, "token registry cannot be read")

    def test_the_bearer_token_goes_to_that_registry_only(self):
        s = self.setup({ALICE: [], BOB: []}, terms=[TERMS, ("terms-2", {**TERMS[1], "dvpId": "ff" * 32, "allocation": "alloc-2"})])
        s.reth.pool[ALICE], s.reth.pool[BOB] = [self.leg_tx(s, PAY, ALICE)], [self.leg_tx(s, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10), BOB)]
        r = self.registry(s, TERMS_ADMIN, answer=ANSWER)
        token, unused = Path(s.dir) / "token", Path(s.dir) / "unused"
        token.write_text("s3cret\n")
        unused.write_text("other\n")
        s.cfg.registry_tokens = {TERMS_ADMIN: str(token), "unused::1220" + "ee" * 32: str(unused)}
        self.build(s)
        self.assertEqual({a[2] for a in r.asked}, {"Bearer s3cret"})

    def test_a_token_that_is_renewed_in_its_file_is_sent_from_the_next_request_on(self):
        r = Registry(answer=ANSWER)
        self.addCleanup(r.close)
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "token"
            f.write_text("first\n")
            reader = b.ChoiceContexts({ADMIN: r.url}, {ADMIN: str(f)})
            reader.allocation(ADMIN, "a-1")
            f.write_text("second\n")
            reader.allocation(ADMIN, "a-2")
            self.assertEqual([a[2] for a in r.asked], ["Bearer first", "Bearer second"])
            for text in ("", "a\nb"):   # a file that cannot be read now, or holds no token, leaves the leg out; it never fails the build
                f.write_text(text)
                with self.assertRaises(b.NoCantonSide):
                    reader.allocation(ADMIN, "a-3")
            f.unlink()
            with self.assertRaises(b.NoCantonSide):
                reader.allocation(ADMIN, "a-3")
            self.assertEqual(len(r.asked), 2)

    # ---- the reader on its own
    def test_a_slow_registry_is_given_up_on_at_the_deadline_and_not_asked_again_for_a_while(self):
        r = Registry(answer=ANSWER, delay=2)
        self.addCleanup(r.close)
        b.REGISTRY_DOWN.clear()
        reader = b.ChoiceContexts({ADMIN: r.url}, deadline=0.3, backoff=30)
        started = time.monotonic()
        with self.assertRaisesRegex(b.NoCantonSide, "cannot be read"):
            reader.allocation(ADMIN, "a-1")
        with self.assertRaisesRegex(b.NoCantonSide, "cannot be read"):
            reader.allocation(ADMIN, "a-2")
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(len(r.asked), 1)

    def test_all_the_requests_of_a_block_to_one_registry_share_its_budget(self):
        r = Registry(answer=ANSWER, delay=0.25)
        self.addCleanup(r.close)
        b.REGISTRY_DOWN.clear()
        reader = b.ChoiceContexts({ADMIN: r.url}, deadline=5, budget=0.4)
        reader.allocation(ADMIN, "a-1")
        with self.assertRaisesRegex(b.NoCantonSide, "cannot be read"):   # the second request has what is left of the budget, which is not enough
            reader.allocation(ADMIN, "a-2")
        with self.assertRaisesRegex(b.NoCantonSide, "used|not asked|cannot"):
            reader.allocation(ADMIN, "a-3")
        self.assertEqual(len(r.asked), 2)

    def test_a_registry_that_answered_but_used_its_budget_is_left_out_for_the_block_only(self):
        r = Registry(answer=ANSWER)
        self.addCleanup(r.close)
        b.REGISTRY_DOWN.clear()
        reader = b.ChoiceContexts({ADMIN: r.url}, deadline=5, budget=0.4, backoff=30)
        reader.allocation(ADMIN, "a-1")
        reader.allocation(ADMIN, "a-2")   # answered
        reader.spent[r.url] = 0.4         # what a busy registry's answers add up to
        with self.assertRaisesRegex(b.NoCantonSide, "used"):   # the budget is gone: the rest of this block's legs are left out
            reader.allocation(ADMIN, "a-3")
        self.assertEqual(b.REGISTRY_DOWN, {})   # ... and the registry is not marked down: the next block asks it again
        reader = b.ChoiceContexts({ADMIN: r.url}, deadline=5, budget=0.4, backoff=30)
        self.assertEqual(reader.allocation(ADMIN, "a-4")[0], VALUES)

    def test_a_request_cut_short_by_what_is_left_of_the_budget_does_not_mark_the_registry_down(self):
        r = Registry(answer=ANSWER, delay=0.25)
        self.addCleanup(r.close)
        b.REGISTRY_DOWN.clear()
        reader = b.ChoiceContexts({ADMIN: r.url}, deadline=5, budget=0.4, backoff=30)
        reader.allocation(ADMIN, "a-1")
        with self.assertRaisesRegex(b.NoCantonSide, "cannot be read"):   # 0.15 s are left, the answer takes 0.25: timed out by the budget, not by the deadline
            reader.allocation(ADMIN, "a-2")
        self.assertEqual(b.REGISTRY_DOWN, {})

    def test_a_registry_that_hangs_never_takes_the_legs_of_another_out(self):
        slow, fast = Registry(answer=ANSWER, delay=3), Registry(answer=ANSWER)
        self.addCleanup(slow.close); self.addCleanup(fast.close)
        other = "oth::1220" + "cd" * 32
        regs = {ADMIN: slow.url, other: fast.url}
        b.REGISTRY_DOWN.clear()
        reader = b.ChoiceContexts(regs, deadline=0.3, backoff=30, budget=0.4)
        with self.assertRaisesRegex(b.NoCantonSide, "cannot be read"):   # the slow one uses all of its own budget
            reader.allocation(ADMIN, "a-1")
        self.assertEqual(reader.allocation(other, "a-2")[0], VALUES)   # the same block: the other registry has a budget of its own
        for _ in range(2):   # the next blocks: the slow one is not asked, the other still is
            reader = b.ChoiceContexts(regs, deadline=0.3, backoff=30, budget=0.4)
            with self.assertRaisesRegex(b.NoCantonSide, "cannot be read"):
                reader.allocation(ADMIN, "a-3")
            self.assertEqual(reader.allocation(other, "a-4" + str(_))[0], VALUES)
        self.assertEqual(len(slow.asked), 1)
        self.assertEqual(len(fast.asked), 3)

    def test_a_registry_whose_budget_is_used_up_by_another_is_not_marked_down(self):
        a, c = Registry(answer=ANSWER, delay=0.25), Registry(answer=ANSWER)
        self.addCleanup(a.close); self.addCleanup(c.close)
        other = "oth::1220" + "cd" * 32
        b.REGISTRY_DOWN.clear()
        reader = b.ChoiceContexts({ADMIN: a.url, other: c.url}, deadline=5, budget=0.4)
        reader.allocation(ADMIN, "a-1")
        with self.assertRaisesRegex(b.NoCantonSide, "cannot be read"):
            reader.allocation(ADMIN, "a-2")
        reader.allocation(other, "c-1")
        self.assertEqual([k for k in b.REGISTRY_DOWN if k[1] == c.url], [])

    def test_one_choice_context_is_bounded_in_bytes(self):
        big = {"choiceContextData": {"values": {"k": {"tag": "AV_Text", "value": "x" * (b.CONTEXT_MAX_CONTEXT_BYTES + 1)}}}}
        self.left_out(answer=big)

    def test_the_choice_contexts_of_a_block_are_bounded_in_bytes_and_the_later_legs_are_left_out(self):
        s = self.two()
        size = len(json.dumps(VALUES))
        self.registry(s, TERMS_ADMIN, answer=ANSWER)
        old, b.CONTEXT_MAX_BLOCK_BYTES = b.CONTEXT_MAX_BLOCK_BYTES, size + size // 2
        self.addCleanup(setattr, b, "CONTEXT_MAX_BLOCK_BYTES", old)
        result = self.build(s)
        self.assertEqual(len(result["leftOut"]), 1)
        self.assertIn("choice contexts", result["leftOut"][0]["reason"])
        self.assertEqual(len(s.advance_argument()["legs"]), 1)

    def test_an_answer_is_asked_once(self):
        r = Registry(answer=ANSWER)
        self.addCleanup(r.close)
        reader = b.ChoiceContexts({ADMIN: r.url})
        self.assertEqual(reader.allocation(ADMIN, "a-1"), reader.allocation(ADMIN, "a-1"))
        self.assertEqual(len(r.asked), 1)

    def test_a_withdrawals_answer_is_asked_once_whatever_times_the_rebuild_gives_it(self):
        r = Registry(answer=FACTORY)
        self.addCleanup(r.close)
        reader = b.ChoiceContexts({ADMIN: r.url})
        transfer = {"sender": "gw", "receiver": "r::1", "amount": "4.0", "requestedAt": "2026-10-28T10:00:00Z", "executeBefore": "2026-10-29T10:00:00Z"}
        first = reader.transfer(ADMIN, "fac-1", transfer)
        again = reader.transfer(ADMIN, "fac-1", {**transfer, "requestedAt": "2026-10-28T10:00:07Z", "executeBefore": "2026-10-29T10:00:07Z"})
        self.assertEqual((first, len(r.asked)), (again, 1))
        reader.transfer(ADMIN, "fac-1", {**transfer, "amount": "5.0"})
        self.assertEqual(len(r.asked), 2)

    def test_a_transfer_that_is_not_direct_is_said_so(self):
        r = Registry(answer={**FACTORY, "transferKind": "offer"})
        self.addCleanup(r.close)
        with contextlib.redirect_stderr(io.StringIO()) as err:
            b.ChoiceContexts({ADMIN: r.url}).transfer(ADMIN, "fac-1", {"amount": "4.0"})
        self.assertIn("offer", err.getvalue())

    # ---- configuration
    def test_registries_are_admin_equals_url(self):
        self.assertEqual(b.parse_registries([f"{ADMIN}=https://v.example/api/validator/v0/scan-proxy"]), {ADMIN: "https://v.example/api/validator/v0/scan-proxy"})
        for bad in ("http://x", f"{ADMIN}=ftp://x", f"{ADMIN}=", f"{ADMIN}=http://x?a=b", "nonsense=http://x"):
            with self.subTest(bad=bad), self.assertRaises(b.BuilderError):
                b.parse_registries([bad])
        with self.assertRaises(b.BuilderError):
            b.parse_registries([f"{ADMIN}=http://x", f"{ADMIN}=http://y"])

    def test_a_token_file_is_for_a_registry_and_holds_one_token(self):
        s = self.setup({ALICE: []})
        f = Path(s.dir) / "token"
        f.write_text("abc\n")
        self.assertEqual(b.read_registry_tokens([f"{ADMIN}={f}"], {ADMIN: "https://x"}), {ADMIN: str(f)})   # the path: the token is read again for each request
        with self.assertRaises(b.BuilderError):
            b.read_registry_tokens([f"{ADMIN}={f}"], {})
        f.write_text("a\nb")
        with self.assertRaises(b.BuilderError):
            b.read_registry_tokens([f"{ADMIN}={f}"], {ADMIN: "https://x"})
        with self.assertRaises(b.BuilderError):
            b.read_registry_tokens([f"{ADMIN}={f}.none"], {ADMIN: "https://x"})

    def test_a_token_goes_only_to_an_https_registry_or_one_on_this_machine(self):
        s = self.setup({ALICE: []})
        f = Path(s.dir) / "token"
        f.write_text("abc\n")
        for url in ("http://v.example/scan", "http://10.0.0.5:8080"):
            with self.subTest(url), self.assertRaises(b.BuilderError):
                b.read_registry_tokens([f"{ADMIN}={f}"], {ADMIN: url})
        for url in ("https://v.example/scan", "http://127.0.0.1:8080", "http://localhost/x", "http://[::1]:8080"):
            with self.subTest(url):
                self.assertEqual(b.read_registry_tokens([f"{ADMIN}={f}"], {ADMIN: url}), {ADMIN: str(f)})

    def test_a_registry_url_with_a_user_and_password_is_refused(self):
        for bad in (f"{ADMIN}=https://u:p@v.example/x", f"{ADMIN}=https://u@v.example/x"):
            with self.subTest(bad), self.assertRaises(b.BuilderError):
                b.parse_registries([bad])


class CommandLine(tb.Case):
    run_main = tb.CommandLine.run_main

    def test_the_registry_and_its_token_come_from_the_command_line(self):
        s = self.setup({ALICE: []}, terms=[TERMS])
        s.ledger.views["alloc-1"] = {"instrument": {"admin": ADMIN, "id": "T"}}
        s.reth.pool[ALICE] = [tb.tx(ALICE, 0)]
        s.reth.tx_legs[s.reth.pool[ALICE][0]["hash"]] = [PAY]
        r = Registry(answer=ANSWER)
        self.addCleanup(r.close)
        token = Path(s.dir) / "token"
        token.write_text("s3cret\n")
        code, out = self.run_main(s, "--registry", f"{ADMIN}={r.url}", "--registry-token-file", f"{ADMIN}={token}")
        self.assertEqual((code, out["committed"]), (0, True))
        self.assertEqual(s.advance_argument()["legs"][0]["value"]["choiceContext"], VALUES)
        self.assertEqual([a[2] for a in r.asked], ["Bearer s3cret"])
        self.assertEqual(s.ledger.submitted[0]["disclosedContracts"], [ROUND, RULES])

    def test_a_token_for_an_admin_with_no_registry_is_refused(self):
        s = self.setup({ALICE: [tb.tx(ALICE, 0)]})
        code, out = self.run_main(s, "--registry-token-file", f"{ADMIN}=/nonexistent")
        self.assertEqual(code, 1)
        self.assertIn("no token registry", out["error"])


    def test_a_registry_with_a_builder_pinned_to_a_package_before_0_5_0_is_refused(self):
        s = self.setup({ALICE: [tb.tx(ALICE, 0)]})
        code, out = self.run_main(s, "--registry", f"{ADMIN}=https://v.example/x", "--unlabelled-deposits")
        self.assertEqual(code, 1)
        self.assertIn("--unlabelled-deposits", out["error"])


if __name__ == "__main__":
    unittest.main()
