"""Who must confirm a block. One block is one Canton transaction, so the participant of every party whose contract a leg uses must confirm it, and
one that does not answer must not be able to hold the chain up again and again. Three things are tested here, against the same fakes as
test_builder.py: the check that a leg's parties are hosted on the participants the operator lists (`--hosted-on`), a block that fails on a
confirmation timeout being a refusal that blames the parties of its legs (and never a transaction), and the pure bookkeeping of the blame
(`PartyBlame`). Run: python3 -m unittest discover -s builder/tests"""
import sys, types, unittest
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


class Blame(unittest.TestCase):
    """The bookkeeping of the blame, on a clock of its own."""

    def setUp(self):
        self.now = [1_000.0]
        self.blame = b.PartyBlame(600, clock=lambda: self.now[0])

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
