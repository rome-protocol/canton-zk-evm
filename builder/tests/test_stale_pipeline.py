"""A StaleProof raised by prepare_submit under the Pipeline (from start_send, or from after_commit when the next block is sent inside a commit) unwinds the flight: reth stays on the committed block, the finalized block never goes back, and the rebuilt block commits."""
import sys, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import builder as b
import test_pipeline as tp
import test_submit_thread as tst
from fakes import HEAD_NUMBER, tx

ALICE, BOB = tp.ALICE, tp.BOB


class StaleUnderPipeline(tp.Depth):
    def run_case(self, k, txs):
        s = self.setup({})
        p = self.pipeline(s, k)
        for sender, t in txs:
            s.reth.pool.setdefault(sender, []).append(t)
        real, state = b.prepare_submit, {"armed": True}

        def prepare(*a, **kw):
            if state["armed"]:
                state["armed"] = False
                raise b.StaleProof("a deposit of block X can be settled until soon")
            return real(*a, **kw)
        patch = mock.patch.object(b, "prepare_submit", prepare)
        patch.start()
        self.addCleanup(patch.stop)
        self.drive(p, lambda: self.reports)
        failed = [dict(r) for r in self.reports]
        self.drive(p, lambda: len(self.committed()) >= 1)
        return s, failed

    def check(self, k, txs):
        s, failed = self.run_case(k, txs)
        self.assertEqual([r["committed"] for r in failed], [False])
        self.assertIn("can be settled until", failed[0]["error"])
        self.assertEqual(self.committed()[0], HEAD_NUMBER + 1)
        self.assertTrue(s.ledger.submitted)
        sent = [h for r in self.reports if r.get("committed") for h in r["transactions"]]
        self.assertEqual(sorted(sent), sorted(t["hash"] for _, t in txs)[:len(sent)])

    def test_k1(self):
        self.check(1, [(ALICE, tx(ALICE, 0))])

    def test_k2(self):
        self.check(2, [(ALICE, tx(ALICE, 0)), (BOB, tx(BOB, 0))])


class StaleAfterCommit(tst.Held):
    def test_the_next_block_stale_when_started_from_the_commit(self):
        s = self.setup({})
        p = self.pipeline(s, 3)
        self.hold(s)
        self.cut_one(s, p, ALICE, 1)
        self.until_sending(s, p)
        self.cut_one(s, p, BOB, 2)
        self.proven(p, 1)
        real, state = b.prepare_submit, {"armed": True}

        def prepare(cfg, reth, built, proven, attempt):
            if built.n == tst.FIRST + 1 and state["armed"]:
                state["armed"] = False
                raise b.StaleProof(f"a deposit of block {built.n} can be settled until soon")
            return real(cfg, reth, built, proven, attempt)
        with mock.patch.object(b, "prepare_submit", prepare):
            self.release(s)
            self.drive(p, lambda: len(self.committed()) == 2, limit=60)
        self.assertEqual(self.committed(), [tst.FIRST, tst.FIRST + 1])
        self.assert_final_never_back(s)
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (self.reports[-1]["blockHash"],) * 2)
        sent = [h for r in self.reports if r.get("committed") for h in r["transactions"]]
        self.assertEqual(sorted(sent), sorted([tx(ALICE, 0)["hash"], tx(BOB, 0)["hash"]]))


if __name__ == "__main__":
    unittest.main()
