"""Tests for demo/otc.py with the fake Ledger API of test_canton.py and a fake demo/evm.py. Run: python3 -m unittest discover -s demo/tests"""
import hashlib, json, sys, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import canton, otc
from test_canton import FakeLedger, LedgerTestCase, CHAIN_RECORD

TOKEN = "ab" * 20
WRAPPED = "cd" * 20
SELLER_EVM, BUYER_EVM = "11" * 20, "22" * 20
INSTRUMENT = {"admin": "rg::1", "id": "TKB"}
ONE = 10**18


def trade_event(label="t1", cid="trade-1"):
    return {"contractId": cid, "offset": 1, "templateId": otc.TRADE, "createArgument": {
        "seller": "u::1", "venue": "v::1", "gateway": "gw::1", "instrument": INSTRUMENT, "amount": "2.5000000000", "token": TOKEN, "amountBase": f"{3 * ONE:064x}",
        "payee": SELLER_EVM, "recipient": BUYER_EVM, "label": label, "requestedAt": "2026-10-27T08:00:00Z", "allocateBefore": "2026-10-27T09:00:00Z",
        "settleBefore": "2026-10-27T10:00:00Z"}}


def fake_evm(calls):
    def main(argv):
        calls.append(argv)
        if argv[0] == "wrapped":
            return {"balance": "2.5", "supply": "2.5"}
        if argv[0] == "balance":
            return {"tka": 3}
        return {"tx": "0x" + argv[0] * 8, "block": 5}
    return main


