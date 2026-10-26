"""The legs pause and the withdrawal quota of the chain contract (Daml 0.3.0): the builder reads them when it cuts a block and leaves the legs
that Canton would refuse out of it, so that such a block is never proven. Against the same fakes as test_builder.py."""
import sys, unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
import test_producer as tp
from fakes import WITHDRAWAL, Leg, tx

ALICE, BOB, CAROL, UNIT = tb.ALICE, tb.BOB, tb.CAROL, tb.UNIT
WTKB2 = "44" * 20   # a second wrapped token of the instrument that WTKB wraps
TOKEN_B2 = ("tok-b2", {**tb.TOKEN[1], "evmToken": WTKB2, "factory": "fac-b2"})
PAUSED = "the legs are paused until 2020-01-01T00:00:00Z: a block that carries a leg is refused"


def at(seconds: float) -> str:
    """A ledger time, in Canton's JSON form, this many seconds from now."""
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def quota(amount="5.0", tallies=()):
    return {"withdrawalQuota": amount, "quotaWindow": {"microseconds": "86400000000"}, "withdrawn": [
        {"tallyToken": token, "countedUntil": until, "tallyAmount": spent} for token, until, spent in tallies] or None}


class Limits(tb.LegCase):
    def mixed(self, extra, amount=4 * UNIT, **k):
        """A pool of one withdrawal, one payment-free plain transaction and the chain contract's extra fields."""
        s = self.setup({ALICE: [], BOB: []}, **k)
        s.ledger.tokens, s.ledger.acceptances, s.ledger.holdings = [tb.TOKEN], [tb.ACCEPTANCE], [tb.holding("h-1", "60.0")]
        s.ledger.chain_extra = extra
        wd = self.leg_tx(s, Leg(WITHDRAWAL, tb.WD_ID, tb.WTKB, tb.PAYEE, amount, "r::1"), ALICE, price=9)
        plain = tx(BOB, 0, price=5)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [wd], [plain]
        return s, wd, plain

    def left_out(self, result):
        return {x["transaction"]: x["reason"] for x in result["leftOut"]}

    # -- the pause
    def test_a_pause_in_force_leaves_the_legs_out_and_the_other_transactions_go_in(self):
        until = at(3600)
        s, wd, plain = self.mixed({"pausedUntil": until})
        result = self.build(s)
        self.assertEqual(result["legs"], 0)
        self.assertEqual(s.advance_argument()["legs"], [])
        self.assertEqual(result["transactions"], [plain["hash"]])
        reason = self.left_out(result)[wd["hash"]]
        self.assertTrue(reason.startswith("the Canton legs are paused until 20"), reason)
        self.assertIn(b.stamp(datetime.fromisoformat(until)), reason)
        self.assertEqual(self.in_pool(s), {wd["hash"]})   # the leg's transaction stays in the pool
        self.assertEqual(s.ledger.requests, [])

    def test_every_kind_of_leg_is_left_out_during_a_pause_and_nothing_is_read_from_canton_for_them(self):
        s = self.setup({ALICE: [], BOB: [], CAROL: []}, terms=[tb.TERMS])
        s.ledger.requests, s.ledger.tokens, s.ledger.acceptances, s.ledger.holdings = [tb.REQUEST], [tb.TOKEN], [tb.ACCEPTANCE], [tb.holding("h-1", "6.0")]
        s.ledger.chain_extra = {"pausedUntil": at(3600)}
        ts = [self.leg_tx(s, leg, who) for leg, who in ((tb.PAY, ALICE), (tb.DEP, BOB), (tb.WD, CAROL))]
        for t, who in zip(ts, (ALICE, BOB, CAROL)):
            s.reth.pool[who] = [t]
        s.reth.pool[ALICE].append(tx(ALICE, 1))
        result = self.build(s)
        self.assertEqual(set(self.left_out(result)), {t["hash"] for t in ts})
        self.assertTrue(all("paused until" in r for r in self.left_out(result).values()))
        self.assertEqual(s.advance_argument()["legs"], [])

    def test_a_pause_that_has_ended_lets_the_legs_in(self):
        s, wd, plain = self.mixed({"pausedUntil": at(-3600), "pauseMax": {"microseconds": "1"}})
        result = self.build(s)
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))
        self.assertEqual(result["transactions"], [wd["hash"], plain["hash"]])

    def test_a_pause_is_kept_a_few_seconds_past_its_end(self):
        s, wd, plain = self.mixed({"pausedUntil": at(-1)})   # over by a second on the builder's clock: not over for sure on Canton's
        self.assertEqual(self.left_out(self.build(s))[wd["hash"]][:30], "the Canton legs are paused unt")
        s, wd, plain = self.mixed({"pausedUntil": at(-30)})
        self.assertEqual(self.build(s)["legs"], 1)

    def test_a_pause_that_is_cleared_is_no_pause(self):
        s, wd, plain = self.mixed({"pausedUntil": None, "pauseMax": None})
        self.assertEqual(self.build(s)["legs"], 1)

    def test_a_pause_that_is_not_a_time_stops_the_block_and_proves_nothing(self):
        s, wd, plain = self.mixed({"pausedUntil": "soon"})
        with self.assertRaises(b.BuilderError):
            b.build_block(s.cfg)
        self.assertEqual(s.ledger.submitted, [])

    def test_a_block_with_no_leg_is_cut_during_a_pause_as_ever(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.ledger.chain_extra = {"pausedUntil": at(3600)}
        result = self.build(s)
        self.assertEqual((result["legs"], result["leftOut"], len(s.builds())), (0, [], 1))

    def test_the_legs_wait_in_the_pool_and_go_in_once_the_pause_has_ended(self):
        s, wd, plain = self.mixed({"pausedUntil": at(3600)})
        first = self.build(s)
        self.assertEqual(first["transactions"], [plain["hash"]])
        s.ledger.chain_extra = {"pausedUntil": at(-3600)}
        second = self.build(s)
        self.assertEqual((second["transactions"], second["legs"]), ([wd["hash"]], 1))

    # -- the quota
    def test_withdrawals_beyond_the_quota_are_left_out_and_the_rest_go_in(self):
        s, wd, plain = self.mixed(quota("5.0", [("adm/TKB", at(600), "3.0")]))   # 2.0 is left of 5.0; the withdrawal is 4.0
        result = self.build(s)
        self.assertEqual((result["legs"], result["transactions"]), (0, [plain["hash"]]))
        reason = self.left_out(result)[wd["hash"]]
        self.assertTrue(reason.startswith("the withdrawal quota of adm/TKB is used up until 20"), reason)
        self.assertEqual(self.in_pool(s), {wd["hash"]})

    def test_the_reason_names_the_time_the_withdrawal_would_fit_again(self):
        soon, later = at(60), at(7200)
        s, wd, plain = self.mixed(quota("5.0", [("adm/TKB", later, "2.0"), ("adm/TKB", soon, "2.0")]))   # 1.0 left; 4.0 needs 3.0 freed: both must end
        reason = self.left_out(self.build(s))[wd["hash"]]
        self.assertIn(b.stamp(datetime.fromisoformat(later) + b.LEDGER_MARGIN), reason)
        s, wd, plain = self.mixed(quota("5.0", [("adm/TKB", later, "1.0"), ("adm/TKB", soon, "3.0")]))   # 1.0 left; 3.0 freed by the early one is enough
        reason = self.left_out(self.build(s))[wd["hash"]]
        self.assertIn(b.stamp(datetime.fromisoformat(soon) + b.LEDGER_MARGIN), reason)

    def test_a_withdrawal_that_fits_the_remaining_quota_goes_in(self):
        s, wd, plain = self.mixed(quota("5.0", [("adm/TKB", at(600), "1.0")]))   # exactly the quota: 1.0 + 4.0
        result = self.build(s)
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))

    def test_tallies_that_have_run_out_and_other_instruments_do_not_count(self):
        s, wd, plain = self.mixed(quota("5.0", [("adm/TKB", at(-600), "5.0"), ("adm/TKC", at(600), "5.0")]))
        self.assertEqual(self.build(s)["legs"], 1)

    def test_a_withdrawal_over_the_whole_quota_is_left_out_with_that_reason(self):
        s, wd, plain = self.mixed(quota("5.0"), amount=6 * UNIT)
        self.assertEqual(self.left_out(self.build(s))[wd["hash"]], "the withdrawal is over the whole withdrawal quota of adm/TKB")

    def test_the_quota_is_held_per_instrument(self):
        s = self.setup({ALICE: [], BOB: []})
        s.ledger.tokens, s.ledger.acceptances = [tb.TOKEN, tb.TOKEN_C], [tb.ACCEPTANCE]
        s.ledger.holdings = [tb.holding("h-1", "60.0"), tb.holding("h-2", "60.0", instrument=tb.TKC)]
        s.ledger.chain_extra = quota("5.0", [("adm/TKB", at(600), "5.0")])
        a = self.leg_tx(s, Leg(WITHDRAWAL, tb.WD_ID, tb.WTKB, tb.PAYEE, UNIT, "r::1"), ALICE)
        c = self.leg_tx(s, Leg(WITHDRAWAL, "cd" * 32, tb.WTKC, tb.PAYEE, UNIT, "r::1"), BOB)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [a], [c]
        result = self.build(s)
        self.assertEqual(list(self.left_out(result)), [a["hash"]])
        self.assertEqual(self.attached(s, "WithdrawalLeg")["token"], "tok-2")

    def two_withdrawals(self, extra, big, small, second_token=False):
        """Two withdrawals of one instrument: the large one has the higher tip, so it comes first in the pool's order."""
        s = self.setup({ALICE: [], BOB: []})
        wrapped = tb.WTKB if not second_token else WTKB2
        s.ledger.tokens, s.ledger.acceptances, s.ledger.holdings = [tb.TOKEN, *([TOKEN_B2] if second_token else [])], [tb.ACCEPTANCE], [tb.holding("h-1", "60.0")]
        s.ledger.chain_extra = extra
        a = self.leg_tx(s, Leg(WITHDRAWAL, tb.WD_ID, tb.WTKB, tb.PAYEE, big, "r::1"), ALICE, price=9)
        c = self.leg_tx(s, Leg(WITHDRAWAL, "cd" * 32, wrapped, tb.PAYEE, small, "r::1"), BOB, price=5)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [a], [c]
        return s, a, c

    def test_a_withdrawal_over_the_quota_does_not_take_the_place_of_a_smaller_one_of_the_same_instrument(self):
        s, big, small = self.two_withdrawals(quota("5.0"), 6 * UNIT, UNIT)
        for _ in range(2):   # the pool's order is the same in every block: the big one is left out each time, the small one goes in the first
            result = self.build(s)
            if result["legs"]:
                break
        self.assertEqual(result["legs"], 1)
        self.assertEqual(result["transactions"], [small["hash"]])
        self.assertEqual(self.left_out(result), {big["hash"]: "the withdrawal is over the whole withdrawal quota of adm/TKB"})

    def test_a_withdrawal_over_what_is_left_of_the_quota_does_not_take_the_place_of_a_smaller_one(self):
        s, big, small = self.two_withdrawals(quota("5.0", [("adm/TKB", at(600), "3.0")]), 4 * UNIT, UNIT)   # 2.0 left
        result = self.build(s)
        self.assertEqual((result["legs"], result["transactions"]), (1, [small["hash"]]))
        self.assertTrue(self.left_out(result)[big["hash"]].startswith("the withdrawal quota of adm/TKB is used up until 20"))

    def test_two_wrapped_tokens_of_one_instrument_share_the_quota(self):
        s, big, small = self.two_withdrawals(quota("5.0"), 6 * UNIT, UNIT, second_token=True)
        result = self.build(s)
        self.assertEqual((result["legs"], result["transactions"]), (1, [small["hash"]]))
        self.assertEqual(self.left_out(result), {big["hash"]: "the withdrawal is over the whole withdrawal quota of adm/TKB"})
        self.assertEqual(self.attached(s, "WithdrawalLeg")["token"], "tok-b2")
        # and when both fit on their own, only one goes in a block, for the other's reason as before
        s, first, second = self.two_withdrawals(quota("5.0"), 3 * UNIT, 2 * UNIT, second_token=True)
        result = self.build(s)
        self.assertEqual(result["legs"], 1)
        self.assertIn("another withdrawal of the same token is already in this block", self.left_out(result)[second["hash"]])

    def test_a_chain_with_a_quota_but_no_window_has_no_quota(self):
        s, wd, plain = self.mixed({"withdrawalQuota": "1.0", "quotaWindow": None, "withdrawn": None})
        self.assertEqual(self.build(s)["legs"], 1)

    def test_a_quota_with_no_withdrawals_counted_lets_a_small_withdrawal_in(self):
        s, wd, plain = self.mixed(quota("5.0"))
        self.assertEqual(self.build(s)["legs"], 1)

    def test_deposits_and_payments_are_not_held_to_the_quota(self):
        s = self.setup({ALICE: [], BOB: []}, terms=[tb.TERMS])
        s.ledger.requests, s.ledger.tokens = [tb.REQUEST], [tb.TOKEN]
        s.ledger.chain_extra = quota("0.0000000001", [("adm/TKB", at(600), "0.0000000001")])
        s.reth.pool[ALICE], s.reth.pool[BOB] = [self.leg_tx(s, tb.PAY, ALICE)], [self.leg_tx(s, tb.DEP, BOB)]
        result = self.build(s)
        self.assertEqual((result["legs"], result["leftOut"]), (2, []))

    # -- a 0.2.0 contract
    def test_a_contract_without_the_fields_is_read_as_today(self):
        s, wd, plain = self.mixed({})
        self.assertNotIn("pausedUntil", s.ledger.chain_args())
        result = self.build(s)
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))


