"""Who must confirm a block. One block is one Canton transaction, so the participant of every party whose contract a leg uses must confirm it, and
one that does not answer must not be able to hold the chain up again and again. Three things are tested here, against the same fakes as
test_builder.py: the check that a leg's parties are hosted on the participants the operator lists (`--hosted-on`), a block that fails on a
confirmation timeout being a refusal that blames the parties of its legs (and never a transaction), and the pure bookkeeping of the blame
(`PartyBlame`). Run: python3 -m unittest discover -s builder/tests"""
import json, sys, types, unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
import test_producer as tp
import test_twin_legs as tt
from fakes import tx

ALICE, BOB, CAROL = tb.ALICE, tb.BOB, tb.CAROL
ROME, ELSEWHERE = "PAR::rome::1220" + "aa" * 32, "PAR::loop::1220" + "bb" * 32
SUBMISSION, CONFIRMATION, OBSERVATION = ("PARTICIPANT_PERMISSION_" + w for w in ("SUBMISSION", "CONFIRMATION", "OBSERVATION"))


def everyone_on_rome(*parties, permission=SUBMISSION):
    return {p: {ROME: permission} for p in parties}


class Hosted(tb.LegCase):
    """`--hosted-on`: a leg is taken only when every party whose confirmation it needs is hosted, with the right to confirm, on a listed participant."""

    def listed(self, s, *participants):
        s.cfg.hosted_on = participants or (ROME,)
        s.cfg.hosting = b.Hosting(s.cfg, s.cfg.hosted_on)

    def deposit(self, hosting, participants=(ROME,)):
        s = self.setup({ALICE: []})
        s.ledger.requests, s.ledger.tokens = list((tb.REQUEST,)), list((tb.TOKEN,))
        t = self.leg_tx(s, tb.DEP)
        s.reth.pool[ALICE] = [t]
        s.ledger.hosting = hosting
        self.listed(s, *participants)
        return s, t

    def test_a_party_hosted_on_a_listed_participant_has_its_leg_taken(self):
        s, t = self.deposit(everyone_on_rome("d::1"))
        result = self.build(s)
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))
        self.assertEqual(s.ledger.hosting_asked, [("d::1", ROME)])
        self.assertEqual(result["legParties"], {t["hash"]: ["d::1"]})

    def test_a_party_that_is_hosted_nowhere_the_operator_lists_has_its_leg_left_out_with_the_reason(self):
        s, t = self.deposit({"d::1": {ELSEWHERE: SUBMISSION}})
        result = self.assert_left_out(s, t)
        self.assertTrue(result["leftOut"][0]["reason"].startswith("the party d::1 is not hosted with the right to confirm on a participant"), result["leftOut"])
        self.assertIn(ROME, result["leftOut"][0]["reason"])
        self.assertNotIn("has no Canton side", result["leftOut"][0]["reason"])   # it is a whole sentence of its own
        self.assertEqual(self.in_pool(s), {t["hash"]})   # it waits in the pool, as a leg with no Canton side does

    def test_the_right_to_confirm_is_needed_observing_is_not_enough(self):
        s, t = self.deposit(everyone_on_rome("d::1", permission=OBSERVATION))
        self.assert_left_out(s, t, "not hosted with the right to confirm")

    def test_confirmation_without_submission_is_enough(self):
        s, t = self.deposit(everyone_on_rome("d::1", permission=CONFIRMATION))
        self.assertEqual(self.build(s)["legs"], 1)

    def test_the_second_listed_participant_counts_too(self):
        s, t = self.deposit({"d::1": {ELSEWHERE: CONFIRMATION}}, participants=(ROME, ELSEWHERE))
        self.assertEqual(self.build(s)["legs"], 1)
        self.assertEqual(s.ledger.hosting_asked, [("d::1", ROME), ("d::1", ELSEWHERE)])

    def test_a_lookup_that_fails_leaves_the_leg_out_and_says_so(self):
        s, t = self.deposit(everyone_on_rome("d::1"))
        s.ledger.hosting_failure = 500
        result = self.assert_left_out(s, t, "cannot be read")
        self.assertIn("HTTP 500", result["leftOut"][0]["reason"])

    def test_a_participant_connected_to_no_synchronizer_says_nothing_about_hosting(self):
        s, t = self.deposit(everyone_on_rome("d::1"))
        s.ledger.connected = False
        self.assert_left_out(s, t, "cannot be read", "connected to no synchronizer")

    def test_an_answer_is_kept_for_the_next_block_and_a_failed_lookup_is_kept_a_short_while(self):
        s, t = self.deposit(everyone_on_rome("d::1"))
        self.build(s)
        s.cfg.hosting.check("d::1")
        self.assertEqual(len(s.ledger.hosting_asked), 1)
        now = [100.0]
        s.cfg.hosting.clock = lambda: now[0]
        s.cfg.hosting.cache.clear()
        s.ledger.hosting_failure = 503
        self.assertEqual(s.cfg.hosting.check("x::1")[0], "unknown")
        s.ledger.hosting_failure = None
        s.ledger.hosting = everyone_on_rome("x::1")
        now[0] += b.HOSTING_FAILED_TTL - 1
        self.assertEqual(s.cfg.hosting.check("x::1")[0], "unknown")   # not asked again yet
        now[0] += 2
        self.assertEqual(s.cfg.hosting.check("x::1")[0], "hosted")
        now[0] += b.HOSTING_TTL + 1
        s.ledger.hosting = {}
        self.assertEqual(s.cfg.hosting.check("x::1")[0], "foreign")

    def test_nothing_is_asked_when_no_participant_is_listed(self):
        s = self.setup({ALICE: []})
        s.ledger.requests, s.ledger.tokens = list((tb.REQUEST,)), list((tb.TOKEN,))
        s.reth.pool[ALICE] = [self.leg_tx(s, tb.DEP)]
        result = self.build(s)
        self.assertEqual(result["legs"], 1)
        self.assertEqual([g for g in s.ledger.gets if "connected-synchronizers" in g], [])

    def test_the_chains_own_parties_are_not_asked_about(self):
        s = self.setup({ALICE: []}, terms=[("terms-1", {**tb.TERMS[1], "u": "op", "v": "gw"})])
        s.reth.pool[ALICE] = [self.leg_tx(s, tb.PAY)]
        self.listed(s)
        s.ledger.hosting = {}
        result = self.build(s)
        self.assertEqual(result["legs"], 1)
        self.assertEqual(s.ledger.hosting_asked, [])
        self.assertNotIn("legParties", result)

    def test_both_parties_of_payment_terms_must_be_hosted(self):
        for hosted in (("u::1",), ("v::1",), ()):
            with self.subTest(hosted=hosted):
                s = self.setup({ALICE: []}, terms=[tb.TERMS])
                t = self.leg_tx(s, tb.PAY)
                s.reth.pool[ALICE] = [t]
                self.listed(s)
                s.ledger.hosting = everyone_on_rome(*hosted)
                self.assert_left_out(s, t, "not hosted with the right to confirm")
        s = self.setup({ALICE: []}, terms=[tb.TERMS])
        t = self.leg_tx(s, tb.PAY)
        s.reth.pool[ALICE] = [t]
        self.listed(s)
        s.ledger.hosting = everyone_on_rome("u::1", "v::1")
        self.assertEqual(self.build(s)["legParties"], {t["hash"]: ["u::1", "v::1"]})

    def test_a_withdrawals_receiver_must_be_hosted(self):
        s = self.setup({ALICE: []})
        s.ledger.acceptances, s.ledger.tokens, s.ledger.holdings = [tb.ACCEPTANCE], [tb.TOKEN], [tb.holding("h-1", "6.0")]
        t = self.leg_tx(s, tb.WD)
        s.reth.pool[ALICE] = [t]
        self.listed(s)
        s.ledger.hosting = {"r::1": {ELSEWHERE: SUBMISSION}}
        self.assert_left_out(s, t, "the party r::1 is not hosted")
        s.ledger.hosting = everyone_on_rome("r::1")
        s.cfg.hosting.cache.clear()   # the answer is kept for a few minutes: the party has moved since
        result = self.build(s)
        self.assertEqual((result["legs"], result["legParties"]), (1, {t["hash"]: ["r::1"]}))

    def test_a_venue_trades_venue_and_sender_must_be_hosted(self):
        s = self.setup({ALICE: []})
        s.ledger.trades, s.ledger.tokens = list((tb.TRADE,)), list((tb.TOKEN,))
        t = self.leg_tx(s, tb.TRADE_PAY)
        s.reth.pool[ALICE] = [t]
        self.listed(s)
        s.ledger.hosting = everyone_on_rome("venue::1")
        self.assert_left_out(s, t, "the party s::1 is not hosted")

    def test_a_held_party_is_left_out_too(self):
        s, t = self.deposit(everyone_on_rome("d::1"))
        s.cfg.blame = b.PartyBlame(600, clock=lambda: 1_000.0)
        s.cfg.blame.convict("d::1", 1_000.0)
        result = self.assert_left_out(s, t)
        self.assertIn("the party d::1 is held back until", result["leftOut"][0]["reason"])
        self.assertEqual(s.ledger.hosting_asked, [])   # held parties are not even looked up


