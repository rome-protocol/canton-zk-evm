"""A block's legs are matched again just before its Advance is sent (a contract that its signer archived while the block was proven stops it, and the block is
built again without that leg), and a refusal that names a leg's contract is held against the leg's party, never against the block's transactions.
Against the same fakes as test_builder.py. Run: python3 -m unittest discover -s builder/tests"""
import sys, unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
import test_producer as tp
from fakes import HEAD_NUMBER

DEPOSITOR = tb.REQUEST[1]["depositor"]


def deposit_block(case, **k):
    s = case.setup({tb.ALICE: []}, **k)
    s.ledger.requests = [tb.REQUEST]
    s.ledger.tokens.append(tb.TOKEN)
    t = tb.tx(tb.ALICE, 0)
    s.reth.tx_legs[t["hash"]] = [tb.DEP]
    s.reth.pool[tb.ALICE] = [t]
    return s, t


class Recheck(tb.LegCase):
    def setUp(self):
        patch = mock.patch.object(b, "RECHECK_AFTER", 0)   # the fakes prove in a blink: the second look is made at once
        patch.start()
        self.addCleanup(patch.stop)

    def archive_after_proof(self, s, change):
        real = b.prove

        def prove(*a, **k):
            proven = real(*a, **k)
            change(s)   # what the signer does while the proof is made
            return proven
        return mock.patch.object(b, "prove", prove)

    def test_a_request_archived_while_the_block_is_proven_stops_the_advance(self):
        s, t = deposit_block(self)
        with self.archive_after_proof(s, lambda s: setattr(s.ledger, "requests", [])), self.assertRaises(b.StaleLegs) as e:
            b.build_block(s.cfg)
        self.assertIsInstance(e.exception, b.StaleProof)   # the producers' handling of a dropped proof applies as it is
        self.assertIn("no Canton side", str(e.exception))
        self.assertEqual(s.ledger.submitted, [])
        self.assertIn(t["hash"], self.in_pool(s))   # reth is back at Canton's head and the transaction waits in the pool

    def test_the_block_built_again_leaves_the_archived_leg_out_and_commits(self):
        s, t = deposit_block(self)
        with self.archive_after_proof(s, lambda s: setattr(s.ledger, "requests", [])), self.assertRaises(b.StaleLegs):
            b.build_block(s.cfg)
        result = self.build(s)
        self.assertEqual((result["legs"], [x["transaction"] for x in result["leftOut"]]), (0, [t["hash"]]))
        self.assertIn("no deposit request", result["leftOut"][0]["reason"])

    def test_a_block_whose_legs_are_all_still_there_is_sent_as_before(self):
        s, t = deposit_block(self)
        result = self.build(s)
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))
        self.assertEqual(self.attached(s, "DepositLeg")["request"], "req-1")

    def test_a_read_that_fails_at_the_second_look_says_nothing_and_the_block_is_sent(self):
        s, t = deposit_block(self)
        with self.archive_after_proof(s, lambda s: s.ledger.list_failure.update({"DepositRequest": 500})):
            result = self.build(s)
        self.assertEqual(result["legs"], 1)

    def test_a_block_matched_moments_ago_is_sent_as_it_is_without_a_second_read(self):
        s, t = deposit_block(self)
        with mock.patch.object(b, "RECHECK_AFTER", 5.0), self.archive_after_proof(s, lambda s: setattr(s.ledger, "requests", [])):
            self.assertEqual(self.build(s)["legs"], 1)   # the proof took a blink: Canton is left to refuse it, as before

    def test_the_second_look_is_on_by_default_and_CZE_RECHECK_LEGS_0_turns_it_off(self):
        self.assertIs(b.Config.__dataclass_fields__["recheck_legs"].default, True)
        s, t = deposit_block(self)
        s.cfg.recheck_legs = False
        with self.archive_after_proof(s, lambda s: setattr(s.ledger, "requests", [])):
            self.assertEqual(self.build(s)["legs"], 1)   # sent as it was proven: Canton is left to refuse it

    def test_a_block_with_no_leg_reads_nothing_more(self):
        s = self.setup({tb.ALICE: [tb.tx(tb.ALICE, 0)]})
        self.build(s)
        self.assertEqual(s.ledger.queries, [x for x in s.ledger.queries if "ZkChain" in str(x)])


class Blame(tp.Loop):
    GONE = "CONTRACT_NOT_FOUND(11,0): Contract could not be found with id {}"

    def setup_refused(self, text):
        s, t = deposit_block(self, refuse=text)
        return s, t, self.producer(s, cooldown=600)

    def test_a_refusal_that_names_a_legs_contract_holds_the_legs_party_and_never_the_transaction(self):
        s, t, p = self.setup_refused(self.GONE.format("req-1"))
        p.step()
        self.assertEqual(self.reports[0]["contractParties"], [DEPOSITOR])
        self.assertIn(DEPOSITOR, p.blame.until)
        p.step()   # refused again: the leg is out of this block now, so the block carries nothing of it
        self.assertEqual(p.excluded, {})
        self.assertEqual(self.status()["excluded"], [])
        self.assertEqual(self.status()["heldParties"][DEPOSITOR]["strikes"], 1)

    def test_the_held_party_is_let_in_again_after_the_cool_down(self):
        s, t, p = self.setup_refused(self.GONE.format("req-1"))
        p.step()
        s.ledger.refuse = None
        p.step()
        self.assertEqual([x["transaction"] for x in self.reports[-1]["leftOut"]], [t["hash"]])   # its leg is left out while the party is held, and the transaction waits in the pool
        self.assertIn("held back", self.reports[-1]["leftOut"][0]["reason"])
        self.now[0] += 601
        p.step()
        self.assertEqual((self.reports[-1]["committed"], self.reports[-1]["legs"]), (True, 1))

    def test_a_refusal_that_names_no_leg_contract_is_held_against_the_transactions_as_before(self):
        s, t, p = self.setup_refused(self.GONE.format("some-other-contract"))
        p.step(); p.step()
        self.assertNotIn("contractParties", self.reports[0])
        self.assertEqual(p.blame.until, {})
        self.assertEqual(list(p.excluded), [t["hash"]])

    def test_a_refusal_that_names_the_chain_contract_is_still_no_fault(self):
        s, t, p = self.setup_refused(self.GONE.format("chain-cid"))
        p.step(); p.step()
        self.assertEqual((p.blame.until, p.excluded), ({}, {}))


if __name__ == "__main__":
    unittest.main()
