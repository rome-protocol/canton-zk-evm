"""network/sync_reth.py with the builder's in-doubt record: the command is settled first, and only then is reth reconciled."""
import sys, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent.parent / "network"))
import builder as b
import sync_reth
from fakes import HEAD_HASH, HEAD_NUMBER, tx
from test_builder import ALICE, Setup


class StubReth:
    """What sync_reth sees of reth: the block it holds is the one the builder built, which Canton has not shown yet."""
    def __init__(self, number, block_hash):
        self.number, self.hash, self.updates = number, block_hash, []

    def call(self, method, params):
        if method == "eth_getBlockByNumber":
            return {"number": hex(self.number), "hash": self.hash, "transactions": []}
        if method == "eth_getBlockByHash":
            return {"number": hex(self.number), "hash": self.hash} if params[0] == self.hash else None
        raise AssertionError(method)

    def forkchoice(self, head, safe, finalized):
        self.updates.append(head)
        if head != self.hash:
            raise AssertionError(f"reth was moved to {head}: the block {self.hash} was unwound")


class WithARecord(unittest.TestCase):
    def in_doubt(self):
        s = Setup({ALICE: [tx(ALICE, 0)]})
        self.addCleanup(s.close)
        s.ledger.late = True   # the Advance is answered with a 503; the command commits (or fails) only when `land` is called
        result = b.build_block(s.cfg)
        self.assertIsNone(result["committed"])
        self.assertTrue(b.unresolved_path(s.cfg).exists())
        return s, result

    def sync(self, s, reth, wait):
        return sync_reth.sync(s.cfg, b, reth.call, reth.forkchoice, wait)

    def test_a_command_that_commits_after_the_start_is_settled_first_and_reth_keeps_its_block(self):
        s, result = self.in_doubt()
        reth = StubReth(HEAD_NUMBER + 1, result["blockHash"])
        waited = []
        def wait(seconds):   # Canton's head is still the old one when sync_reth starts; the command commits while it waits
            waited.append(seconds)
            s.ledger.land(ok=True)
        r = self.sync(s, reth, wait)
        self.assertEqual(waited, [2])
        self.assertEqual((r["canton_head"], r["moved"], r["dropped_transactions"]), (HEAD_NUMBER + 1, "no", 0))
        self.assertEqual((r["in_doubt_committed"], r["in_doubt_resolved"]), ("yes", "completion"))
        self.assertEqual(set(reth.updates), {result["blockHash"]})   # only ever Canton's new head: no unwind
        self.assertFalse(b.unresolved_path(s.cfg).exists())

    def test_a_command_that_failed_is_settled_as_refused_and_reth_goes_to_the_old_head(self):
        s, result = self.in_doubt()
        s.ledger.land(ok=False)
        reth = StubReth(HEAD_NUMBER, HEAD_HASH)
        # recover_saved moves the real fake reth back; the stub only has to agree with Canton's head afterwards
        r = self.sync(s, reth, lambda seconds: None)
        self.assertEqual((r["canton_head"], r["in_doubt_committed"], r["in_doubt_resolved"]), (HEAD_NUMBER, "no", "completion"))
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH)
        self.assertFalse(b.unresolved_path(s.cfg).exists())

    def test_without_a_record_nothing_is_settled(self):
        s = Setup({})
        self.addCleanup(s.close)
        reth = StubReth(HEAD_NUMBER, HEAD_HASH)
        r = self.sync(s, reth, lambda seconds: self.fail("nothing to wait for"))
        self.assertEqual(r["canton_head"], HEAD_NUMBER)
        self.assertNotIn("in_doubt_committed", r)
        self.assertEqual(s.engine("engine_forkchoiceUpdatedV3"), [])

    def test_a_running_producer_is_refused_and_nothing_is_touched(self):
        s, result = self.in_doubt()
        reth = StubReth(HEAD_NUMBER + 1, result["blockHash"])
        before = len(s.forkchoices())
        with b.work_lock(s.cfg.work_dir):
            with self.assertRaisesRegex(sync_reth.SyncError, "builder is running.*builder.lock"):
                self.sync(s, reth, lambda seconds: self.fail("settled while the producer holds the lock"))
        self.assertEqual((reth.updates, len(s.forkchoices())), ([], before))
        self.assertTrue(b.unresolved_path(s.cfg).exists())


if __name__ == "__main__":
    unittest.main()
