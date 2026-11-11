"""The leg check: before a transaction goes to reth's pool, the public RPC asks whether a leg it would record has a Canton side, so that a call that
would never be mined is refused with the reason. Against the same fakes as test_builder.py, and a real HTTP client for the service.
Run: python3 -m unittest discover -s builder/tests"""
import http.client, json, sys, threading, unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
import test_twin_legs as tt

FROM, TO = "0x" + "a1" * 20, "0x" + "c9" * 20
CALL = {"from": FROM, "to": TO, "data": "0x1234", "value": "0x0", "gas": "0x30d40"}


class Check(tb.LegCase):
    def setup_check(self, *legs, **k):
        s = self.setup({}, **k)
        s.reth.trace_legs[TO] = list(legs)
        return s

    def test_a_call_that_records_no_leg_is_ok_and_nothing_is_read_from_canton(self):
        s = self.setup_check()
        self.assertEqual(b.leg_check(s.cfg, CALL), {"ok": True})
        self.assertEqual(s.ledger.queries, [])
        self.assertEqual(len(s.reth.traced), 1)
        self.assertEqual(s.reth.traced[0][1:], ["latest", {"tracer": "callTracer", "tracerConfig": {"withLog": True}}])

    def test_a_creation_is_ok_without_running_anything(self):
        s = self.setup_check()
        self.assertEqual(b.leg_check(s.cfg, {"from": FROM, "input": "0x6000"}), {"ok": True})
        self.assertEqual(s.reth.traced, [])

    def test_a_leg_with_its_canton_side_is_ok(self):
        s = self.setup_check(tb.DEP)
        s.ledger.requests, s.ledger.tokens = list((tb.REQUEST,)), list((tb.TOKEN,))
        self.assertEqual(b.leg_check(s.cfg, CALL), {"ok": True})

    def test_a_leg_with_no_canton_side_is_refused_with_the_reason(self):
        for leg, setup, words in ((tb.DEP, {}, "no deposit request"), (tb.WD, {}, "no standing acceptance of withdrawals"), (tb.PAY, {}, "no terms of this chain")):
            with self.subTest(words):
                s = self.setup_check(leg)
                s.ledger.tokens = list((tb.TOKEN,))
                result = b.leg_check(s.cfg, CALL)
                self.assertIs(result["ok"], False)
                self.assertIn(words, result["reason"])
                self.assertTrue(result["reason"].startswith("its "), result["reason"])
                self.assertEqual(len(result["legs"]), 1)

    def test_every_leg_without_a_side_is_named(self):
        s = self.setup_check(tb.DEP, tb.PAY)
        result = b.leg_check(s.cfg, CALL)
        self.assertEqual([x["kind"] for x in result["legs"]], ["deposit", "payment"])

    def test_the_withdrawal_quota_and_a_pause_do_not_refuse_a_send(self):
        s = self.setup_check(tb.WD)
        s.ledger.acceptances, s.ledger.tokens, s.ledger.holdings = [tb.ACCEPTANCE], [tb.TOKEN], [tb.holding("h-1", "60.0")]
        s.ledger.chain_extra = {"withdrawalQuota": "1.0", "quotaWindow": {"microseconds": "86400000000"}, "withdrawn": None}   # 4.0 is over a quota of 1.0
        self.assertEqual(b.leg_check(s.cfg, CALL), {"ok": True})
        s.ledger.chain_extra = {"pausedUntil": "2999-01-01T00:00:00Z"}
        self.assertEqual(b.leg_check(s.cfg, CALL), {"ok": True})

    def test_a_party_held_back_for_a_while_does_not_refuse_a_send_and_one_off_the_operators_participants_does(self):
        s = self.setup_check(tb.PAY)
        s.ledger.terms = [tb.TERMS]
        s.cfg.blame = b.PartyBlame(600, clock=lambda: 1_000.0)
        s.cfg.blame.convict("u::1", 1_000.0)
        self.assertEqual(b.leg_check(s.cfg, CALL), {"ok": True})
        s.cfg.blame = None
        s.cfg.hosted_on = ("PAR::rome::1220" + "aa" * 32,)
        s.cfg.hosting = b.Hosting(s.cfg, s.cfg.hosted_on)
        result = b.leg_check(s.cfg, CALL)
        self.assertIs(result["ok"], False)
        self.assertIn("not hosted with the right to confirm", result["reason"])

    def test_a_call_that_does_not_run_now_is_ok_but_unknown(self):
        s = self.setup_check(tb.DEP)
        s.reth.trace_error = "execution reverted"
        result = b.leg_check(s.cfg, CALL)
        self.assertIs(result["ok"], True)
        self.assertIn("does not run now", result["unknown"])
        self.assertEqual(s.ledger.queries, [])

    def test_a_call_that_reverts_at_the_top_level_is_ok_but_unknown(self):
        """reth answers such a call with a frame that has an error and still carries the logs the frame made: it records no leg."""
        s = self.setup_check(tb.DEP)
        s.reth.trace_top_error = "execution reverted"
        result = b.leg_check(s.cfg, CALL)
        self.assertIs(result["ok"], True)
        self.assertIn("does not run now", result["unknown"])
        self.assertIn("execution reverted", result["unknown"])
        self.assertEqual(s.ledger.queries, [])
        s.reth.trace_top_error = None
        self.assertIs(b.leg_check(s.cfg, CALL)["ok"], False)   # the same call that runs is refused

    def test_a_hosting_lookup_that_fails_says_nothing_about_the_leg_but_a_party_that_is_not_hosted_does(self):
        s = self.setup_check(tb.PAY)
        s.ledger.terms = [tb.TERMS]
        s.cfg.hosted_on = ("PAR::rome::1220" + "aa" * 32,)
        s.cfg.hosting = b.Hosting(s.cfg, s.cfg.hosted_on)
        s.ledger.hosting_failure = 503
        result = b.leg_check(s.cfg, CALL)
        self.assertIs(result["ok"], True)
        self.assertIn("HTTP 503", result["unknown"])
        s.ledger.hosting_failure = None
        s.cfg.hosting.cache.clear()
        self.assertIs(b.leg_check(s.cfg, CALL)["ok"], False)   # asked and not hosted: a fact

    def test_a_list_that_cannot_be_read_says_nothing_about_the_leg(self):
        s = self.setup_check(tb.DEP)
        s.ledger.requests, s.ledger.tokens = list((tb.REQUEST,)), list((tb.TOKEN,))
        s.ledger.list_failure = {"DepositRequest": 500}
        result = b.leg_check(s.cfg, CALL)
        self.assertEqual((result["ok"], "unknown" in result), (True, True))

    def test_a_canton_that_cannot_be_reached_is_ok_but_unknown(self):
        s = self.setup_check(tb.DEP)
        s.ledger.bad_json = True
        result = b.leg_check(s.cfg, CALL)
        self.assertIs(result["ok"], True)
        self.assertIn("unknown", result)

    def test_a_trace_that_names_another_address_as_the_gateway_is_not_a_leg(self):
        s = self.setup_check(tb.DEP)
        original = s.reth._rpc
        def other(method, params):
            found = original(method, params)
            if method == "debug_traceCall":
                for call in found["calls"]:
                    for log in call["logs"]:
                        log["address"] = "0x" + "99" * 20
            return found
        s.reth._rpc = other
        self.assertEqual(b.leg_check(s.cfg, CALL), {"ok": True})


