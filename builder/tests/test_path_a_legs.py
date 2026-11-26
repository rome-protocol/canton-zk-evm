"""The legs of a transfer the gateway accepted (package 0.6.0): a deposit settled by a Receipt, a withdrawal that is a Payout behind --payout-offers, the
custody check leaving both out, and the status file's open receipts and payouts. Against the same fakes as test_builder.py."""
import json, sys, threading, unittest
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
import test_leg_check as lc
from fakes import DEPOSIT, WITHDRAWAL, Leg

PAYEE, WTKB, UNIT, named = tb.PAYEE, tb.WTKB, tb.UNIT, tb.named
SENDER, LABEL = "s::1", "lbl-1"
RID = b.deposit_id_of(SENDER, LABEL)
RECEIPT = ("rcpt-1", {**named, "gateway": "gw", "gatewayToken": "tok-1", "sender": SENDER, "depositId": RID, "label": LABEL, "recipient": PAYEE, "amount": "10.0"})
RECEIVE = Leg(DEPOSIT, RID, WTKB, PAYEE, 10 * UNIT)
PARTY = "r::1220" + "ab" * 32   # a Canton party as Daml writes one
PAY_OUT = Leg(WITHDRAWAL, tb.WD_ID, WTKB, PAYEE, 4 * UNIT, PARTY)
PAY_VALUE = {"id": tb.WD_ID, "gatewayToken": "tok-1", "from": PAYEE, "amount": "4.0", "party": PARTY}


class Receipts(tb.LegCase):
    def setup_receipt(self, leg=RECEIVE, receipts=(RECEIPT,), requests=(), registered=(tb.TOKEN,), on=True, **k):
        s = self.setup({tb.ALICE: []}, **k)
        s.cfg.receipts = on
        s.ledger.receipts, s.ledger.requests = list(receipts), list(requests)
        s.ledger.tokens.extend(registered)
        t = self.leg_tx(s, leg)
        s.reth.pool[tb.ALICE] = [t]
        return s, t

    def test_a_deposit_with_a_receipt_is_a_receipt_leg_and_asks_for_no_allocation(self):
        s, t = self.setup_receipt()
        result = self.build(s)
        self.assertEqual(self.attached(s, "ReceiptLeg"), {"receipt": "rcpt-1"})
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))
        self.assertNotIn("deadline", str(s.advance_argument().get("legs")))
        self.assertTrue(all("Allocation" not in q for q in map(str, s.ledger.queries)))

    def test_with_the_switch_off_a_receipt_is_never_read_and_the_deposit_is_left_out(self):
        s, t = self.setup_receipt(on=False)
        self.assert_left_out(s, t, "no deposit request or receipt")
        self.assertFalse(any("Receipt" in str(q) for q in s.ledger.queries))

    def test_the_receipt_is_used_before_a_request_of_the_same_id(self):
        s, t = self.setup_receipt(requests=[("req-9", {**tb.REQUEST[1], "depositId": RID, "label": LABEL, "depositor": SENDER})])
        self.build(s)
        self.assertEqual(self.attached(s, "ReceiptLeg"), {"receipt": "rcpt-1"})

    def test_a_receipt_of_another_token_or_amount_or_recipient_leaves_the_deposit_out(self):
        for what, over, words in (("token", {"gatewayToken": "tok-2"}, "another token"), ("amount", {"amount": "9.0"}, "amount is not the amount claimed"),
                                  ("recipient", {"recipient": tb.OTHER}, "no deposit request or receipt")):
            with self.subTest(what):
                s, t = self.setup_receipt(receipts=[("rcpt-1", {**RECEIPT[1], **over})], registered=[tb.TOKEN, tb.TOKEN_C])
                self.assert_left_out(s, t, words)

    def test_a_receipt_of_another_chain_or_gateway_is_not_used(self):
        for over in ({"chainId": "1"}, {"gateway": "other"}, {"operator": "x"}):
            with self.subTest(over):
                s, t = self.setup_receipt(receipts=[("rcpt-1", {**RECEIPT[1], **over})])
                self.assert_left_out(s, t, "no deposit request or receipt")

    def test_a_receipt_that_does_not_fit_leaves_the_requests_way_open(self):
        s, t = self.setup_receipt(receipts=[("rcpt-1", {**RECEIPT[1], "amount": "9.0"})], requests=[tb.REQUEST], leg=tb.DEP)
        s.ledger.receipts = [("rcpt-1", {**RECEIPT[1], "depositId": tb.DEP_ID, "amount": "9.0"})]
        self.build(s)
        self.assertEqual(self.attached(s, "DepositLeg")["request"], "req-1")

    def test_without_the_0_6_0_templates_the_request_way_is_as_it_was(self):
        s, t = self.setup_receipt(leg=tb.DEP, receipts=[], requests=[tb.REQUEST])
        s.ledger.no_040 = True
        self.build(s)
        self.assertEqual(self.attached(s, "DepositLeg")["request"], "req-1")

    def test_one_receipt_settles_one_leg_of_a_block(self):
        s, t = self.setup_receipt()
        canton = b.Canton(b.Ledger(s.cfg), s.ledger.chain_args(), b.utcnow())
        legs, missing = b.match_legs(canton, [self.event(RECEIVE, "aa"), self.event(RECEIVE, "bb")])
        self.assertEqual([x["tag"] for x in legs], ["ReceiptLeg"])
        self.assertEqual(len(missing), 1)
        self.assertIn("same receipt", str(missing[0][1]))

    def event(self, leg, tx):
        return b.LegEvent(leg.kind, leg.id, leg.token, leg.account, leg.amount, leg.party, tx)

    def test_the_leg_check_refuses_with_the_receipt_words_and_accepts_a_good_one(self):
        s = self.setup({})
        s.cfg.receipts = True
        s.reth.trace_legs[lc.TO] = [RECEIVE]
        s.ledger.tokens.extend([tb.TOKEN])
        result = b.leg_check(s.cfg, lc.CALL)
        self.assertIs(result["ok"], False)
        self.assertIn("no deposit request or receipt of this chain for this id and recipient", result["reason"])
        s.ledger.receipts = [RECEIPT]
        self.assertEqual(b.leg_check(s.cfg, lc.CALL), {"ok": True})
        s.ledger.receipts = [("rcpt-1", {**RECEIPT[1], "amount": "9.0"})]
        self.assertIn("the receipt's amount is not the amount claimed", b.leg_check(s.cfg, lc.CALL)["reason"])