class Refused(tp.Loop):
    def pool(self, s, pause_text=None):
        s.ledger.tokens, s.ledger.acceptances, s.ledger.holdings = [tb.TOKEN], [tb.ACCEPTANCE], [tb.holding("h-1", "60.0")]
        wd = tx(ALICE, 0, price=9)
        s.reth.tx_legs[wd["hash"]] = [Leg(WITHDRAWAL, tb.WD_ID, tb.WTKB, tb.PAYEE, 4 * UNIT, "r::1")]
        plain = tx(BOB, 0, price=5)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [wd], [plain]
        return wd, plain

    def change_chain_at_submit(self, s, **extra):
        """The confirmer's Pause (or any other choice on the chain contract) comes between the builder's read and its Advance: the contract the Advance
        names is archived and a new one stands. The change is made once per call, at the next submit."""
        ledger, original = s.ledger, s.ledger.refusal
        def refusal(header, cid):
            ledger.refusal = original
            ledger.consumed.append(cid)
            ledger.cids[ledger.cids.index(cid)] = f"{cid.split('@')[0]}#{len(ledger.consumed)}"
            ledger.chain_extra = {**ledger.chain_extra, **extra}
            return original(header, cid)
        ledger.refusal = refusal

    def test_a_pause_that_starts_after_the_read_archives_the_chain_contract_and_nobody_is_held_back(self):
        s = self.setup({ALICE: [], BOB: []})
        wd, plain = self.pool(s)
        p = self.producer(s, cooldown=600)
        self.change_chain_at_submit(s, pausedUntil=at(3600))
        p.step()
        self.assertEqual([r["committed"] for r in self.reports], [False])
        self.assertIn("CONTRACT_NOT_FOUND", self.reports[0]["reason"])
        # the pause is renewed (a second change of the chain contract) while the next block is proven: its transactions were in the refused block too
        self.change_chain_at_submit(s, pausedUntil=at(7200))
        p.step()
        self.assertEqual([r["committed"] for r in self.reports], [False, False])
        self.assertEqual(self.reports[1]["transactions" if "transactions" in self.reports[1] else "keptTransactions"], [plain["hash"]])
        self.assertEqual(self.status()["excluded"], [])
        self.assertEqual((p.previous_kept, p.suspects, p.probe), (set(), [], None))
        p.step()   # the chain contract is quiet now: the pause is read, the leg is left out, the rest commits
        self.assertEqual(self.reports[-1]["committed"], True)
        self.assertEqual(self.reports[-1]["transactions"], [plain["hash"]])
        self.assertEqual([x["transaction"] for x in self.reports[-1]["leftOut"]], [wd["hash"]])
        self.assertEqual(self.status()["excluded"], [])

    def test_a_refusal_for_another_contract_not_found_still_counts_against_the_transactions(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, refuse="CONTRACT_NOT_FOUND: Contract could not be found: the contract id is unknown: some-holding")
        p = self.producer(s, cooldown=600)
        p.step(); p.step()
        self.assertEqual([x["transaction"] for x in self.status()["excluded"]], [t["hash"]])

    def test_the_pause_text_of_canton_is_no_fault_of_a_block_with_a_leg_until_it_repeats_for_the_same_transactions(self):
        s = self.setup({ALICE: [], BOB: []})
        wd, plain = self.pool(s)
        s.ledger.refuse = PAUSED   # the builder's clock was behind Canton's: the pause was in force already
        p = self.producer(s, cooldown=600)
        p.step()
        self.assertEqual((self.status()["excluded"], p.previous_kept), ([], set()))
        p.step()   # the same transactions in a second block refused for the same words: normal handling, so the pair is tried one by one
        self.assertEqual(sorted(p.suspects), sorted([wd["hash"], plain["hash"]]))

    def test_a_quota_refusal_of_a_block_with_a_leg_is_no_fault_of_the_transactions(self):
        s = self.setup({ALICE: [], BOB: []})
        wd, plain = self.pool(s)
        s.ledger.refuse = "the block's withdrawals of the instrument adm/TKB are over the withdrawal quota: 4.0 more would make 6.0 (the quota is 5.0)"
        p = self.producer(s, cooldown=600)
        p.step()
        self.assertEqual((self.status()["excluded"], p.previous_kept, p.suspects), ([], set(), []))

    def test_the_same_words_in_a_block_with_no_leg_count_as_any_refusal(self):
        for words in (PAUSED, "the block's withdrawals of the instrument adm/TKB are over the withdrawal quota: 4.0 more would make 6.0"):
            t = tx(ALICE, 0)
            s = self.setup({ALICE: [t]}, refuse=words)
            p = self.producer(s, cooldown=600)
            p.step(); p.step()
            self.assertEqual([x["transaction"] for x in self.status()["excluded"]], [t["hash"]], words)

    def test_the_words_inside_another_contracts_message_are_not_the_chain_contracts(self):
        s = self.setup({ALICE: [], BOB: []})
        wd, plain = self.pool(s)
        s.ledger.refuse = "the registry's Allocation_ExecuteTransfer failed: the legs are paused until later, the instrument says"
        p = self.producer(s, cooldown=600)
        p.step()
        self.assertEqual(p.previous_kept, {wd["hash"], plain["hash"]})   # kept as the first of two refusals in a row


if __name__ == "__main__":
    unittest.main()
