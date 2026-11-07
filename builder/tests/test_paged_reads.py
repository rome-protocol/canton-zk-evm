"""Every read of a list of Canton contracts on the block path is paged, and a read that fails leaves out only the legs that need the list. Anyone can
make a list long (a party signs its own acceptance or deposit request naming the chain's parties as observers), and the participant refuses a list
of more than its limit (HTTP 413): the fake ledger does the same for a whole list, so a read that is not paged fails these tests.
Against the same fakes as test_builder.py."""
import json, sys, types, unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from fakes import LEDGER_END, PAYMENT, Leg, tx

ALICE, BOB, WD, DEP, PAY = tb.ALICE, tb.BOB, tb.WD, tb.DEP, tb.PAY
MANY = 450   # three pages of 200
TOKENS = "tokens"   # the fake ledger's list of gateway tokens

# What each kind of leg needs on Canton, under the names of the fake ledger's lists.
BASE = {
    "withdrawal": (WD, "WithdrawalLeg", {"acceptances": [tb.ACCEPTANCE], TOKENS: [tb.TOKEN], "holdings": [tb.holding("h-1", "6.0")]}),
    "deposit": (DEP, "DepositLeg", {"requests": [tb.REQUEST], TOKENS: [tb.TOKEN], "claims": [], "trades": [], "allocations": ["alloc-d1"]}),
    "payment": (PAY, "PaymentLeg", {"terms": [tb.TERMS], "allocations": ["alloc-1"]}),
}


def spam(attr, i):
    """The i-th contract of a list that someone made long: it is of the right template and matches no leg."""
    pad = f"{i:064x}"
    return {
        "acceptances": (f"spam-{i}", {**tb.ACCEPTANCE[1], "party": f"s{i}::1"}),
        "requests": (f"spam-{i}", {**tb.REQUEST[1], "depositId": pad}),
        "terms": (f"spam-{i}", {**tb.TERMS[1], "dvpId": pad}),
        "tokens": (f"spam-{i}", {**tb.TOKEN[1], "evmToken": pad[:40]}),
        "claims": (f"spam-{i}", {**tb.CLAIM[1], "claimId": pad}),
        "trades": (f"spam-{i}", {**tb.TRADE[1], "payId": pad}),
        "holdings": tb.holding(f"spam-{i}", "1.0", owner="other::1"),
        "allocations": f"spam-{i}",
    }[attr]


# the template (or interface) the fake ledger names a list by, and what the leg's reason calls the list
NAMES = {"acceptances": ("WithdrawalAcceptance", "withdrawal acceptances"), "requests": ("DepositRequest", "deposit requests"),
         "terms": ("DvpTerms", "payment terms"), "tokens": ("GatewayToken", "gateway tokens"), "claims": ("FundedClaim", "funded claims"),
         "trades": ("VenueTrade", "venue trades"), "holdings": ("Holding", "holdings"), "allocations": ("Allocation", "allocations")}