class Twin(tb.LegCase):
    """A lock whose Canton side cannot be read (the acceptance, the twin registry service) says nothing about it; one the reads show missing is refused."""
    setup_twin = tt.Twins.setup_twin

    def setUp(self):
        super().setUp()
        b.REGISTRY_DOWN.clear()

    def lock(self, **k):
        s, t = self.setup_twin(tt.LOCK, **k)
        s.reth.trace_legs[TO] = [tt.LOCK]
        return s

    def test_the_lock_with_its_acceptance_is_ok(self):
        self.assertEqual(b.leg_check(self.lock().cfg, CALL), {"ok": True})

    def test_an_acceptance_that_cannot_be_read_is_ok_but_unknown(self):
        for failure in (413, 500):
            with self.subTest(failure):
                s = self.lock()
                s.ledger.acceptance_failure = failure
                result = b.leg_check(s.cfg, CALL)
                self.assertIs(result["ok"], True)
                self.assertIn(f"HTTP {failure}", result["unknown"])
        s = self.lock()
        s.ledger.acceptance_failure, s.ledger.acceptance_delay = "timeout", 1.0
        with mock.patch.object(b, "ACCEPTANCE_TIMEOUT", 0.2):
            result = b.leg_check(s.cfg, CALL)
        self.assertIs(result["ok"], True)
        self.assertIn("cannot be read", result["unknown"])

    def test_an_acceptance_that_is_missing_or_archived_is_refused(self):
        s = self.lock(parts={tt.LOCK_ID: {**tt.PARTS, "acceptance": "acceptance-7"}})
        self.assertIs(b.leg_check(s.cfg, CALL)["ok"], False)
        s = self.lock()
        s.ledger.archived_acceptances = {"acceptance-1"}
        self.assertIn("archived", b.leg_check(s.cfg, CALL)["reason"])

    def test_a_twin_registry_service_that_is_down_busy_or_wrong_is_ok_but_unknown(self):
        for how in ("503", "unreachable", "bad answer"):
            with self.subTest(how):
                b.REGISTRY_DOWN.clear()
                s = self.lock()
                if how == "503":
                    s.registry.status = 503
                elif how == "bad answer":
                    s.registry.raw = b"[1]"
                else:
                    s.registry.close()
                result = b.leg_check(s.cfg, CALL)
                self.assertIs(result["ok"], True, result)
                self.assertIn("twin registry service", result["unknown"])
                if how == "unreachable":   # and it is not asked again for a while: that is no answer either
                    self.assertIs(b.leg_check(s.cfg, CALL)["ok"], True)

    def test_a_twin_registry_service_that_has_no_parts_for_the_lock_is_refused(self):
        s = self.lock(parts={})
        result = b.leg_check(s.cfg, CALL)
        self.assertIs(result["ok"], False)
        self.assertIn("no parts", result["reason"])