class TwinParties(tb.LegCase):
    """A lock's receiver and a release's holder must be hosted too, in the block and in the leg check; and a claim names no party."""
    setup_twin = tt.Twins.setup_twin

    def setUp(self):
        super().setUp()
        b.REGISTRY_DOWN.clear()

    def host(self, s, hosting):
        s.cfg.hosted_on = (ROME,)
        s.cfg.hosting = b.Hosting(s.cfg, s.cfg.hosted_on)
        s.ledger.hosting = hosting

    def cases(self):
        yield "a lock's receiver", tt.LOCK, {}
        yield "a redeemer", tt.RELEASE, {"redeems": [tt.REDEEM]}

    def test_the_receiver_of_a_lock_and_the_holder_of_a_redeem_request_must_be_hosted_in_the_block(self):
        for name, leg, k in self.cases():
            with self.subTest(name, hosted=False):
                s, t = self.setup_twin(leg, **k)
                self.host(s, {tt.RECEIVER: {ELSEWHERE: SUBMISSION}})
                result = self.assert_left_out(s, t, f"the party {tt.RECEIVER} is not hosted with the right to confirm")
                self.assertNotIn("legParties", result)
            with self.subTest(name, hosted=True):
                s, t = self.setup_twin(leg, **k)
                self.host(s, everyone_on_rome(tt.RECEIVER))
                result = self.build(s)
                self.assertEqual((result["legs"], result["leftOut"]), (1, []))
                self.assertEqual(result["legParties"], {t["hash"]: [tt.RECEIVER]})   # the block names the party whose participant must confirm

    def test_the_leg_check_refuses_a_party_off_the_operators_participants_for_a_lock_and_a_release(self):
        for name, leg, k in self.cases():
            call = {"from": "0x" + "a1" * 20, "to": "0x" + "c9" * 20, "data": "0x1234", "value": "0x0", "gas": "0x30d40"}
            with self.subTest(name, hosted=False):
                s, t = self.setup_twin(leg, **k)
                s.reth.trace_legs[call["to"]] = [leg]
                self.host(s, {tt.RECEIVER: {ELSEWHERE: SUBMISSION}})
                result = b.leg_check(s.cfg, call)
                self.assertIs(result["ok"], False)
                self.assertIn(f"the party {tt.RECEIVER} is not hosted with the right to confirm", result["reason"])
            with self.subTest(name, hosted=True):
                s, t = self.setup_twin(leg, **k)
                s.reth.trace_legs[call["to"]] = [leg]
                self.host(s, everyone_on_rome(tt.RECEIVER))
                self.assertEqual(b.leg_check(s.cfg, call), {"ok": True})

    def test_a_claim_leg_names_no_party_whatever_an_earlier_leg_left_under_its_id(self):
        """A leg's parties are kept by the id of its dict, and a dict freed in an earlier pass can give its id to a later leg."""
        class Stale(dict):
            def get(self, key, default=None):
                return super().get(key, ("stale::1",))
        original = b.Canton.__init__

        def init(canton, *a, **k):
            original(canton, *a, **k)
            canton.leg_parties = Stale()
        s = self.setup({tb.ALICE: []})
        s.ledger.claims, s.ledger.tokens = [tb.CLAIM], [tb.TOKEN]
        t = self.leg_tx(s, tb.CLAIM_DEP)
        s.reth.pool[tb.ALICE] = [t]
        with mock.patch.object(b.Canton, "__init__", init):
            result = self.build(s)
        self.assertEqual(result["legs"], 1)
        self.assertNotIn("legParties", result)

    def test_the_parties_of_a_pass_are_forgotten_before_the_next(self):
        canton = types.SimpleNamespace(leg_context_bytes={}, leg_disclosed={}, leg_parties={12345: ("old::1",)})
        self.assertEqual(b.match_legs(canton, []), ([], []))
        self.assertEqual(canton.leg_parties, {})