class Payouts(tb.LegCase):
    def setup_payout(self, *legs, on=True, registered=(tb.TOKEN,), **k):
        s = self.setup({tb.ALICE: []}, **k)
        s.cfg.payout_offers = on
        s.ledger.tokens.extend(registered)
        s.reth.pool[tb.ALICE] = [self.leg_tx(s, list(legs), nonce=0)]
        return s, s.reth.pool[tb.ALICE][0]

    def test_a_withdrawal_is_a_payout_leg_with_no_acceptance_and_no_holdings(self):
        s, t = self.setup_payout(PAY_OUT)
        self.assertEqual((s.ledger.acceptances, s.ledger.holdings), ([], []))
        result = self.build(s)
        self.assertEqual(self.attached(s, "PayoutLeg"), PAY_VALUE)
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))
        self.assertNotIn("disclosedContracts", s.ledger.submitted[0])

    def test_two_payouts_of_one_token_go_in_one_block(self):
        second = Leg(WITHDRAWAL, "cd" * 32, WTKB, PAYEE, 1 * UNIT, PARTY)
        s, t = self.setup_payout(PAY_OUT, second)
        self.build(s)
        self.assertEqual([l["tag"] for l in s.advance_argument()["legs"]], ["PayoutLeg", "PayoutLeg"])

    def test_with_the_switch_off_a_withdrawal_needs_an_acceptance_as_before(self):
        s, t = self.setup_payout(tb.WD, on=False)
        self.assert_left_out(s, t, "no standing acceptance of withdrawals")

    def test_a_text_that_is_not_a_canton_party_is_left_out(self):
        s, t = self.setup_payout(Leg(WITHDRAWAL, tb.WD_ID, WTKB, PAYEE, 4 * UNIT, "not a party"))
        self.assert_left_out(s, t, "not a Canton party")

    def test_the_receiver_is_not_a_stakeholder_so_no_hosting_or_blame_check_applies(self):
        s, t = self.setup_payout(PAY_OUT)
        s.cfg.hosted_on = ("PAR::rome::1220" + "aa" * 32,)
        s.cfg.hosting = b.Hosting(s.cfg, s.cfg.hosted_on)
        result = self.build(s)
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))

    def test_an_unregistered_token_is_left_out(self):
        s, t = self.setup_payout(PAY_OUT, registered=[])
        self.assert_left_out(s, t, "not registered")

    def test_no_registry_is_asked_for_a_payout_of_a_token_that_has_one(self):
        s, t = self.setup_payout(PAY_OUT)
        s.cfg.registries, s.cfg.registry_tokens = {"adm": "http://127.0.0.1:1"}, {}   # nothing listens there: a leg that asked it would be left out
        result = self.build(s)
        self.assertEqual(result["legs"], 1)

    def test_a_payout_of_an_expiring_instrument_waits_for_no_stop_and_no_check_and_writes_none(self):
        s, t = self.setup_payout(PAY_OUT)
        self.expiring(s, 10)
        Path(s.cfg.work_dir).mkdir(parents=True, exist_ok=True)
        b.custody_stop_path(s.cfg).write_text("{}")
        b.custody_check_path(s.cfg).write_text("{}")
        result = self.build(s)
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))
        self.assertEqual(self.attached(s, "PayoutLeg"), PAY_VALUE)
        self.assertEqual(s.advance_argument().get("custody"), None)
        self.assertEqual(b.custody_check_path(s.cfg).read_text(), "{}")   # no check was written or removed for it

    def expiring(self, s, custody, open_payouts=()):
        """The token's instrument runs out, a scan proxy gives the round (floor 1.118016), the gateway holds `custody` coins, and `open_payouts` are open (in coins)."""
        import test_custody_expiry as ce
        s.scan = ce.Scan()
        self.addCleanup(s.scan.close)
        s.cfg.registries, s.cfg.registry_tokens, s.cfg.expiring = {"adm": s.scan.url}, {}, ("adm",)
        s.ledger.holdings = [ce.hold("h-1", custody * UNIT)]
        s.ledger.payouts = [(f"pay-{i}", {**named, "gateway": "gw", "gatewayToken": "tok-1", "payoutId": f"{i:064x}", "party": PARTY, "amount": f"{a}.0"}) for i, a in enumerate(open_payouts)]

    def test_a_payout_of_an_expiring_instrument_that_leaves_less_than_the_floor_is_left_out_with_the_floor_reason(self):
        s, t = self.setup_payout(PAY_OUT)   # 4 coins
        self.expiring(s, 5)                 # 1 would be left, under 1.118016
        self.assert_left_out(s, t, "This withdrawal would leave 1.0 CC of Canton Coin in the bridge, under its minimum of 1.118016 CC")

    def test_a_payout_that_leaves_zero_or_at_least_the_floor_is_a_leg(self):
        for custody in (4, 6):
            with self.subTest(custody=custody):
                s, t = self.setup_payout(PAY_OUT)
                self.expiring(s, custody)
                self.assertEqual(self.build(s)["legs"], 1)

    def test_open_payouts_count_against_custody_and_a_short_custody_is_refused(self):
        s, t = self.setup_payout(PAY_OUT)
        self.expiring(s, 10, open_payouts=[4])   # 10 - 4 open - 4 = 2: fine
        self.assertEqual(self.build(s)["legs"], 1)
        s, t = self.setup_payout(PAY_OUT)
        self.expiring(s, 10, open_payouts=[5])   # 10 - 5 open - 4 = 1: under the floor
        self.assert_left_out(s, t, "would leave 1.0 CC")
        s, t = self.setup_payout(PAY_OUT)
        self.expiring(s, 6, open_payouts=[3])    # 6 - 3 - 4 < 0
        self.assert_left_out(s, t, "does not cover the amount")

    def test_two_payouts_of_a_block_count_together_against_the_floor(self):
        s = self.setup({tb.ALICE: [], tb.BOB: []})
        s.cfg.payout_offers = True
        s.ledger.tokens.extend([tb.TOKEN])
        self.expiring(s, 9)   # the first leaves 5, the second would leave 1
        first = self.leg_tx(s, PAY_OUT, tb.ALICE, price=9)
        second = self.leg_tx(s, Leg(WITHDRAWAL, "cd" * 32, WTKB, PAYEE, 4 * UNIT, PARTY), tb.BOB, price=5)
        s.reth.pool[tb.ALICE], s.reth.pool[tb.BOB] = [first], [second]
        result = self.build(s)
        self.assertEqual([l["tag"] for l in s.advance_argument()["legs"]], ["PayoutLeg"])
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [second["hash"]])
        self.assertIn("would leave 1.0 CC", result["leftOut"][0]["reason"])

    def test_two_payouts_that_fit_the_quota_one_by_one_but_not_together_leave_the_second_out(self):
        s = self.setup({tb.ALICE: [], tb.BOB: []})
        s.cfg.payout_offers = True
        s.ledger.tokens.extend([tb.TOKEN])
        s.ledger.chain_extra = {"withdrawalQuota": "5.0", "quotaWindow": {"microseconds": "86400000000"}, "withdrawn": None}
        first = self.leg_tx(s, Leg(WITHDRAWAL, tb.WD_ID, WTKB, PAYEE, 3 * UNIT, PARTY), tb.ALICE, price=9)
        second = self.leg_tx(s, Leg(WITHDRAWAL, "cd" * 32, WTKB, PAYEE, 3 * UNIT, PARTY), tb.BOB, price=5)
        s.reth.pool[tb.ALICE], s.reth.pool[tb.BOB] = [first], [second]
        result = self.build(s)
        self.assertEqual([l["tag"] for l in s.advance_argument()["legs"]], ["PayoutLeg"])
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [second["hash"]])
        self.assertIn("withdrawal quota", result["leftOut"][0]["reason"])

    def test_the_leg_check_accepts_a_payout_to_any_party(self):
        s = self.setup({})
        s.cfg.payout_offers = True
        s.reth.trace_legs[lc.TO] = [PAY_OUT]
        s.ledger.tokens.extend([tb.TOKEN])
        self.assertEqual(b.leg_check(s.cfg, lc.CALL), {"ok": True})

    # ---- the party must be known to Canton (O-01) and the payout at least the custody's least (O-02)

    def publish_limits(self, s, least="5", admin="adm", name="TKB", **over):
        """The custody worker's custody-limits.json in the builder's work folder."""
        Path(s.cfg.work_dir).mkdir(parents=True, exist_ok=True)
        doc = {"version": 1, "updatedAt": "2026-11-26T10:00:00Z", "pollSeconds": 10, "minDeposits": None,
               "minPayouts": [{"instrumentAdmin": admin, "instrumentId": name, "least": least}], **over}
        (Path(s.cfg.work_dir) / "custody-limits.json").write_text(json.dumps(doc))

    def test_a_party_that_canton_does_not_know_is_left_out_with_nothing_proven(self):
        s, t = self.setup_payout(PAY_OUT)
        s.ledger.unknown_parties.add(PARTY)
        self.assert_left_out(s, t, "not known on the network")
        self.assertEqual(s.ledger.party_reads[0], {"packageVettingRequirements": [{"parties": [PARTY], "packageName": "splice-amulet"}]})
        self.assertEqual(s.log.read_text().count("prove"), 1)   # only the second, leg-free block was proven

    def test_a_party_that_canton_knows_is_asked_once_for_all_its_payouts_of_a_block(self):
        s, t = self.setup_payout()
        canton = b.Canton(b.Ledger(s.cfg), s.ledger.chain_args(), b.utcnow())
        events = [b.LegEvent(WITHDRAWAL, id, WTKB, PAYEE, 1 * UNIT, PARTY, tx) for id, tx in (("ab" * 32, "aa"), ("cd" * 32, "bb"))]
        legs, missing = b.match_legs(canton, events)
        self.assertEqual(([x["tag"] for x in legs], missing), (["PayoutLeg", "PayoutLeg"], []))
        self.assertEqual(len(s.ledger.party_reads), 1)

    def test_a_read_that_fails_leaves_the_leg_out_as_unread_and_never_as_known(self):
        s, t = self.setup_payout(PAY_OUT)
        s.ledger.party_failure = 503
        self.assert_left_out(s, t, "cannot be looked up now")

    def test_the_leg_check_refuses_an_unknown_party_before_any_burn_and_says_nothing_of_a_failed_read(self):
        s = self.setup({})
        s.cfg.payout_offers = True
        s.reth.trace_legs[lc.TO] = [PAY_OUT]
        s.ledger.tokens.extend([tb.TOKEN])
        s.ledger.unknown_parties.add(PARTY)
        result = b.leg_check(s.cfg, lc.CALL)
        self.assertIs(result["ok"], False)
        self.assertIn("not known on the network", result["reason"])
        s.ledger.unknown_parties.clear()
        s.ledger.party_failure = 500
        result = b.leg_check(s.cfg, lc.CALL)
        self.assertIs(result["ok"], True)
        self.assertIn("cannot be looked up now", result["unknown"])

    def test_a_payout_below_the_custodys_least_is_left_out_and_canton_is_not_asked(self):
        s, t = self.setup_payout(PAY_OUT)   # 4 units
        self.publish_limits(s, least="5")
        self.assert_left_out(s, t, "below the least payout", "5")
        self.assertEqual(s.ledger.party_reads, [])

    def test_a_payout_at_the_least_goes_and_so_does_one_of_a_token_with_no_least(self):
        s, t = self.setup_payout(PAY_OUT)
        self.publish_limits(s, least="4")
        self.assertEqual(self.build(s)["legs"], 1)
        s, t = self.setup_payout(PAY_OUT)
        self.publish_limits(s, least="50", name="OTHER")
        self.assertEqual(self.build(s)["legs"], 1)

    def test_no_limits_file_or_payouts_off_in_it_means_no_least(self):
        s, t = self.setup_payout(PAY_OUT)
        self.assertEqual(self.build(s)["legs"], 1)
        s, t = self.setup_payout(PAY_OUT)
        self.publish_limits(s, minPayouts=None)
        self.assertEqual(self.build(s)["legs"], 1)

    def test_a_limits_file_that_cannot_be_read_leaves_the_payout_out_as_unread(self):
        s, t = self.setup_payout(PAY_OUT)
        Path(s.cfg.work_dir).mkdir(parents=True, exist_ok=True)
        (Path(s.cfg.work_dir) / "custody-limits.json").write_text("{not json")
        self.assert_left_out(s, t, "custody's limits cannot be read")

    def test_the_leg_check_refuses_a_payout_below_the_least(self):
        s = self.setup({})
        s.cfg.payout_offers = True
        s.reth.trace_legs[lc.TO] = [PAY_OUT]
        s.ledger.tokens.extend([tb.TOKEN])
        self.publish_limits(s, least="5")
        result = b.leg_check(s.cfg, lc.CALL)
        self.assertIs(result["ok"], False)
        self.assertIn("below the least payout", result["reason"])