class Request(unittest.TestCase):
    def test_a_request_is_read_field_by_field(self):
        self.assertEqual(b.call_of(CALL), {"from": FROM, "to": TO, "input": "0x1234", "value": "0x0", "gas": "0x30d40"})
        self.assertEqual(b.call_of({"from": FROM}), {"from": FROM})
        self.assertEqual(b.call_of({"from": FROM, "to": None, "data": "0x"}), {"from": FROM, "input": "0x"})
        for bad in (None, [], {}, {"from": "0x12"}, {**CALL, "to": "nope"}, {**CALL, "data": "0x123"}, {**CALL, "data": "12"}, {**CALL, "value": "5"},
                    {**CALL, "gas": 21000}, {**CALL, "to": 5}, {**CALL, "value": "0x" + "f" * 65}):
            with self.subTest(repr(bad)[:40]):
                with self.assertRaises(ValueError):
                    b.call_of(bad)

    def test_the_logs_of_a_trace_are_those_of_the_frame_and_the_calls_under_it(self):
        frame = {"logs": [{"n": 1}], "calls": [{"logs": [{"n": 2}], "calls": [{"logs": [{"n": 3}]}]}, {"calls": [{"logs": [{"n": 4}, "x"]}]}, "bad"]}
        self.assertEqual([x["n"] for x in b.trace_logs(frame)], [1, 2, 3, 4])
        self.assertEqual(b.trace_logs(None), [])


class Service(unittest.TestCase):
    def serve(self, check):
        server = b.LegCheckServer(None, 0, check=check)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close()))
        return server

    def post(self, server, body, path="/v1/leg-check", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=10)
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        conn.request("POST", path, data, {"content-type": "application/json", **(headers or {})})
        r = conn.getresponse()
        out = r.read()
        conn.close()
        return r.status, json.loads(out)

    def test_it_answers_the_check_for_a_valid_request_and_only_on_the_loopback(self):
        asked = []
        server = self.serve(lambda cfg, call: asked.append(call) or {"ok": False, "reason": "its deposit leg has no Canton side: x", "legs": []})
        self.assertEqual(server.server_address[0], "127.0.0.1")
        self.assertEqual(self.post(server, CALL), (200, {"ok": False, "reason": "its deposit leg has no Canton side: x", "legs": []}))
        self.assertEqual(asked, [{"from": FROM, "to": TO, "input": "0x1234", "value": "0x0", "gas": "0x30d40"}])

    def test_a_bad_request_is_refused_before_anything_is_checked(self):
        asked = []
        server = self.serve(lambda cfg, call: asked.append(call) or {"ok": True})
        self.assertEqual(self.post(server, {"from": "x"})[0], 400)
        self.assertEqual(self.post(server, b"not json")[0], 400)
        self.assertEqual(self.post(server, CALL, path="/other")[0], 404)
        self.assertEqual(self.post(server, b"{}", headers={"content-length": str(b.LEG_CHECK_BODY + 1)})[0], 413)
        self.assertEqual(asked, [])

    def test_a_check_that_fails_answers_ok_and_unknown(self):
        def broken(cfg, call):
            raise RuntimeError("boom")
        server = self.serve(broken)
        status, body = self.post(server, CALL)
        self.assertEqual((status, body["ok"]), (200, True))
        self.assertIn("boom", body["unknown"])

    def test_checks_past_the_limit_are_told_to_come_back(self):
        gate, entered = threading.Event(), threading.Semaphore(0)
        def slow(cfg, call):
            entered.release()
            gate.wait(10)
            return {"ok": True}
        server = self.serve(slow)
        answers = []
        threads = [threading.Thread(target=lambda: answers.append(self.post(server, CALL)[0])) for _ in range(b.LEG_CHECK_CONCURRENCY)]
        for t in threads:
            t.start()
        for _ in threads:
            self.assertTrue(entered.acquire(timeout=10))
        self.assertEqual(self.post(server, CALL)[0], 503)
        gate.set()
        for t in threads:
            t.join(10)
        self.assertEqual(answers, [200] * b.LEG_CHECK_CONCURRENCY)
        self.assertEqual(self.post(server, CALL)[0], 200)   # the slots are free again


class Options(unittest.TestCase):
    def test_the_port_is_an_option_and_off_by_default(self):
        ap = b.parser()
        self.assertEqual(ap.parse_args(["run", "--leg-check-port", "7790"]).leg_check_port, 7790)
        self.assertEqual(ap.parse_args(["run"]).leg_check_port, 0)


if __name__ == "__main__":
    unittest.main()