class Timeout(tp.Loop):
    """A block whose Advance fails on a confirmation timeout."""

    def leg_pool(self, **k):
        s = self.setup({ALICE: [], BOB: []}, terms=[tb.TERMS], **k)
        s.ledger.requests, s.ledger.tokens = list((tb.REQUEST,)), list((tb.TOKEN,))
        pay = tx(ALICE, 0, price=9)
        s.reth.tx_legs[pay["hash"]] = [tb.PAY]
        plain = tx(BOB, 0, price=5)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [pay], [plain]
        return s, pay, plain

    def test_a_failed_completion_that_says_timed_out_is_a_refusal_naming_the_legs_parties(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout = "completion"
        result = b.build_block(s.cfg)
        self.assertIs(result["committed"], False)
        self.assertIs(result["rejected"], True)
        self.assertIs(result["timedOut"], True)
        self.assertEqual(result["legParties"], {pay["hash"]: ["u::1", "v::1"]})
        self.assertIn("MEDIATOR_SAYS_TX_TIMED_OUT", result["reason"])
        self.assertEqual(self.in_pool(s), {pay["hash"], plain["hash"]})   # back in reth's pool

    def test_a_timeout_in_a_block_with_no_outside_leg_stays_a_failure_nobody_is_blamed_for(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.ledger.confirm_timeout = "completion"
        result = b.build_block(s.cfg)
        self.assertEqual((result["committed"], result["rejected"], result["timedOut"]), (False, False, True))
        self.assertNotIn("legParties", result)

    def test_a_failure_for_another_reason_is_not_a_timeout(self):
        s, pay, plain = self.leg_pool()
        s.ledger.reply_status = 503
        result = b.build_block(s.cfg)
        self.assertNotIn("timedOut", result)
        self.assertIsNone(result["committed"])   # no answer and no completion: not known, as ever

    def test_a_408_that_the_api_answers_for_a_command_that_then_fails_for_another_reason_is_no_timeout(self):
        s, pay, plain = self.leg_pool()
        s.ledger.late = True   # 408 REQUEST_TIME_OUT: the JSON API's own answer, whatever became of the confirmations
        p = self.producer(s)
        p.step()
        s.ledger.land(ok=False, message="CONTRACT_NOT_FOUND")   # the command's completion: it failed, and not by a timeout
        p.step()
        self.assertEqual(self.reports[-1]["resolved"], "not committed")
        self.assertEqual((p.blame.until, p.blame.suspects), ({}, set()))

    def test_a_proxys_504_page_followed_by_a_completion_that_failed_for_another_reason_is_no_timeout(self):
        s, pay, plain = self.leg_pool()
        s.ledger.late = True
        s.ledger.late_reply = (504, {"cause": "<html><h1>504 Gateway Time-out</h1></html>"})
        p = self.producer(s)
        p.step()
        s.ledger.land(ok=False, message="CONTRACT_NOT_FOUND")   # the command's completion: a refusal of its own, and not by a timeout
        p.step()
        self.assertEqual(self.reports[-1]["resolved"], "not committed")
        self.assertNotIn("timedOut", self.reports[-1])
        self.assertEqual((p.blame.until, p.blame.suspects), ({}, set()))

    def test_a_proxys_504_page_and_a_completion_that_is_a_refusal_of_its_own_is_no_timeout_when_both_are_read_at_once(self):
        s, pay, plain = self.leg_pool()
        s.ledger.reply_status, s.ledger.reply_status_cause = 504, "<html><h1>504 Gateway Time-out</h1></html>"
        s.ledger.reply_status_completion = "CONTRACT_NOT_FOUND: a refusal of one transaction's leg"
        result = b.build_block(s.cfg)
        self.assertEqual((result["committed"], result["rejected"]), (False, False))
        self.assertNotIn("timedOut", result)   # nobody is blamed: the parties of the legs stay clear

    def test_a_proxys_504_page_followed_by_a_completion_that_says_the_confirmations_timed_out_is_one(self):
        s, pay, plain = self.leg_pool()
        s.ledger.late = True
        s.ledger.late_reply = (504, {"cause": "<html><h1>504 Gateway Time-out</h1></html>"})
        p = self.producer(s)
        p.step()
        s.ledger.land(ok=False, message="MEDIATOR_SAYS_TX_TIMED_OUT(2,ab): no confirmations")
        p.step()
        self.assertEqual(p.blame.suspects, {"u::1", "v::1"})

    def test_a_definite_rejection_that_names_the_mediators_timeout_is_one(self):
        s, pay, plain = self.leg_pool()
        s.ledger.refuse = "MEDIATOR_SAYS_TX_TIMED_OUT(2,ab): the mediator did not receive sufficient confirmations"
        result = b.build_block(s.cfg)
        self.assertEqual((result["committed"], result["rejected"], result.get("timedOut")), (False, True, True))

    def test_a_definite_rejection_that_names_the_timeout_in_a_block_with_no_outside_leg_blames_nobody(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.ledger.refuse = "MEDIATOR_SAYS_TX_TIMED_OUT(2,ab): the mediator did not receive sufficient confirmations"
        result = b.build_block(s.cfg)
        self.assertEqual((result["committed"], result["rejected"], result.get("timedOut")), (False, False, True))
        self.assertNotIn("legParties", result)

    def test_the_loop_counts_such_a_rejection_as_a_failure_and_holds_nothing_back(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.ledger.refuse = "MEDIATOR_SAYS_TX_TIMED_OUT(2,ab): the mediator did not receive sufficient confirmations"
        p = self.producer(s)
        for _ in range(3):
            p.step()
        self.assertEqual((p.excluded, p.suspects, p.blame.suspects, p.blame.held()), ({}, [], set(), {}))
        self.assertEqual((p.failures, p.refused), (3, 0))

    def test_no_completion_for_the_whole_window_is_not_a_confirmation_timeout(self):
        """A mediator's timeout always gives the submitting participant a failed completion: no completion at all points at the operator's own side (a command
        never taken, a restart, a synchronizer upgrade), so nobody's party is blamed for it."""
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout = "none"   # 408 and no completion
        p = self.producer(s)
        p.step()
        self.assertIsNone(self.reports[-1]["committed"])
        s.ledger.no_completion = True
        self.now[0] += 10_000
        s.ledger.record_time = "2100-01-01T00:00:00.000000Z"   # Canton's checkpoints are past the window
        with mock.patch.object(b, "builder_now", lambda: 4102444800.0):
            p.step()
        self.assertEqual(self.reports[-1]["resolved"], "not committed")
        self.assertEqual((p.blame.until, p.blame.suspects, p.blame.live), ({}, set(), set()))
        self.assertEqual(p.status()["heldParties"], {})

    def test_a_command_that_was_not_sequenced_in_time_is_not_a_confirmation_timeout(self):
        self.assertTrue(b.confirmation_timeout("MEDIATOR_SAYS_TX_TIMED_OUT(2,ab): the mediator did not receive sufficient confirmations"))
        self.assertTrue(b.confirmation_timeout("LOCAL_VERDICT_TIMEOUT"))
        self.assertFalse(b.confirmation_timeout("The request timed out"))   # only Canton's own codes count
        self.assertFalse(b.confirmation_timeout("<html><h1>504 Gateway Time-out</h1></html>"))
        self.assertFalse(b.confirmation_timeout("SEQUENCER_REQUEST_TIMEOUT"))
        self.assertFalse(b.confirmation_timeout("Database task timed out"))
        self.assertFalse(b.confirmation_timeout("NOT_SEQUENCED_TIMEOUT(2,ab): the command was not sequenced in time"))
        self.assertFalse(b.confirmation_timeout('{"code": "REQUEST_TIME_OUT", "cause": "The server was not able to produce a timely response"}'))   # the JSON API's own 408
        self.assertFalse(b.confirmation_timeout("CONTRACT_NOT_FOUND"))
        self.assertFalse(b.confirmation_timeout(None))

    # -- the loop
    def test_the_loop_holds_the_party_back_and_the_chain_goes_on_without_its_leg(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout = "completion"
        p = self.producer(s)
        p.step()
        self.assertEqual((self.reports[-1]["committed"], self.reports[-1]["timedOut"]), (False, True))
        self.assertEqual(p.previous_kept, set())          # no transaction is a suspect of a timeout
        self.assertEqual(p.suspects, [])
        self.assertEqual(p.excluded, {})
        self.assertEqual(p.blame.suspects, {"u::1", "v::1"})   # two parties: half of them are tried
        self.assertEqual(p.blame.live, {"u::1"})
        self.assertEqual(p.status()["heldParties"], {"v::1": {"waiting": True}})
        s.ledger.confirm_timeout = None
        self.now[0] += 2.0   # the failure's pause
        p.step()
        # v::1 waits, so the payment, whose terms name u::1 and v::1, is left out and the plain transaction goes in: the chain is not stalled
        last = self.reports[-1]
        self.assertTrue(last["committed"], last)
        self.assertEqual(last["transactions"], [plain["hash"]])
        self.assertIn("the party v::1 waits", last["leftOut"][0]["reason"])

    def test_one_party_alone_is_convicted_at_once_with_a_cool_down_that_grows(self):
        s = self.setup({ALICE: []})
        s.ledger.requests, s.ledger.tokens = list((tb.REQUEST,)), list((tb.TOKEN,))
        t = tx(ALICE, 0)
        s.reth.tx_legs[t["hash"]] = [tb.DEP]
        s.reth.pool[ALICE] = [t]
        s.ledger.confirm_timeout = "completion"
        p = self.producer(s, cooldown=600)
        p.step()
        self.assertEqual(p.blame.until, {"d::1": self.now[0] + 600})
        self.assertEqual(p.status()["heldParties"], {"d::1": {"until": b.iso(self.now[0] + 600), "strikes": 1}})
        # held: the deposit waits, and the loop makes no block for it
        s.ledger.confirm_timeout = None
        before = len(s.ledger.submitted)
        self.now[0] += 5; p.step(); p.step()
        self.assertEqual(len(s.ledger.submitted), before)
        self.assertEqual(self.in_pool(s), {t["hash"]})
        # the cool-down is over: it goes in once more, times out once more, and is held twice as long
        self.now[0] += 601
        s.ledger.confirm_timeout = "completion"
        p.step()
        self.assertEqual(p.blame.strikes["d::1"], 2)
        self.assertEqual(p.blame.until["d::1"], self.now[0] + 1200)
        self.assertEqual(self.in_pool(s), {t["hash"]})

    def test_a_party_that_answers_in_time_is_cleared_and_goes_on(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout = "completion"
        p = self.producer(s)
        p.step()
        s.ledger.confirm_timeout = None
        # u::1 is on trial, v::1 waits: a block that carries a leg of u::1 only (a deposit request of u::1) is answered, which clears u::1
        dep_id = b.deposit_id_of("u::1", "dep-1")
        s.ledger.requests = [("req-9", {**tb.REQUEST[1], "depositor": "u::1", "depositId": dep_id})]
        dep = tx(CAROL, 0, price=7)
        s.reth.tx_legs[dep["hash"]] = [tb.Leg(tb.DEPOSIT, dep_id, tb.WTKB, tb.PAYEE, 10 * tb.UNIT)]
        s.reth.pool[CAROL] = [dep]
        self.now[0] += 2.0
        p.step()
        self.assertTrue(self.reports[-1]["committed"], self.reports[-1])
        self.assertEqual(self.reports[-1]["legParties"], {dep["hash"]: ["u::1"]})
        self.assertEqual((p.blame.suspects, p.blame.live), ({"v::1"}, {"v::1"}))   # u::1 is cleared, v::1 is the one left to try

    def test_a_block_whose_reply_was_lost_and_that_later_committed_clears_a_party_on_trial(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout = "completion"
        p = self.producer(s)
        p.step()
        self.assertEqual((p.blame.suspects, p.blame.live), ({"u::1", "v::1"}, {"u::1"}))
        s.ledger.confirm_timeout = "none"   # 408 and no completion: not known
        dep_id = b.deposit_id_of("u::1", "dep-1")
        s.ledger.requests = [("req-9", {**tb.REQUEST[1], "depositor": "u::1", "depositId": dep_id})]
        dep = tx(CAROL, 0, price=7)
        s.reth.tx_legs[dep["hash"]] = [tb.Leg(tb.DEPOSIT, dep_id, tb.WTKB, tb.PAYEE, 10 * tb.UNIT)]
        s.reth.pool[CAROL] = [dep]
        self.now[0] += 2.0
        p.step()
        self.assertIsNone(self.reports[-1]["committed"])
        self.assertEqual(p.unresolved["legParties"], {dep["hash"]: ["u::1"]})
        self.assertEqual((p.blame.suspects, p.blame.live), ({"u::1", "v::1"}, {"u::1"}))   # still on trial: nothing is known yet
        command = p.unresolved["commandId"]
        s.ledger.outcomes[command] = {"commandId": command, "offset": 44, "updateId": "u2", "status": {}}
        p.step()   # settled by the completion: committed
        self.assertEqual(self.reports[-1]["resolved"], "committed")
        self.assertEqual((p.blame.suspects, p.blame.live), ({"v::1"}, {"v::1"}))   # u::1 is cleared

    def refused_block_of_a_party_on_trial(self, cause):
        """u::1 is on trial and v::1 waits; the next block carries a deposit of u::1 only, and Canton refuses it with this cause."""
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout = "completion"
        p = self.producer(s)
        p.step()
        s.ledger.confirm_timeout = None
        dep_id = b.deposit_id_of("u::1", "dep-1")
        s.ledger.requests = [("req-9", {**tb.REQUEST[1], "depositor": "u::1", "depositId": dep_id})]
        dep = tx(CAROL, 0, price=7)
        s.reth.tx_legs[dep["hash"]] = [tb.Leg(tb.DEPOSIT, dep_id, tb.WTKB, tb.PAYEE, 10 * tb.UNIT)]
        s.reth.pool[CAROL] = [dep]
        s.ledger.refuse = cause
        self.now[0] += 2.0
        p.step()
        self.assertIs(self.reports[-1]["committed"], False, self.reports[-1])
        self.assertEqual(self.reports[-1]["legParties"], {dep["hash"]: ["u::1"]})
        return p

    def test_a_refusal_before_any_confirmation_was_asked_for_does_not_clear_a_party_on_trial(self):
        """CONTRACT_NOT_FOUND is the submitting participant's own reading: a party that archives its own contract could otherwise clear itself."""
        p = self.refused_block_of_a_party_on_trial("CONTRACT_NOT_FOUND(11,ab): the contract was archived")
        self.assertEqual((p.blame.suspects, p.blame.live), ({"u::1", "v::1"}, {"u::1"}))   # still on trial

    def test_a_refusal_of_the_confirmation_phase_clears_a_party_on_trial(self):
        p = self.refused_block_of_a_party_on_trial("LOCAL_VERDICT_INACTIVE_CONTRACTS(5,ab): a contract is not active")
        self.assertEqual((p.blame.suspects, p.blame.live), ({"v::1"}, {"v::1"}))

    def test_the_words_of_a_refusal_of_the_confirmation_phase(self):
        self.assertTrue(b.confirmation_refusal("LOCAL_VERDICT_LOCKED_CONTRACTS(5,x): locked"))
        for text in (None, "", "CONTRACT_NOT_FOUND", "LOCAL_VERDICT_TIMEOUT(5,x): late", "MEDIATOR_SAYS_TX_TIMED_OUT"):
            with self.subTest(text):
                self.assertFalse(b.confirmation_refusal(text))

    def test_an_unknown_outcome_that_ends_as_a_confirmation_timeout_blames_the_parties_too(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout = "none"   # 408 and no completion: not known
        p = self.producer(s)
        p.step()
        self.assertIsNone(self.reports[-1]["committed"])
        self.assertEqual(p.unresolved["legParties"], {pay["hash"]: ["u::1", "v::1"]})
        s.ledger.outcomes[p.unresolved["commandId"]] = {"commandId": p.unresolved["commandId"], "offset": 43, "status": {"code": 10, "message": "MEDIATOR_SAYS_TX_TIMED_OUT(2,ab): timed out"}}
        p.step()   # settled by the completion
        self.assertEqual(self.reports[-1]["resolved"], "not committed")
        self.assertEqual(p.blame.live, {"u::1"})
        self.assertEqual(p.blame.suspects, {"u::1", "v::1"})

    def test_a_status_file_names_the_parties_held(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout = "completion"
        p = self.producer(s)
        p.step()
        self.assertEqual(self.status()["heldParties"], {"v::1": {"waiting": True}})

    def test_a_party_that_is_not_hosted_on_the_operators_participants_is_held_at_once(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout = "completion"
        s.ledger.hosting = {"u::1": {ROME: SUBMISSION}, "v::1": {ELSEWHERE: SUBMISSION}}   # v::1 moved elsewhere after the leg was taken
        s.cfg.hosted_on = (ROME,)
        s.cfg.hosting = b.Hosting(s.cfg, s.cfg.hosted_on)
        s.cfg.hosting.cache["v::1"] = (float("inf"), "hosted", None)   # the old answer, from before it moved
        s.cfg.hosting.cache["u::1"] = (float("inf"), "hosted", None)
        p = self.producer(s)
        p.step()
        self.assertEqual(set(p.blame.until), {"v::1"})   # asked again without the cache: v::1 is held, u::1 is not
        self.assertEqual((p.blame.suspects, p.blame.live), (set(), set()))


ERROR_INFO, RETRY_INFO, REQUEST_INFO = (f"type.googleapis.com/google.rpc.{k}" for k in ("ErrorInfo", "RetryInfo", "RequestInfo"))


class NamedTimeout(tp.Loop):
    """The mediator's timeout names the parties that did not confirm (Canton 3.7.2, read on a local network with a participant that stopped answering): only those of the
    block's legs are held back, whatever else the block carried. The completion's ErrorInfo detail and the JSON API's error body are built as Canton words them."""
    leg_pool = Timeout.leg_pool

    def journal_lines(self, s, kind):
        folder = Path(s.cfg.work_dir) / "journal"
        return [x for x in (json.loads(l) for f in sorted(folder.glob("*.jsonl")) for l in f.read_text().splitlines()) if x.get("event") == kind]

    def test_only_the_party_the_mediator_names_is_held_back(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout, s.ledger.confirm_names = "completion", ["v::1"]
        p = self.producer(s)
        p.step()
        self.assertEqual(self.reports[-1]["unresponsive"], ["v::1"])
        self.assertEqual(p.blame.until, {"v::1": self.now[0] + 600})
        self.assertEqual((p.blame.suspects, p.blame.live), (set(), set()))   # no trial: u::1 is not suspected
        self.assertEqual(p.status()["heldParties"], {"v::1": {"until": b.iso(self.now[0] + 600), "strikes": 1}})
        held = self.journal_lines(s, "party_held")
        self.assertEqual([(x["party"], x["strikes"]) for x in held], [("v::1", 1)])
        self.assertIn("mediator names it", held[0]["reason"])
        self.assertEqual(self.journal_lines(s, "timeout_no_blame"), [])
        s.ledger.confirm_timeout = None
        self.now[0] += 2.0
        p.step()   # the payment names v::1, so it is left out; the plain transaction goes in
        self.assertEqual(self.reports[-1]["transactions"], [plain["hash"]])
        self.assertIn("the party v::1 is held back", self.reports[-1]["leftOut"][0]["reason"])

    def test_the_other_party_of_the_block_is_not_put_on_trial_but_goes_on(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout, s.ledger.confirm_names = "completion", ["u::1"]
        p = self.producer(s)
        p.step()
        self.assertEqual(set(p.blame.until), {"u::1"})
        self.assertNotIn("v::1", p.status()["heldParties"])

    def test_every_leg_party_the_mediator_names_is_held_back(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout, s.ledger.confirm_names = "completion", ["u::1", "v::1"]
        p = self.producer(s)
        p.step()
        self.assertEqual(set(p.blame.until), {"u::1", "v::1"})

    def test_a_definite_rejection_names_them_in_its_context(self):
        s, pay, plain = self.leg_pool()
        s.ledger.refuse_timeout, s.ledger.confirm_names = True, ["u::1"]
        p = self.producer(s)
        p.step()
        self.assertEqual((self.reports[-1]["rejected"], self.reports[-1]["timedOut"], self.reports[-1]["unresponsive"]), (True, True, ["u::1"]))
        self.assertEqual(set(p.blame.until), {"u::1"})
        self.assertEqual((p.blame.suspects, p.blame.live), (set(), set()))

    def test_a_completion_that_comes_after_the_api_gave_up_names_them_too(self):
        s, pay, plain = self.leg_pool()
        s.ledger.late = True   # the JSON API answers 503 before the mediator's timeout (20 s against 30 s on a default synchronizer): the completion says it
        p = self.producer(s)
        p.step()
        s.ledger.confirm_names = ["v::1"]
        s.ledger.land(ok=False, status=s.ledger.timeout_status())
        p.step()
        self.assertEqual(self.reports[-1]["resolved"], "not committed")
        self.assertEqual(set(p.blame.until), {"v::1"})
        self.assertEqual((p.blame.suspects, p.blame.live), (set(), set()))

    def test_a_party_the_mediator_names_that_has_no_leg_in_the_block_holds_nobody_and_is_journaled(self):
        """An instrument's admin, the operator's own party or an outside participant's: none of the block's users is blamed for it, for as many timeouts in a row as the limit allows."""
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout, s.ledger.confirm_names = "completion", ["dso::1220" + "ab" * 32]
        p = self.producer(s)
        for _ in range(3):
            p.step()
            self.now[0] += 2.0
        self.assertEqual((p.blame.until, p.blame.suspects, p.blame.held()), ({}, set(), {}))
        self.assertEqual((p.failures, p.refused), (0, 3))   # three refused blocks, and no party is held
        lines = self.journal_lines(s, "timeout_no_blame")
        self.assertEqual(len(lines), 3)
        self.assertEqual((lines[0]["code"], lines[0]["unresponsive"], lines[0]["legParties"]), ("MEDIATOR_SAYS_TX_TIMED_OUT", ["dso::1220" + "ab" * 32], 2))
        self.assertEqual(self.journal_lines(s, "party_held"), [])
        s.ledger.confirm_timeout = None
        p.step()
        self.assertTrue(self.reports[-1]["committed"])   # the leg is in the block again, and is not held

    def test_the_operators_own_participant_timing_out_holds_no_user(self):
        """The mediator names every confirmer still missing: when the operator's own participant does not answer in time (a restart, an overload), the chain's own
        parties are named together with every user hosted only there. No user is held for it, and the legs go in again with the next block."""
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout, s.ledger.confirm_names = "completion", ["operator::1", "gateway::1", "u::1", "v::1"]
        p = self.producer(s)
        p.step()
        self.assertEqual(self.reports[-1]["unresponsive"], ["operator::1", "gateway::1", "u::1", "v::1"])
        self.assertEqual((p.blame.until, p.blame.suspects, p.blame.live, p.blame.held(), p.status()["heldParties"]), ({}, set(), set(), {}, {}))
        self.assertEqual(self.journal_lines(s, "party_held"), [])
        line = self.journal_lines(s, "timeout_no_blame")[0]
        self.assertEqual((line["unresponsive"], line["legParties"]), (["operator::1", "gateway::1", "u::1", "v::1"], 2))
        self.assertIn("users it names are not blamed", line["reason"])
        s.ledger.confirm_timeout = None
        self.now[0] += 2.0
        p.step()
        self.assertTrue(self.reports[-1]["committed"])   # the participant is back: the same legs, not left out

    def test_one_user_and_the_operators_own_party_named_together_holds_nobody_either(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout, s.ledger.confirm_names = "completion", ["operator::1", "u::1"]
        p = self.producer(s)
        p.step()
        self.assertEqual((p.blame.until, p.blame.suspects), ({}, set()))
        self.assertEqual(len(self.journal_lines(s, "timeout_no_blame")), 1)

    def test_such_timeouts_count_toward_the_limit_and_then_the_users_go_on_trial(self):
        """The limit is the builder's defence against words it cannot check; an outage of the operator's participant that outlasts it puts the users on trial."""
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout, s.ledger.confirm_names = "completion", ["operator::1", "u::1", "v::1"]
        p = self.producer(s)
        for _ in range(3):
            p.step()
            self.now[0] += 2.0
            self.assertEqual((p.blame.until, p.blame.suspects), ({}, set()))
        p.step()
        self.assertEqual((p.blame.until, p.blame.suspects), ({}, {"u::1", "v::1"}))
        self.assertIn("in a row held nobody back", self.journal_lines(s, "timeout_no_blame")[-1]["reason"])

    def test_a_status_that_names_parties_and_that_canton_would_not_decode_names_nobody(self):
        """A participant chooses the status of its rejection, and Canton adds the participant's keys only to a status it decodes: one with two ErrorInfo details or
        no integer category passes through without them, and must not name users to hold."""
        info = {"reason": "MEDIATOR_SAYS_TX_TIMED_OUT", "domain": "", "metadata": {"unresponsiveParties": "v::1", "category": "2"}}
        forged = {
            "two ErrorInfo": [{"typeUrl": ERROR_INFO, "valueDecoded": info}, {"typeUrl": ERROR_INFO, "valueDecoded": info}],
            "no category": [{"typeUrl": ERROR_INFO, "valueDecoded": {**info, "metadata": {"unresponsiveParties": "v::1"}}}],
            "category not a number": [{"typeUrl": ERROR_INFO, "valueDecoded": {**info, "metadata": {"unresponsiveParties": "v::1", "category": "two"}}}],
            "two RetryInfo": [{"typeUrl": ERROR_INFO, "valueDecoded": info}, {"typeUrl": RETRY_INFO, "valueDecoded": {}}, {"typeUrl": RETRY_INFO, "valueDecoded": {}}],
            "two RequestInfo": [{"typeUrl": ERROR_INFO, "valueDecoded": info}, {"typeUrl": REQUEST_INFO, "valueDecoded": {}}, {"typeUrl": REQUEST_INFO, "valueDecoded": {}}],
            "no type": [{"valueDecoded": info}],
        }
        for what, details in forged.items():
            with self.subTest(what):
                status = {"code": 10, "message": "MEDIATOR_SAYS_TX_TIMED_OUT(2,0): x", "details": details}
                self.assertIsNone(b.unresponsive_of_status(status))
                self.assertTrue(b.reported_in_status(status))
                s, pay, plain = self.leg_pool()
                s.ledger.confirm_timeout = "completion"
                s.ledger.timeout_status = lambda status=status: status
                p = self.producer(s)
                p.step()
                self.assertEqual((self.reports[-1]["timedOut"], self.reports[-1]["reportedByParticipant"]), (True, True))
                self.assertNotIn("unresponsive", self.reports[-1])
                self.assertEqual(p.blame.until, {})   # v::1 is not held on that word
                self.assertEqual(p.blame.suspects, {"u::1", "v::1"})   # the parties of the block are on trial instead
                self.assertIn("a participant's own", self.journal_lines(s, "timeout_no_blame")[0]["reason"])

    def test_the_status_canton_gives_decodes_and_extra_kinds_of_detail_do_not_break_it(self):
        info = {"reason": "MEDIATOR_SAYS_TX_TIMED_OUT", "domain": "", "metadata": {"unresponsiveParties": "v::1", "category": "2"}}
        for details in ([{"typeUrl": ERROR_INFO, "valueDecoded": info}],
                        [{"typeUrl": ERROR_INFO, "valueDecoded": info}, {"typeUrl": RETRY_INFO, "valueDecoded": {}}],
                        [{"typeUrl": ERROR_INFO, "valueDecoded": info}, {"typeUrl": REQUEST_INFO, "valueDecoded": {}}, {"typeUrl": RETRY_INFO, "valueDecoded": {}}],
                        [{"typeUrl": ERROR_INFO, "valueDecoded": info}, {"typeUrl": "type.googleapis.com/google.rpc.ResourceInfo", "valueDecoded": {}}]):
            status = {"details": details}
            self.assertTrue(b.decodes_as_canton_error(status))
            self.assertEqual(b.unresponsive_of_status(status), ["v::1"])
            self.assertFalse(b.reported_in_status(status))
        for status in ({}, None, "x", {"details": None}, {"details": []}, {"details": ["x"]}):
            self.assertFalse(b.decodes_as_canton_error(status))
            self.assertFalse(b.reported_in_status(status))   # nothing is named, so nothing is forged

    def test_after_the_limit_of_timeouts_in_a_row_that_held_nobody_the_parties_go_on_trial(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout, s.ledger.confirm_names = "completion", ["dso::1220" + "ab" * 32]
        p = self.producer(s, no_blame_limit=2)
        for _ in range(2):
            p.step()
            self.now[0] += 2.0
        self.assertEqual((p.blame.suspects, len(self.journal_lines(s, "timeout_no_blame"))), (set(), 2))
        p.step()   # the third: the trial, as for a timeout that names nobody
        self.assertEqual((p.blame.suspects, p.blame.live), ({"u::1", "v::1"}, {"u::1"}))
        line = self.journal_lines(s, "timeout_no_blame")[-1]
        self.assertIn("2 timeouts in a row", line["reason"])
        self.assertEqual(p.blame.silent, 2)   # the row stays at the limit until a party is held or a block is answered

    def test_the_limit_is_for_a_row_a_block_answered_by_canton_ends_it(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout, s.ledger.confirm_names = "completion", ["dso::1220" + "ab" * 32]
        p = self.producer(s)
        for _ in range(2):
            p.step()
            self.now[0] += 2.0
        self.assertEqual(p.blame.silent, 2)
        s.ledger.confirm_timeout = None
        p.step()
        self.assertTrue(self.reports[-1]["committed"])
        self.assertEqual(p.blame.silent, 0)

    def test_a_limit_of_zero_puts_the_parties_on_trial_at_once(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout, s.ledger.confirm_names = "completion", ["dso::1220" + "ab" * 32]
        p = self.producer(s, no_blame_limit=0)
        p.step()
        self.assertEqual((p.blame.suspects, p.blame.live), ({"u::1", "v::1"}, {"u::1"}))

    def test_a_party_the_mediator_names_is_held_whatever_the_count_of_timeouts_that_held_nobody(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout, s.ledger.confirm_names = "completion", ["dso::1220" + "ab" * 32]
        p = self.producer(s, no_blame_limit=1)
        p.step()
        self.now[0] += 2.0
        s.ledger.confirm_names = ["v::1"]
        p.step()
        self.assertEqual(set(p.blame.until), {"v::1"})

    def test_words_a_participant_wrote_name_nobody_and_go_to_trial(self):
        """A confirming participant chooses the status of its own rejection, and Canton adds `reported_by_participant_id` and `confirming_parties` to it: a forged
        MEDIATOR_SAYS_TX_TIMED_OUT that names a user, or a LOCAL_VERDICT_TIMEOUT, must not hold that user or stall the blocks without end."""
        for code, names in (("MEDIATOR_SAYS_TX_TIMED_OUT", ["v::1"]), ("MEDIATOR_SAYS_TX_TIMED_OUT", ["dso::1220" + "ab" * 32]), ("LOCAL_VERDICT_TIMEOUT", None)):
            with self.subTest(code=code, names=names):
                s, pay, plain = self.leg_pool()
                s.ledger.confirm_timeout, s.ledger.timeout_code, s.ledger.confirm_names, s.ledger.confirm_reported = "completion", code, names, True
                p = self.producer(s)
                p.step()
                self.assertEqual(self.reports[-1]["timedOut"], True)
                self.assertNotIn("unresponsive", self.reports[-1])
                self.assertTrue(self.reports[-1]["reportedByParticipant"])
                self.assertEqual(p.blame.until, {})   # nobody is held on its word
                self.assertEqual((p.blame.suspects, p.blame.live), ({"u::1", "v::1"}, {"u::1"}))   # the parties are on trial, as for any timeout that names nobody
                self.assertIn("a participant's own", self.journal_lines(s, "timeout_no_blame")[0]["reason"])

    def test_a_definite_rejection_a_participant_wrote_goes_to_trial_too(self):
        s, pay, plain = self.leg_pool()
        s.ledger.refuse_timeout, s.ledger.confirm_names, s.ledger.confirm_reported = True, ["v::1"], True
        p = self.producer(s)
        p.step()
        self.assertEqual((self.reports[-1]["rejected"], self.reports[-1]["timedOut"], self.reports[-1]["reportedByParticipant"]), (True, True, True))
        self.assertNotIn("unresponsive", self.reports[-1])
        self.assertEqual((p.blame.until, p.blame.suspects), ({}, {"u::1", "v::1"}))

    def test_a_completion_that_comes_after_the_api_gave_up_and_a_participant_wrote_goes_to_trial(self):
        s, pay, plain = self.leg_pool()
        s.ledger.late = True
        p = self.producer(s)
        p.step()
        s.ledger.confirm_names, s.ledger.confirm_reported = ["v::1"], True
        s.ledger.land(ok=False, status=s.ledger.timeout_status())
        p.step()
        self.assertEqual(self.reports[-1]["resolved"], "not committed")
        self.assertEqual((p.blame.until, p.blame.suspects), ({}, {"u::1", "v::1"}))

    def test_the_participants_own_timeout_names_no_party_and_blames_nobody(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout, s.ledger.timeout_code = "completion", "LOCAL_VERDICT_TIMEOUT"
        p = self.producer(s)
        p.step()
        self.assertEqual((self.reports[-1]["timedOut"], self.reports[-1]["timeoutCode"]), (True, "LOCAL_VERDICT_TIMEOUT"))
        self.assertEqual((p.blame.until, p.blame.suspects, p.blame.held()), ({}, set(), {}))
        self.assertEqual(self.journal_lines(s, "timeout_no_blame")[0]["code"], "LOCAL_VERDICT_TIMEOUT")

    def test_a_mediator_timeout_that_names_nobody_still_puts_the_parties_on_trial_and_is_journaled(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout = "completion"   # no names
        p = self.producer(s)
        p.step()
        self.assertEqual((p.blame.suspects, p.blame.live), ({"u::1", "v::1"}, {"u::1"}))
        line = self.journal_lines(s, "timeout_no_blame")[0]
        self.assertEqual((line["unresponsive"], line["legParties"]), ([], 2))
        self.assertIn("on trial", line["reason"])

    def test_the_names_come_only_from_the_structured_detail_never_from_the_words_of_the_message(self):
        s, pay, plain = self.leg_pool()
        s.ledger.confirm_timeout = "completion"
        s.ledger.timeout_status = lambda: {"code": 10, "message": "MEDIATOR_SAYS_TX_TIMED_OUT(2,0): unresponsiveParties=v::1", "details": []}
        p = self.producer(s)
        p.step()
        self.assertNotIn("unresponsive", self.reports[-1])
        self.assertEqual((p.blame.until, p.blame.suspects), ({}, {"u::1", "v::1"}))   # a trial, as for any timeout that names nobody

    def test_the_status_of_a_real_completion_and_the_body_of_a_real_rejection(self):
        """As Canton 3.7.2 gave them on a local network (the party ids are of that run)."""
        party = "silent::12203617d89b76655b0d73dfbb6ac1b431cbfe77cdf16d11bb66a79b7cf50cf288d5"
        status = {"code": 10, "message": "MEDIATOR_SAYS_TX_TIMED_OUT(2,0): Rejected transaction as the mediator did not receive sufficient confirmations within the expected timeframe.",
                  "details": [{"typeUrl": "type.googleapis.com/google.rpc.ErrorInfo", "value": "ChpNRURJQVRPUl9TQVlTX1RYX1RJTUVEX09VVBpjChN1bnJlc3BvbnNpdmVQYXJ0aWVz",
                               "valueDecoded": {"reason": "MEDIATOR_SAYS_TX_TIMED_OUT", "domain": "", "metadata": {"unresponsiveParties": party, "category": "2"}}},
                              {"typeUrl": "type.googleapis.com/google.rpc.RetryInfo", "value": "CgIIAQ==", "valueDecoded": {"retryDelay": {"seconds": 1, "nanos": 0}}}]}
        self.assertEqual(b.unresponsive_of_status(status), [party])
        found, _, _ = b.completion_in([{"completionResponse": {"Completion": {"value": {"commandId": "c1", "status": status, "offset": 44}}}}], "c1")
        self.assertEqual((found["committed"], found["unresponsive"]), (False, [party]))
        self.assertEqual(b.timeout_code(found["reason"]), "MEDIATOR_SAYS_TX_TIMED_OUT")
        body = json.dumps({"code": "MEDIATOR_SAYS_TX_TIMED_OUT", "cause": "Rejected transaction as the mediator did not receive sufficient confirmations within the expected timeframe.",
                           "correlationId": None, "traceId": None, "context": {"unresponsiveParties": party, "category": "2"}, "resources": [], "errorCategory": 2,
                           "grpcCodeValue": 10, "retryInfo": "1 second", "definiteAnswer": None})
        self.assertEqual(b.unresponsive_of_body(body), [party])

    def test_two_parties_are_joined_by_a_comma_and_what_does_not_name_a_party_names_none(self):
        two = "silent2::1220aa,silent::1220aa"
        self.assertEqual(b.unresponsive_in({"unresponsiveParties": two}), ["silent2::1220aa", "silent::1220aa"])
        for metadata in (None, {}, {"unresponsiveParties": ""}, {"unresponsiveParties": " , "}, {"unresponsiveParties": 5}, {"unresponsiveParties": ["a"]}, "text"):
            self.assertIsNone(b.unresponsive_in(metadata))
        named = lambda reason: {"details": [{"typeUrl": ERROR_INFO, "valueDecoded": {"reason": reason, "metadata": {"unresponsiveParties": "a::1", "category": "2"}}}]}
        self.assertEqual(b.unresponsive_of_status(named("MEDIATOR_SAYS_TX_TIMED_OUT")), ["a::1"])
        for status in (named("LOCAL_VERDICT_TIMEOUT"), named("CONTRACT_NOT_FOUND"), {"details": None}, {"details": ["x", 3]}, {"details": [{"typeUrl": ERROR_INFO, "valueDecoded": "x"}]}, {}, None, "x"):
            self.assertIsNone(b.unresponsive_of_status(status))
        self.assertIsNone(b.unresponsive_of_body("not json"))
        self.assertIsNone(b.unresponsive_of_body(None))
        self.assertIsNone(b.unresponsive_of_body(json.dumps(["MEDIATOR_SAYS_TX_TIMED_OUT"])))
        self.assertIsNone(b.unresponsive_of_body(json.dumps({"code": "CONTRACT_NOT_FOUND", "context": {"unresponsiveParties": "a::1"}})))
        self.assertIsNone(b.unresponsive_of_body(json.dumps({"code": "MEDIATOR_SAYS_TX_TIMED_OUT", "context": "x"})))

    def test_what_a_participant_wrote_names_nobody(self):
        keys = {"reported_by_participant_id": "PAR::x::1220aa", "confirming_parties": "a::1"}
        self.assertFalse(b.reported_in({"unresponsiveParties": "a::1", "category": "2"}))
        for metadata in (None, {}, "x", {"unresponsiveParties": "a::1"}):
            self.assertFalse(b.reported_in(metadata))
        for key in keys:
            self.assertTrue(b.reported_in({key: "x", "unresponsiveParties": "a::1"}))
            self.assertIsNone(b.unresponsive_in({key: "x", "unresponsiveParties": "a::1"}))
        status = {"details": [{"typeUrl": ERROR_INFO, "valueDecoded": {"reason": "MEDIATOR_SAYS_TX_TIMED_OUT", "metadata": {"unresponsiveParties": "a::1", "category": "2", **keys}}}]}
        self.assertTrue(b.reported_in_status(status))
        self.assertIsNone(b.unresponsive_of_status(status))
        found, _, _ = b.completion_in([{"completionResponse": {"Completion": {"value": {"commandId": "c1", "status": {**status, "code": 10, "message": "m"}, "offset": 4}}}}], "c1")
        self.assertEqual((found["reportedByParticipant"], "unresponsive" in found), (True, False))
        honest = {"details": [{"typeUrl": ERROR_INFO, "valueDecoded": {"reason": "MEDIATOR_SAYS_TX_TIMED_OUT", "metadata": {"unresponsiveParties": "a::1", "category": "2"}}}]}
        for other in (honest, {}, None, "x", {"details": ["x"]}):
            self.assertFalse(b.reported_in_status(other))
        body = lambda context: json.dumps({"code": "MEDIATOR_SAYS_TX_TIMED_OUT", "context": context})
        self.assertTrue(b.reported_in_body(body({"unresponsiveParties": "a::1", **keys})))
        self.assertIsNone(b.unresponsive_of_body(body({"unresponsiveParties": "a::1", **keys})))
        for text in (body({"unresponsiveParties": "a::1"}), body("x"), "not json", None, "[]"):
            self.assertFalse(b.reported_in_body(text))

    def test_which_timeout_the_words_carry(self):
        self.assertEqual(b.timeout_code("MEDIATOR_SAYS_TX_TIMED_OUT(2,0): x"), "MEDIATOR_SAYS_TX_TIMED_OUT")
        self.assertEqual(b.timeout_code("LOCAL_VERDICT_TIMEOUT(5,x): late"), "LOCAL_VERDICT_TIMEOUT")
        self.assertEqual(b.timeout_code("LOCAL_VERDICT_TIMEOUT and MEDIATOR_SAYS_TX_TIMED_OUT"), "MEDIATOR_SAYS_TX_TIMED_OUT")
        for text in (None, "", "CONTRACT_NOT_FOUND", "504 Gateway Time-out"):
            self.assertIsNone(b.timeout_code(text))


class Blame(unittest.TestCase):
    """The bookkeeping of the blame, on a clock of its own."""

    def setUp(self):
        self.now = [1_000.0]
        self.blame = b.PartyBlame(600, clock=lambda: self.now[0])

    def test_timeouts_that_hold_nobody_count_up_to_the_limit_and_a_conviction_or_an_answer_ends_the_row(self):
        self.assertEqual([self.blame.no_blame(3) for _ in range(4)], [True, True, True, False])
        self.assertEqual(self.blame.silent, 3)
        self.blame.timed_out({"a"})   # a party is held back
        self.assertEqual(self.blame.silent, 0)
        self.assertTrue(self.blame.no_blame(1))
        self.assertFalse(self.blame.no_blame(1))
        self.blame.answered({"b"})   # a block answered by Canton
        self.assertTrue(self.blame.no_blame(1))
        self.assertFalse(self.blame.no_blame(0))

    def test_one_party_is_convicted_and_held_for_the_cool_down_and_then_for_twice_as_long_each_time(self):
        holds = []
        for _ in range(4):
            self.assertEqual(self.blame.timed_out({"a"}), ["a"])
            holds.append(self.blame.until["a"] - self.now[0])
            self.now[0] += holds[-1] + 1
        self.assertEqual(holds, [600, 1200, 2400, 4800])

    def test_the_hold_never_passes_a_day(self):
        holds = []
        for _ in range(12):
            self.blame.timed_out({"a"})
            holds.append(self.blame.until["a"] - self.now[0])
            self.now[0] = self.blame.until["a"] + 1
        self.assertEqual((holds[:3], max(holds), holds[-1]), ([600, 1200, 2400], 86400, 86400))

    def test_a_hold_ends_by_itself(self):
        self.blame.timed_out({"a"})
        self.assertIsNotNone(self.blame.hold_reason("a"))
        self.now[0] += 601
        self.assertIsNone(self.blame.hold_reason("a"))
        self.assertEqual(self.blame.held(), {})

    def test_several_parties_are_narrowed_by_halves_to_the_one_to_blame(self):
        parties = {f"p{i}" for i in range(8)}
        culprit, tries, timeouts = "p5", 0, 0
        while True:
            tries += 1
            carried = {p for p in parties if self.blame.hold_reason(p) is None}   # what a block can carry now: the parties that are neither held nor waiting
            if culprit in carried:   # the block times out only when it carries the party that does not answer
                timeouts += 1
                convicted = self.blame.timed_out(carried)
                if convicted:
                    break
            else:
                self.blame.answered(carried)
        self.assertEqual((convicted, timeouts, tries), ([culprit], 3, 5))   # 8 -> 4 (cleared) -> 2 -> 1 (cleared) -> convicted: logarithmic in the parties
        self.assertEqual(set(self.blame.until), {culprit})
        self.assertEqual((self.blame.suspects, self.blame.live), (set(), set()))   # the others are free at once

    def test_a_party_that_was_waiting_is_the_next_suspect_when_the_half_on_trial_is_cleared(self):
        self.blame.timed_out({"a", "b", "c", "d"})
        self.assertEqual((self.blame.live, self.blame.suspects), ({"a", "b"}, {"a", "b", "c", "d"}))
        self.blame.answered({"a", "b"})   # a block that carried a and b was answered: they are fine
        self.assertEqual((self.blame.live, self.blame.suspects), ({"c"}, {"c", "d"}))
        self.blame.answered({"c"})
        self.assertEqual((self.blame.live, self.blame.suspects), ({"d"}, {"d"}))
        self.assertEqual(self.blame.timed_out({"d"}), ["d"])

    def test_a_block_that_carries_none_of_the_parties_on_trial_changes_nothing(self):
        self.blame.timed_out({"a", "b"})
        before = (set(self.blame.live), set(self.blame.suspects))
        self.blame.answered({"z"})
        self.assertEqual((self.blame.live, self.blame.suspects), before)

    def test_a_timeout_of_a_block_with_none_of_the_parties_on_trial_starts_over_with_the_parties_it_carried(self):
        self.blame.timed_out({"a", "b"})
        self.assertEqual(self.blame.timed_out({"z"}), ["z"])
        self.assertEqual((self.blame.live, self.blame.suspects), (set(), set()))

    def test_a_trial_that_finds_nothing_ends_by_itself(self):
        self.blame.timed_out({"a", "b"})
        self.assertIsNotNone(self.blame.hold_reason("b"))
        self.now[0] += 601
        self.assertIsNone(self.blame.hold_reason("b"))
        self.assertEqual(self.blame.held(), {})

    def test_a_party_not_on_the_operators_participants_is_convicted_without_a_trial(self):
        class Asked:
            def check(self, party, fresh=False):
                assert fresh
                return ("foreign" if party == "b" else "hosted"), None
        self.assertEqual(self.blame.timed_out({"a", "b", "c"}, Asked()), ["b"])
        self.assertEqual((set(self.blame.until), self.blame.live, self.blame.suspects), ({"b"}, set(), set()))

    def test_a_lookup_that_cannot_be_made_convicts_nobody(self):
        class Unknown:
            def check(self, party, fresh=False):
                return "unknown", "cannot be read"
        self.assertEqual(self.blame.timed_out({"a", "b"}, Unknown()), [])
        self.assertEqual(self.blame.live, {"a"})

    def test_a_party_the_mediator_names_is_held_and_no_other_of_the_block(self):
        self.assertEqual(self.blame.named({"a", "b", "c"}, ["b"]), ["b"])
        self.assertEqual((set(self.blame.until), self.blame.suspects, self.blame.live), ({"b"}, set(), set()))
        self.assertEqual(self.blame.strikes, {"b": 1})

    def test_a_timeout_that_names_a_party_with_no_leg_in_the_block_holds_none_of_the_users_it_names(self):
        """z is the chain's own party or an admin's: the mediator names every confirmer still missing, so b may be hosted on the silent participant of z."""
        self.assertEqual(self.blame.named({"a", "b", "c"}, ["b", "z"]), [])
        self.assertEqual((self.blame.until, self.blame.strikes, self.blame.suspects, self.blame.live), ({}, {}, set(), set()))
        self.assertEqual(self.blame.named({"a", "b"}, ["z", "a", "b"]), [])

    def test_a_named_party_is_held_for_the_cool_down_and_for_twice_as_long_each_time(self):
        holds = []
        for _ in range(3):
            self.assertEqual(self.blame.named({"a"}, ["a"]), ["a"])
            holds.append(self.blame.until["a"] - self.now[0])
            self.now[0] += holds[-1] + 1
        self.assertEqual(holds, [600, 1200, 2400])

    def test_naming_nobody_in_the_block_holds_nobody_and_leaves_a_trial_alone(self):
        self.blame.timed_out({"a", "b"})   # a trial of a and b: a is live
        self.assertEqual(self.blame.named({"a", "b"}, ["z"]), [])
        self.assertEqual((self.blame.until, self.blame.suspects, self.blame.live), ({}, {"a", "b"}, {"a"}))

    def test_naming_a_party_ends_a_trial_and_a_party_already_held_is_not_held_again(self):
        self.blame.timed_out({"a", "b"})
        self.assertEqual(self.blame.named({"a", "b"}, ["b"]), ["b"])
        self.assertEqual((self.blame.suspects, self.blame.live), (set(), set()))
        self.assertEqual(self.blame.named({"b"}, ["b"]), [])   # held already: its leg is not in a block, and a strike is not added for it
        self.assertEqual(self.blame.strikes, {"b": 1})

    def test_an_empty_block_blames_nobody(self):
        self.assertEqual(self.blame.timed_out(set()), [])
        self.assertEqual(self.blame.held(), {})


class HostingRights(tb.Case):
    """The lookup needs a right the builder's own user may not hold: it says which, and stops the start when it is missing."""
    BEARER = "hosting-lookup-token"
    run_main = tb.CommandLine.run_main

    def hosted(self, s, **k):
        s.cfg.hosted_on = (ROME,)
        s.cfg.hosting = b.Hosting(s.cfg, s.cfg.hosted_on)
        for name, value in k.items():
            setattr(s.cfg, name, value)
        return s.cfg.hosting

    def test_a_lookup_refused_for_want_of_the_right_leaves_the_leg_out_and_says_which_right(self):
        s = self.setup({ALICE: []})
        s.ledger.hosting, s.ledger.hosting_bearer = everyone_on_rome("d::1"), self.BEARER
        state, reason = self.hosted(s).check("d::1")
        self.assertEqual(state, "unknown")
        self.assertIn("HTTP 403", reason)
        self.assertIn("CanReadAsAnyParty", reason)
        self.assertIn("--hosting-token-file", reason)

    def test_the_probe_stops_the_start_with_the_right_that_is_missing(self):
        for code in (401, 403):
            with self.subTest(code):
                s = self.setup({ALICE: []})
                s.ledger.hosting_failure = code
                with self.assertRaises(b.BuilderError) as e:
                    self.hosted(s).probe()
                self.assertIn("--hosted-on", str(e.exception))
                self.assertIn("CanReadAsAnyParty", str(e.exception))
                self.assertIn("participant admin", str(e.exception))

    def test_the_probe_passes_when_the_token_may_ask_and_asks_about_no_party_of_the_chain(self):
        s = self.setup({ALICE: []})
        self.hosted(s).probe()
        (party, participant), = s.ledger.hosting_asked
        self.assertEqual((party, participant), (b.HOSTING_PROBE_PARTY, ROME))
        self.assertTrue(party.startswith("hosting-probe::1220"))

    def test_the_probe_leaves_other_answers_to_the_lookups(self):
        for code in (400, 404, 500, 503):
            with self.subTest(code):
                s = self.setup({ALICE: []})
                s.ledger.hosting_failure = code
                self.hosted(s).probe()
        s = self.setup({ALICE: []})
        s.cfg.ledger_url = "http://127.0.0.1:9"   # nothing listens
        self.hosted(s).probe()

    def test_the_hosting_token_file_is_used_for_the_lookups_and_read_each_time(self):
        s = self.setup({ALICE: []})
        s.ledger.hosting, s.ledger.hosting_bearer = everyone_on_rome("d::1", "e::1"), self.BEARER
        auth = Path(s.dir) / "hosting.token"
        auth.write_text("wrong\n")
        hosting = self.hosted(s, hosting_auth_file=str(auth))
        self.assertEqual(hosting.check("d::1")[0], "unknown")
        auth.write_text(self.BEARER + "\n")
        hosting.probe()
        self.assertEqual(hosting.check("e::1"), ("hosted", None))

    def test_a_hosting_token_file_that_is_missing_or_empty_stops_the_start(self):
        s = self.setup({ALICE: []})
        missing = Path(s.dir) / "no-such.token"
        with self.assertRaises(b.BuilderError) as e:
            self.hosted(s, hosting_auth_file=str(missing)).probe()
        self.assertIn("--hosting-token-file cannot be read", str(e.exception))
        self.assertEqual(s.ledger.hosting_asked, [])
        empty = Path(s.dir) / "empty.token"
        empty.write_text("\n")
        with self.assertRaises(b.BuilderError) as e:
            self.hosted(s, hosting_auth_file=str(empty)).probe()
        self.assertIn("--hosting-token-file is empty", str(e.exception))
        code, out = self.run_main(s, "--hosted-on", ROME, "--hosting-token-file", str(missing))
        self.assertEqual(code, 1)
        self.assertIn("--hosting-token-file cannot be read", out["error"])

    def test_the_command_line_stops_with_the_reason_and_takes_the_token_file(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.ledger.hosting, s.ledger.hosting_bearer = everyone_on_rome("d::1"), self.BEARER
        code, out = self.run_main(s, "--hosted-on", ROME)
        self.assertEqual(code, 1)
        self.assertIn("CanReadAsAnyParty", out["error"])
        auth = Path(s.dir) / "hosting.token"
        auth.write_text(self.BEARER)
        code, out = self.run_main(s, "--hosted-on", ROME, "--hosting-token-file", str(auth))
        self.assertEqual((code, out["committed"]), (0, True))
        code, out = self.run_main(s, "--hosting-token-file", str(auth))
        self.assertEqual(code, 1)
        self.assertIn("--hosting-token-file is for --hosted-on", out["error"])


class Options(unittest.TestCase):
    def test_a_participant_id_is_one_word_with_the_double_colons_of_an_id(self):
        self.assertEqual(b.parse_participants([ROME, ROME, ELSEWHERE]), (ROME, ELSEWHERE))
        for bad in ("", "participant", "PAR::a b::1", "PAR::" + "x" * 400, "PAR::a\n::1"):
            with self.subTest(bad):
                with self.assertRaises(b.BuilderError):
                    b.parse_participants([bad])


if __name__ == "__main__":
    unittest.main()