class CustodyPlan(unittest.TestCase):
    def test_receipt_and_payout_legs_move_no_holding_and_are_left_out_of_the_plan(self):
        instrument = {"admin": "adm", "id": "TKB"}
        class Canton:
            expiry = SimpleNamespace(covers=lambda admin: admin == "adm")

            def token(self, event):
                return {"instrumentId": instrument}
        canton = Canton()
        events = [SimpleNamespace(amount=5)] * 4
        legs = [{"tag": "ReceiptLeg", "value": {}}, {"tag": "PayoutLeg", "value": {}}, {"tag": "DepositLeg", "value": {}}, {"tag": "WithdrawalLeg", "value": {}}]
        self.assertEqual(b.custody_plan(canton, events, legs), [{"instrument": instrument, "withdrawn": 5, "deposits": 5}])
        self.assertEqual(b.custody_plan(canton, events[:2], legs[:2]), [])


class OpenRows(tb.Case):
    def rows(self, s):
        return b.open_rows(b.Ledger(s.cfg), s.ledger.chain_args(), 1_700_000_000.0)

    def test_each_registered_token_counts_its_open_receipts_and_payouts(self):
        s = self.setup({})
        s.ledger.tokens.extend([tb.TOKEN, tb.TOKEN_C])
        s.ledger.receipts = [RECEIPT, ("rcpt-2", {**RECEIPT[1], "amount": "2.5"}), ("rcpt-3", {**RECEIPT[1], "gatewayToken": "tok-2", "amount": "1.0"})]
        s.ledger.payouts = [("pay-1", {**named, "gateway": "gw", "gatewayToken": "tok-1", "payoutId": "a" * 64, "party": SENDER, "amount": "0.5"})]
        row = self.rows(s)
        self.assertEqual(row["readAt"], "2023-11-14T22:13:20Z")
        self.assertEqual(row["tokens"], {
            "adm/TKB": {"receipts": 2, "receiptAmount": "12.5", "payouts": 1, "payoutAmount": "0.5"},
            "adm/TKC": {"receipts": 1, "receiptAmount": "1.0", "payouts": 0, "payoutAmount": "0.0"}})

    def test_a_token_with_nothing_open_shows_zero_and_a_participant_without_0_6_0_shows_zero_for_all(self):
        s = self.setup({})
        s.ledger.tokens.extend([tb.TOKEN])
        s.ledger.no_040 = True
        self.assertEqual(self.rows(s)["tokens"], {"adm/TKB": {"receipts": 0, "receiptAmount": "0.0", "payouts": 0, "payoutAmount": "0.0"}})

    def test_the_producer_status_carries_the_rows_and_reads_them_again_after_a_block_with_legs(self):
        s = self.setup({})
        s.ledger.tokens.extend([tb.TOKEN])
        s.cfg.receipts = True
        now = [1_700_000_000.0]
        p = b.Producer(s.cfg, threading.Event(), status_file=str(Path(s.dir) / "status.json"), clock=lambda: now[0])
        self.assertIsNone(p.status()["open"])
        p.open_step()
        self.assertEqual(p.status()["open"]["tokens"]["adm/TKB"]["receipts"], 0)
        s.ledger.receipts = [RECEIPT]
        p.open_step()   # not due yet
        self.assertEqual(p.status()["open"]["tokens"]["adm/TKB"]["receipts"], 0)
        p.open_dirty = True
        p.open_step()
        self.assertEqual(p.status()["open"]["tokens"]["adm/TKB"]["receipts"], 1)
        now[0] += b.CUSTODY_ROWS_SECONDS
        s.ledger.receipts = []
        p.open_step()
        self.assertEqual(p.status()["open"]["tokens"]["adm/TKB"]["receipts"], 0)

    def test_with_both_switches_off_the_status_has_no_rows_and_nothing_is_read(self):
        s = self.setup({})
        p = b.Producer(s.cfg, threading.Event(), status_file=str(Path(s.dir) / "status.json"))
        p.open_step()
        self.assertNotIn("open", p.status())
        self.assertEqual(s.ledger.queries, [])

    def test_a_read_that_fails_keeps_the_old_rows_and_is_tried_again_in_a_minute(self):
        s = self.setup({})
        s.ledger.tokens.extend([tb.TOKEN])
        s.cfg.payout_offers = True   # either switch reads the rows
        now = [1_700_000_000.0]
        p = b.Producer(s.cfg, threading.Event(), status_file=str(Path(s.dir) / "status.json"), clock=lambda: now[0])
        p.open_step()
        s.ledger.list_failure["Receipt"] = 500
        p.open_dirty = True
        p.open_step()
        self.assertEqual(p.status()["open"]["readAt"], b.iso(1_700_000_000.0))
        s.ledger.list_failure.clear()
        now[0] += 61
        p.open_step()
        self.assertEqual(p.status()["open"]["readAt"], b.iso(1_700_000_061.0))


class Settings(unittest.TestCase):
    def test_the_switch_is_off_by_default_and_the_flag_turns_it_on(self):
        self.assertIs(b.Config.__dataclass_fields__["payout_offers"].default, False)
        self.assertIs(b.Config.__dataclass_fields__["receipts"].default, False)
        off, on = b.parser().parse_args(["run"]), b.parser().parse_args(["run", "--receipts", "--payout-offers"])
        self.assertEqual((off.receipts, off.payout_offers, on.receipts, on.payout_offers), (False, False, True, True))


if __name__ == "__main__":
    unittest.main()