class OtcTests(LedgerTestCase):
    def setUp(self):
        super().setUp()
        self.calls = []
        for patcher in (mock.patch.object(otc.evm, "main", fake_evm(self.calls)),
                        mock.patch.object(otc.evm, "make_keys", lambda folder: {"u": "0x" + SELLER_EVM, "v": "0x" + BUYER_EVM})):
            patcher.start()
            self.addCleanup(patcher.stop)
        FakeLedger.contracts[("op::1", otc.GATEWAY_TOKEN)] = [{"contractId": "gt-1", "offset": 2, "createArgument": {"evmToken": WRAPPED, "instrumentId": INSTRUMENT}}]
        self.net = canton.Network()

    def test_the_ids_are_daml_s(self):
        payment = hashlib.sha256(b"venue-trade,v::1,t1").hexdigest()
        self.assertEqual(otc.ids(self.net, "t1"), {"label": "t1", "payId": payment, "claimId": hashlib.sha256(("claim," + payment).encode()).hexdigest()})

    def test_the_offer_is_the_sellers_with_the_evm_side_in_base_units(self):
        got = otc.offer(self.net, "t1", "2.5", "0x" + TOKEN.upper(), "3")
        [made] = self.made(otc.OFFER)
        self.assertEqual((made["seller"], made["venue"], made["gateway"], made["instrument"]), ("u::1", "v::1", "gw::1", INSTRUMENT))
        self.assertEqual((made["amount"], made["token"], made["amountBase"], made["payee"], made["recipient"]), ("2.5", TOKEN, f"{3 * ONE:064x}", SELLER_EVM, BUYER_EVM))
        self.assertEqual(made["allocateWithin"], {"microseconds": "3600000000"})
        self.assertEqual(FakeLedger.submitted[0][1]["actAs"], ["u::1"])
        self.assertEqual(got["offer"], "cid-1")

    def test_an_offer_with_a_label_in_use_or_a_bad_amount_is_refused(self):
        FakeLedger.contracts[("v::1", otc.TRADE)] = [trade_event()]
        with self.assertRaises(canton.Fail):
            otc.offer(self.net, "t1", "2.5", TOKEN, "3")
        with self.assertRaises(SystemExit):
            otc.offer(self.net, "t2", "0", TOKEN, "3")
        with self.assertRaises(SystemExit):
            otc.offer(self.net, "t2", "1", TOKEN, "1.5")
        self.assertEqual(FakeLedger.submitted, [])

    def test_the_venue_accepts_the_offer(self):
        FakeLedger.contracts[("v::1", otc.OFFER)] = [{"contractId": "offer-1", "offset": 1, "createArgument": {"label": "t1"}}]
        FakeLedger.contracts[("v::1", otc.TRADE)] = [trade_event()]
        self.assertEqual(otc.accept(self.net, "t1"), {"label": "t1", "trade": "trade-1"})
        [(_, body)] = self.exercised("Accept")
        self.assertEqual((body["actAs"], body["commands"][0]["ExerciseCommand"]["contractId"]), (["v::1"], "offer-1"))

    def test_the_seller_allocates_with_the_trades_own_spec(self):
        FakeLedger.contracts[("v::1", otc.TRADE)] = [trade_event()]
        FakeLedger.contracts[("u::1", canton.TOKEN)] = [{"contractId": "hold-1", "offset": 1, "createArgument": {}}]
        got = otc.allocate(self.net, "t1")
        [(_, body)] = self.exercised("AllocationFactory_Allocate")
        argument = body["commands"][0]["ExerciseCommand"]["choiceArgument"]
        spec = argument["allocation"]
        self.assertEqual(body["actAs"], ["u::1"])
        self.assertEqual(spec["settlement"], {"executor": "v::1", "settlementRef": {"id": "t1", "cid": None}, "requestedAt": "2026-10-27T08:00:00Z",
                                              "allocateBefore": "2026-10-27T09:00:00Z", "settleBefore": "2026-10-27T10:00:00Z", "meta": {"values": {}}})
        self.assertEqual((spec["transferLegId"], spec["transferLeg"]["sender"], spec["transferLeg"]["receiver"], spec["transferLeg"]["amount"]), ("leg", "u::1", "gw::1", "2.5000000000"))
        self.assertEqual((argument["inputHoldingCids"], argument["expectedAdmin"]), (["hold-1"], "rg::1"))
        self.assertEqual(got["label"], "t1")

    def test_a_repeated_allocate_makes_no_second_allocation(self):
        FakeLedger.contracts[("v::1", otc.TRADE)] = [trade_event()]
        FakeLedger.contracts[("u::1", canton.ALLOCATION_OF_TOKEN)] = [{"contractId": "alloc-1", "offset": 1, "createArgument": {"allocation": {"settlement": {"settlementRef": {"id": "t1"}}}}}]
        self.assertEqual(otc.allocate(self.net, "t1")["allocation"], "alloc-1")
        self.assertEqual(FakeLedger.submitted, [])

    def allocated(self, owner="v::1"):
        FakeLedger.contracts[("v::1", otc.TRADE)] = [trade_event()]
        FakeLedger.contracts[(owner, canton.ALLOCATION_OF_TOKEN)] = [{
            "contractId": "alloc-1", "offset": 1, "templateId": "pkg:Splice.Testing.Tokens.TestTokenV1:TokenAllocation", "createdEventBlob": "blob-a",
            "createArgument": {"allocation": {"settlement": {"settlementRef": {"id": "t1"}}}}}]

    def test_the_venue_publishes_the_trade_with_the_allocation_disclosed(self):
        self.allocated()
        got = otc.publish(self.net, "t1")
        [made] = self.made(otc.VENUE_TRADE)
        ids = otc.ids(self.net, "t1")
        self.assertEqual((made["payId"], made["claimId"]), (ids["payId"], ids["claimId"]))
        self.assertEqual((made["venue"], made["sender"], made["allocation"], made["gatewayToken"], made["chainId"]), ("v::1", "u::1", "alloc-1", "gt-1", CHAIN_RECORD["chainId"]))
        self.assertEqual((made["token"], made["payee"], made["recipient"], made["amount"]), (TOKEN, SELLER_EVM, BUYER_EVM, f"{3 * ONE:064x}"))
        self.assertEqual(json.loads(made["allocationDisclosed"]), {"templateId": "pkg:Splice.Testing.Tokens.TestTokenV1:TokenAllocation", "contractId": "alloc-1",
                                                                  "createdEventBlob": "blob-a", "synchronizerId": "sync::1"})
        self.assertEqual(FakeLedger.submitted[0][1]["actAs"], ["v::1", "u::1"])
        self.assertEqual(got["wrappedToken"], "0x" + WRAPPED)

    def test_the_allocation_is_taken_from_the_sellers_view_if_the_venue_has_none(self):
        self.allocated(owner="u::1")
        otc.publish(self.net, "t1")
        self.assertEqual(len(self.made(otc.VENUE_TRADE)), 1)

    def test_publish_needs_the_allocation_and_is_done_once(self):
        FakeLedger.contracts[("v::1", otc.TRADE)] = [trade_event()]
        with self.assertRaises(canton.Fail):
            otc.publish(self.net, "t1")
        self.allocated()
        FakeLedger.contracts[("op::1", otc.VENUE_TRADE)] = [{"contractId": "vt-0", "offset": 1, "createArgument": {"payId": otc.ids(self.net, "t1")["payId"]}}]
        with self.assertRaises(canton.Fail):
            otc.publish(self.net, "t1")
        self.assertEqual(FakeLedger.submitted, [])

    def published(self):
        ids = otc.ids(self.net, "t1")
        FakeLedger.contracts[("op::1", otc.VENUE_TRADE)] = [{"contractId": "vt-1", "offset": 1, "createArgument": {
            "payId": ids["payId"], "token": TOKEN, "payee": SELLER_EVM, "amount": f"{3 * ONE:064x}"}}]

    def test_the_buyer_approves_then_pays_the_trades_amount_to_the_seller(self):
        self.published()
        got = otc.pay(self.net, "t1")
        payment = otc.ids(self.net, "t1")["payId"]
        self.assertEqual(self.calls, [["approve", "v", "0x" + TOKEN, "gateway", "3"], ["pay", "v", payment, "0x" + TOKEN, "0x" + SELLER_EVM, "3"]])
        self.assertEqual((got["tka"], got["tradeTka"]), (3, 3))

    def test_an_empty_amount_is_the_trades_and_the_seconds_still_count(self):
        self.published()
        got = otc.pay(self.net, "t1", "", "30")
        self.assertEqual((got["tka"], self.calls[2]), (3, ["wait", got["pay"], "30"]))

    def test_a_smaller_payment_is_sent_as_asked_and_can_be_waited_for(self):
        self.published()
        got = otc.pay(self.net, "t1", "2", "30")
        self.assertEqual([c[-1] for c in self.calls[:2]], ["2", "2"])
        self.assertEqual(self.calls[2][0], "wait")
        self.assertEqual((got["tka"], got["tradeTka"]), (2, 3))

    def test_pay_needs_the_published_trade_and_a_whole_amount(self):
        with self.assertRaises(canton.Fail):
            otc.pay(self.net, "t1")
        self.published()
        with self.assertRaises(SystemExit):
            otc.pay(self.net, "t1", "0")
        self.assertEqual(self.calls, [])

    def test_the_claim_needs_the_funded_claim_and_names_its_token_and_amount(self):
        with self.assertRaises(canton.Fail):
            otc.claim(self.net, "t1")
        self.assertEqual(self.calls, [])
        claim = otc.ids(self.net, "t1")["claimId"]
        FakeLedger.contracts[("op::1", otc.FUNDED_CLAIM)] = [{"contractId": "fc-1", "offset": 1, "createArgument": {"claimId": claim, "gatewayToken": "gt-1", "amount": "2.5000000000"}}]
        got = otc.claim(self.net, "t1")
        self.assertEqual(self.calls, [["claim", "v", claim, "0x" + WRAPPED, "2.5000000000"]])
        self.assertEqual(got["claim"], "0x" + "claim" * 8)

    def test_check_reports_both_sides_at_the_finalized_block(self):
        FakeLedger.contracts[("v::1", otc.TRADE)] = [trade_event()]
        FakeLedger.contracts[("gw::1", canton.TOKEN)] = []
        FakeLedger.contracts[("u::1", canton.TOKEN)] = [{"contractId": "h", "offset": 1, "createArgument": {"holding": {"amount": "97.5"}}}]
        got = otc.check(self.net, "t1")
        self.assertEqual((got["offer"], got["allocation"], got["venueTrade"], got["fundedClaim"]), (False, False, False, False))
        self.assertEqual(got["tkb"]["seller"], [97.5])
        self.assertEqual((got["tka"], got["wrapped"]), ({"seller": 3, "buyer": 3}, {"token": "0x" + WRAPPED, "buyer": "2.5", "supply": "2.5"}))
        self.assertTrue(all(c[-1] == "finalized" for c in self.calls))


if __name__ == "__main__":
    unittest.main()
