"""Every read of a list of Canton contracts on the block path is paged, and a read that fails leaves out only the legs that need the list. Anyone can
make a list long (a party signs its own acceptance or deposit request naming the chain's parties as observers), and the participant refuses a list
of more than its limit (HTTP 413): the fake ledger does the same for a whole list, so a read that is not paged fails these tests.
Against the same fakes as test_builder.py."""
import json, sys, unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from fakes import tx

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
                self.assertEqual(len({q["activeAtOffset"] for q in pages}), 1)   # every page is read at the offset of the first
                self.assertEqual([q.get("pageToken") for q in pages], [None, "200", "400"][:len(pages)])

    def test_a_block_reads_a_list_of_10000_contracts_in_50_requests_and_every_other_list_in_one(self):
        s, t, plain, tag = self.scene("withdrawal", acceptances=[spam("acceptances", i) for i in range(9999)] + [tb.ACCEPTANCE])
        self.build(s)
        self.attached(s, tag)
        self.assertEqual(len(self.reads(s, "acceptances")), 50)
        # the chain, the token, the acceptances in 50 pages, the holdings: nothing else, and nothing is read twice
        self.assertEqual(len(s.ledger.queries), 1 + 1 + 50 + 1)
        self.assertEqual(s.ledger.unpaged, [])

    def test_a_list_longer_than_the_most_pages_leaves_out_only_the_legs_that_need_it(self):
        s, t, plain, tag = self.scene("withdrawal", acceptances=[spam("acceptances", i) for i in range(700)] + [tb.ACCEPTANCE])
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


if __name__ == "__main__":
    unittest.main()