class PagedReads(tb.LegCase):
    def scene(self, kind, **more):
        """Alice's transaction records a leg of this kind, Bob's is plain; `more` replaces lists of the kind's Canton side."""
        leg, tag, lists = BASE[kind]
        s = self.setup({ALICE: [], BOB: []})
        for attr, value in {**lists, **more}.items():
            setattr(s.ledger, attr, list(value))
        t, plain = self.leg_tx(s, leg), tx(BOB, 0)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [t], [plain]
        return s, t, plain, tag

    @staticmethod
    def reads(s, attr):
        return [q for q in s.ledger.queries if NAMES[attr][0] in json.dumps(q)]

    def test_every_list_that_is_made_long_is_read_in_pages_and_the_right_leg_is_still_matched(self):
        for kind, attr in (("withdrawal", "acceptances"), ("withdrawal", "tokens"), ("withdrawal", "holdings"),
                           ("deposit", "requests"), ("deposit", "tokens"), ("deposit", "allocations"), ("deposit", "claims"), ("deposit", "trades"),
                           ("payment", "terms"), ("payment", "allocations")):
            with self.subTest(kind=kind, list=attr):
                real = BASE[kind][2][attr]
                s, t, plain, tag = self.scene(kind, **{attr: [spam(attr, i) for i in range(MANY)] + real})
                result = self.build(s)
                self.attached(s, tag)   # the one leg, matched with the contract that is last in the list
                self.assertEqual((result["legs"], result["leftOut"], len(s.builds())), (1, [], 1))
                self.assertEqual(s.ledger.unpaged, [])   # no list is read whole
                pages = self.reads(s, attr)
                self.assertEqual(len(pages), -(-(MANY + len(real)) // b.LIST_PAGE))
                self.assertEqual({q["maxPageSize"] for q in pages}, {b.LIST_PAGE})
                self.assertNotIn("activeAtOffset", pages[0])   # the first page is read at the ledger end the participant picks...
                self.assertEqual({q["activeAtOffset"] for q in pages[1:]}, {LEDGER_END})   # ...and every later page at the offset it answered with
                self.assertEqual([(q.get("pageToken") or "0").split("|")[0] for q in pages], ["0", "200", "400"][:len(pages)])

    def test_a_block_reads_a_list_of_10000_contracts_in_50_requests_and_every_other_list_in_one(self):
        s, t, plain, tag = self.scene("withdrawal", acceptances=[spam("acceptances", i) for i in range(9999)] + [tb.ACCEPTANCE])
        self.build(s)
        self.attached(s, tag)
        self.assertEqual(len(self.reads(s, "acceptances")), 50)
        # the chain, the token, the acceptances in 50 pages, the holdings: nothing else, and nothing is read twice
        self.assertEqual(len(s.ledger.queries), 1 + 1 + 50 + 1)
        self.assertEqual(s.ledger.unpaged, [])
        self.assertLessEqual(s.ledger.gets.count("/v2/state/ledger-end"), 1)   # no list asks for the ledger end first: only the submit does

    def test_two_passes_of_one_block_read_each_list_once(self):
        s = self.setup({ALICE: [], BOB: []})
        s.ledger.terms, s.ledger.allocations = [tb.TERMS], ["alloc-1"]
        good = self.leg_tx(s, PAY)
        bad = self.leg_tx(s, Leg(PAYMENT,"ff" * 32, tb.TKA, tb.PAYEE, 10), sender=BOB)   # no terms for it: it is left out and the block is built again
        s.reth.pool[ALICE], s.reth.pool[BOB] = [good], [bad]
        result = self.build(s)
        self.attached(s, "PaymentLeg")
        self.assertEqual(([x["transaction"] for x in result["leftOut"]], len(s.builds())), ([bad["hash"]], 2))
        for attr in ("terms", "allocations", "trades"):
            self.assertEqual(len(self.reads(s, attr)), 1, attr)   # read in the first pass, kept for the second

    def test_a_slow_participant_hits_the_total_limit_and_only_its_leg_is_left_out(self):
        s, t, plain, tag = self.scene("withdrawal", acceptances=[tb.ACCEPTANCE] + [spam("acceptances", i) for i in range(1100)])   # six pages, each inside its own time
        s.ledger.list_failure, s.ledger.list_delay = {"WithdrawalAcceptance": "timeout"}, 0.2
        with mock.patch.object(b, "LIST_TOTAL", 0.5):
            result = self.assert_left_out(s, t, "withdrawal acceptances cannot be read")
        self.assertIn(plain["hash"], result["transactions"])
        self.assertLess(len(self.reads(s, "acceptances")), 6)   # it gave up before the last page

    def test_a_list_longer_than_the_most_pages_leaves_out_only_the_legs_that_need_it(self):
        s, t, plain, tag = self.scene("withdrawal", acceptances=[tb.ACCEPTANCE] + [spam("acceptances", i) for i in range(700)])   # the match is on page 1: a part of the list is never used
        with mock.patch.object(b, "LIST_MAX_PAGES", 3):
            result = self.assert_left_out(s, t, "withdrawal acceptances cannot be read", "pages")
        self.assertIn(plain["hash"], result["transactions"])

    def test_a_read_that_fails_leaves_out_only_the_legs_that_need_the_list_and_the_block_is_made(self):
        needs = {"withdrawal": ("acceptances", "tokens", "holdings"), "deposit": ("requests", "tokens", "allocations", "claims", "trades"),
                 "payment": ("terms", "allocations")}
        modes = (("413", 413, "HTTP 413"), ("500", 500, "HTTP 500"), ("timeout", "timeout", "cannot be read"), ("not JSON", "bad json", "cannot be used"))
        for kind, attrs in needs.items():
            for attr in attrs:
                for mode, failure, word in modes:
                    with self.subTest(kind=kind, list=attr, failure=mode):
                        s, t, plain, tag = self.scene(kind)
                        s.ledger.list_failure = {NAMES[attr][0]: failure}
                        with mock.patch.object(b, "LIST_TIMEOUT", 0.3):
                            result = self.assert_left_out(s, t, NAMES[attr][1] + " cannot be read", word)
                        self.assertIn(plain["hash"], result["transactions"])   # another sender's transaction is in the block

    def test_a_later_page_that_fails_leaves_out_the_leg_though_the_match_is_on_page_1(self):
        needs = {"withdrawal": ("acceptances", "tokens", "holdings"), "deposit": ("requests", "tokens", "allocations"), "payment": ("terms", "allocations")}
        modes = (("413", 413, "HTTP 413"), ("500", 500, "HTTP 500"), ("timeout", "timeout", "cannot be read"), ("not JSON", "bad json", "cannot be used"),
                 ("no template", "no template", "HTTP 404"))   # on a later page "no such template" is no answer either
        for kind, attrs in needs.items():
            for attr in attrs:
                for mode, failure, word in modes:
                    with self.subTest(kind=kind, list=attr, failure=mode):
                        s, t, plain, tag = self.scene(kind, **{attr: BASE[kind][2][attr] + [spam(attr, i) for i in range(MANY)]})
                        s.ledger.list_failure, s.ledger.list_failure_from_page = {NAMES[attr][0]: failure}, 1
                        with mock.patch.object(b, "LIST_TIMEOUT", 0.3):
                            result = self.assert_left_out(s, t, NAMES[attr][1] + " cannot be read", word)
                        self.assertIn(plain["hash"], result["transactions"])
                        self.assertGreater(len(self.reads(s, attr)), 1)   # page 1 was read and held the match: it was not used

    def test_no_such_template_on_a_later_page_of_an_optional_list_is_not_an_empty_list(self):
        for attr in ("trades", "claims"):
            with self.subTest(list=attr):
                s, t, plain, tag = self.scene("deposit", **{attr: [spam(attr, i) for i in range(MANY)]})
                s.ledger.list_failure, s.ledger.list_failure_from_page = {NAMES[attr][0]: "no template"}, 1
                self.assert_left_out(s, t, NAMES[attr][1] + " cannot be read", "HTTP 404")
        s, t, plain, tag = self.scene("deposit")   # on page 1 it is: the participant holds no such template, so there are none
        s.ledger.no_040 = True
        self.build(s)
        self.attached(s, "DepositLeg")

    def test_an_unreadable_list_ends_the_leg_instead_of_trying_another_kind_of_match(self):
        unreadable = b.ListUnreadable("the payment terms' list cannot be read")
        pay, dep = types.SimpleNamespace(id=PAY.id), types.SimpleNamespace(id=DEP.id, account=DEP.account)
        with mock.patch.object(b, "names_chain", lambda *a: True), mock.patch.object(b, "terms_leg", side_effect=unreadable), \
                mock.patch.object(b, "trade_leg", side_effect=AssertionError("a trade is not tried")):
            canton = types.SimpleNamespace(chain={}, terms=[{"dvpId": PAY.id}], trades=[{"payId": PAY.id}])
            with self.assertRaises(b.ListUnreadable):
                b.payment_leg(pay, canton, None)
        with mock.patch.object(b, "names_chain", lambda *a: True), mock.patch.object(b, "request_leg", side_effect=unreadable):
            canton = types.SimpleNamespace(chain={}, claims=[], trades=[], requests=[{"depositId": DEP.id, "recipient": DEP.account}])
            with self.assertRaises(b.ListUnreadable):   # not the plain NoCantonSide that a failed request gives
                b.deposit_leg(dep, canton, None)


if __name__ == "__main__":
    unittest.main()
