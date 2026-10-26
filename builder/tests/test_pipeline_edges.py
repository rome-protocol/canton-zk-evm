"""The producer that keeps several blocks in flight, at the edges: the head a restore moves reth to is checked, and a block whose Advance had no
answer is settled with blocks built on it in flight, or after a restart that left them behind. Built directly at two and three blocks."""
import json, sys, unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
import test_pipeline as tp
from fakes import HEAD_HASH, HEAD_NUMBER, tx

ALICE, BOB, CAROL = tb.ALICE, tb.BOB, tb.CAROL
FIRST = HEAD_NUMBER + 1
FAR_FUTURE = "2100-01-01T00:00:00.000000Z"


class Edges(tp.Depth):
    SENDERS = (ALICE, BOB, CAROL)

    def hashes(self, k, first=0):
        return {tx(x, 0)["hash"] for x in self.SENDERS[first:k]}

    def heads_read(self):
        """Counts the reads of Canton's head from now on."""
        count = [0]
        real = b.Ledger.head
        def counted(ledger):
            count[0] += 1
            return real(ledger)
        patch = mock.patch.object(b.Ledger, "head", counted)
        patch.start()
        self.addCleanup(patch.stop)
        return count

    def blocks_built(self, s):
        """The height of every block reth imported, in order."""
        return [int(p[0]["blockNumber"], 16) for m, p in s.reth.engine_calls if m == "engine_newPayloadV4"]

    def canton_head(self, s):
        return "0x" + s.ledger.head["headHash"]

    def in_doubt(self, k, s=None, **ledger):
        """`k` blocks cut one after the other; the oldest one's Advance times out (the command commits or fails only when the test says), the
        others are in flight above it."""
        s = s or self.setup({}, **ledger)
        s.ledger.late = True
        self.script(tp.A, "sleep 1")
        p = self.pipeline(s, k)
        self.fill(s, p, k)
        self.assertIsNone(self.reports[0]["committed"])
        self.assertEqual((p.unresolved["number"], len(p.flight)), (FIRST, k - 1))
        return s, p

    def idle_in_doubt(self, s, p, steps=3):
        """Steps while the command is in doubt, with work waiting in the pool: nothing is cut, built, submitted or moved."""
        s.reth.pool[tp.DAVE] = [tx(tp.DAVE, 0)]
        before = (len(self.blocks_built(s)), len(self.built(s)), len(self.lines(s, "cut")), len(s.reth.engine_calls), self.numbers(s))
        for _ in range(steps):
            self.step(p)
        self.assertEqual((len(self.blocks_built(s)), len(self.built(s)), len(self.lines(s, "cut")), len(s.reth.engine_calls), self.numbers(s)), before)
        self.assertEqual(self.numbers(s), [FIRST])
        self.assertEqual(s.reth.head, p.flight[-1].hash, "reth stays on the newest block in flight")
        self.assertEqual(self.finals(s)[-1], HEAD_HASH)


class RestoreHeadGuard(Edges):
    """A restore after the start never takes reth below the last block this process saw committed, and moves to the head it checked."""

    def test_a_restore_with_nothing_in_flight_does_not_go_below_the_last_block(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        p = self.pipeline(s, 2)
        self.drive(p, lambda: self.committed())
        t = tx(tp.DAVE, 0)
        b.save_kept(s.cfg, [(t["hash"], tb.raw_of(t))], FIRST + 1)   # a block that was cut short: its transactions are saved
        before = len(s.reth.engine_calls)
        real = b.Ledger.head
        with mock.patch.object(b.Ledger, "head", lambda l: {**real(l), "headNumber": HEAD_NUMBER, "headHash": HEAD_HASH[2:]}):   # a read that lags the commit
            self.step(p)
        self.assertEqual(len(s.reth.engine_calls), before, "reth does not move")
        self.assertIn("below block", self.reports[-1]["error"])
        self.assertTrue(b.saved_path(s.cfg).exists(), "the copies stay")
        self.assertEqual(self.in_pool(s), set())
        self.step(p)   # the head is read again: the restore goes through
        self.assertFalse(b.saved_path(s.cfg).exists())

    def test_the_head_the_unwind_checked_is_the_one_reth_goes_to(self):
        s = self.setup({}, refuse="the sidecar refused the proof")
        self.script(tp.A, "sleep 1")
        s.reth.no_state_for_genesis = True
        p = self.pipeline(s, 2)
        self.fill(s, p, 2)
        self.assertTrue(p.unwind_pending)
        s.reth.no_state_for_genesis = False
        reads = self.heads_read()
        self.step(p)
        self.assertEqual(reads[0], 1, "one read of Canton's head, checked and then used")
        self.assertFalse(p.unwind_pending)
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (HEAD_HASH, HEAD_HASH))
        self.assertEqual(self.in_pool(s), self.hashes(2))

    def test_the_head_fault_of_the_unwind_names_the_head_number(self):
        s = self.setup({}, refuse="the sidecar refused the proof")
        self.script(tp.A, "sleep 1")
        s.reth.no_state_for_genesis = True
        p = self.pipeline(s, 2)
        self.fill(s, p, 2)
        s.reth.no_state_for_genesis = False
        known = next(h for h in s.reth.blocks if h != HEAD_HASH)
        real = b.Ledger.head
        with mock.patch.object(b.Ledger, "head", lambda l: {**real(l), "headHash": known[2:], "headNumber": HEAD_NUMBER + 1}):
            self.step(p)
        self.assertRegex(self.status()["headFault"], rf"head is block {HEAD_NUMBER + 1} \({known[2:]}\), not block {HEAD_NUMBER} ")


class CancelledLine(Edges):
    def test_the_journal_table_names_the_cancelled_line(self):
        readme = (HERE.parent / "README.md").read_text()
        row = next((x for x in readme.splitlines() if x.startswith("| `cancelled`")), "")
        for field in ("number", "depends_on", "reason"):
            self.assertIn(field, row)


class Nits(Edges):
    def test_a_refusal_and_a_failed_cut_in_one_step_back_off_once(self):
        s = self.setup({}, refuse="the sidecar refused the proof")
        self.script(tp.A, "sleep 1")
        p = self.pipeline(s, 2)
        s.reth.pool[ALICE] = [tx(ALICE, 0)]
        self.drive(p, lambda: len(self.lines(s, "cut")) == 1)
        p.flight[0].proving.ticket.done.wait(30)   # the proof is back: the oldest block is submitted in the next step
        def broken(*a, **kw):
            raise b.BuilderError("reth cannot build")
        s.reth.pool[BOB] = [tx(BOB, 0)]
        waits = len(self.waits)
        with mock.patch.object(b, "build", broken):
            self.step(p)   # the second cut fails; the oldest block is refused in the same step
        self.assertEqual([r.get("committed") for r in self.reports if "committed" in r], [False, False], "the refusal, and the failed cut")
        self.assertEqual(len(self.waits) - waits, 1, "one back-off for the step")
        self.assertEqual(sum("reth cannot build" in json.dumps(r) for r in self.reports), 1, "the failed cut is told")


class InDoubtFlight(Edges):
    """The oldest block's Advance has no answer while blocks built on it are in flight."""

    def check_committed(self, k):
        s, p = self.in_doubt(k)
        self.idle_in_doubt(s, p)
        s.ledger.land(ok=True)
        s.ledger.late = False
        self.step(p)
        done = [x for x in self.reports if x.get("resolved")]
        self.assertEqual([(x["resolved"], x["number"]) for x in done], [("committed", FIRST)])
        self.assertEqual(p.last, (FIRST, done[0]["blockHash"]))
        self.assertEqual(len(p.flight), k - 1, "the blocks built on it are still in flight")
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (p.flight[-1].hash, done[0]["blockHash"]), "reth keeps the tip, and only the block is final")
        self.assertEqual({e["number"] for e in b.saved_file_entries(s.cfg)}, set(range(FIRST + 1, FIRST + k)))
        self.drive(p, lambda: not p.flight and p.unresolved is None and int(s.ledger.head["headNumber"]) >= FIRST + k - 1)
        self.assertEqual(self.numbers(s)[:k], list(range(FIRST, FIRST + k)), "each block is sent once, after the one before it")
        self.assertEqual(len(set(self.blocks_built(s)[:k])), k, "no height was built twice while the command was in doubt")
        self.assertEqual(s.reth.head, self.canton_head(s))
        self.assertEqual(self.finals(s)[-1], self.canton_head(s))
        self.assertEqual(self.lines(s, "cancelled"), [])
        self.assertEqual(self.lines(s, "resolved")[0]["outcome"], "committed")
        self.assertEqual([x["outcome"] for x in self.lines(s, "resolved")], ["committed"], "nothing is closed as restarted")

    def test_a_command_that_commits_later_at_two(self):
        self.check_committed(2)

    def test_a_command_that_commits_later_at_three(self):
        self.check_committed(3)

    def check_not_committed(self, k):
        s, p = self.in_doubt(k)
        self.idle_in_doubt(s, p)
        s.ledger.land(ok=False, message="UNKNOWN_CONTRACT_SYNCHRONIZERS")
        s.ledger.late = False
        self.step(p)
        done = [x for x in self.reports if x.get("resolved")]
        self.assertEqual([(x["resolved"], x["number"]) for x in done], [("not committed", FIRST)])
        self.assertEqual(p.flight, [])
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (HEAD_HASH, HEAD_HASH))
        self.assertEqual(self.in_pool(s), self.hashes(k) | {tx(tp.DAVE, 0)["hash"]})
        self.assertFalse(b.saved_path(s.cfg).exists())
        self.assertEqual([(x["attempt"], x["depends_on"]) for x in self.lines(s, "cancelled")], [(i, 1) for i in range(2, k + 1)])
        self.assertEqual([(x["attempt"], x["outcome"]) for x in self.lines(s, "resolved")], [(1, "not committed")], "the blocks above it are cancelled, not restarted")
        self.assertEqual(self.numbers(s), [FIRST])
        self.drive(p, lambda: int(s.ledger.head["headNumber"]) >= FIRST)   # the transactions go in a new block at the same height
        self.assertEqual(self.numbers(s), [FIRST, FIRST])
        self.assertEqual(s.reth.head, self.canton_head(s))

    def test_a_command_that_fails_later_at_two(self):
        self.check_not_committed(2)

    def test_a_command_that_fails_later_at_three(self):
        self.check_not_committed(3)

    def test_a_move_that_fails_after_a_commit_is_made_again_at_two(self):
        s, p = self.in_doubt(2)
        s.ledger.land(ok=True)
        s.ledger.late = False
        real = b.Reth.forkchoice
        failed = []
        def forkchoice(reth, head, safe, finalized):
            if not failed and finalized != HEAD_HASH and head != finalized:   # the move that makes the block final and keeps the tip
                failed.append(finalized)
                raise b.BuilderError("reth is down")
            return real(reth, head, safe, finalized)
        with mock.patch.object(b.Reth, "forkchoice", forkchoice):
            self.step(p)
            self.assertTrue(failed)
            self.assertIsNotNone(p.unresolved, "the command stays in doubt until reth has moved")
            self.assertEqual(self.numbers(s), [FIRST], "the next block is not sent meanwhile")
            self.assertEqual(len(p.flight), 1)
            self.step(p)
        self.assertIsNone(p.unresolved)
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (p.flight[-1].hash, failed[0]))
        self.assertEqual(p.last[0], FIRST)
        self.assertEqual([x["outcome"] for x in self.lines(s, "resolved")], ["committed"])
        self.drive(p, lambda: not p.flight and int(s.ledger.head["headNumber"]) >= FIRST + 1)
        self.assertEqual(self.numbers(s), [FIRST, FIRST + 1])
        self.assertEqual(self.in_pool(s), set())

    # a reply that is lost, and no completion yet
    def check_lost_reply(self, k, commits):
        s = self.setup({}, drop_but_commit=True)
        s.ledger.no_completion, s.ledger.commit = True, commits
        self.script(tp.A, "sleep 1")
        self.script(tp.B_, "sleep 2")   # the block above it is still on its prover when the reply is lost
        p = self.pipeline(s, k)
        self.fill(s, p, k)
        self.assertIsNone(self.reports[0]["committed"])
        self.assertEqual(len(p.flight), k - 1)
        self.assertEqual(self.numbers(s), [FIRST], "nothing above it is sent while it is in doubt")
        self.step(p)
        self.assertEqual(self.numbers(s), [FIRST])
        if not commits:
            s.ledger.record_time = FAR_FUTURE   # Canton's checkpoints are past the window
        with mock.patch.object(b, "builder_now", lambda: 4102444800.0):   # and the builder's clock agrees with them
            self.drive(p, lambda: any(x.get("resolved") for x in self.reports))
        done = [x for x in self.reports if x.get("resolved")][0]
        if commits:
            self.assertEqual(done["resolved"], "committed")
            self.assertEqual(p.last[0], FIRST)
            self.drive(p, lambda: not p.flight and p.unresolved is None and int(s.ledger.head["headNumber"]) >= FIRST + k - 1)   # every reply is lost here
            self.assertEqual(self.numbers(s)[:k], list(range(FIRST, FIRST + k)))
            self.assertEqual(self.finals(s)[-1], self.canton_head(s))
        else:
            self.assertEqual(done["resolved"], "not committed")
            self.assertEqual(p.flight, [])
            self.assertEqual(self.numbers(s), [FIRST], "the blocks above it were never sent")
            self.assertEqual([(x["attempt"], x["depends_on"]) for x in self.lines(s, "cancelled")], [(i, 1) for i in range(2, k + 1)])
            self.assertEqual(self.in_pool(s), self.hashes(k))
            self.assertEqual((s.reth.head, self.finals(s)[-1]), (HEAD_HASH, HEAD_HASH))
            self.assertEqual(done.get("lostTransactions"), None)

    def test_a_lost_reply_that_committed_at_two(self):
        self.check_lost_reply(2, True)

    def test_a_lost_reply_that_committed_at_three(self):
        self.check_lost_reply(3, True)

    def test_a_lost_reply_that_did_not_commit_at_two(self):
        self.check_lost_reply(2, False)

    def test_a_lost_reply_that_did_not_commit_at_three(self):
        self.check_lost_reply(3, False)

    def test_a_head_that_is_not_the_parent_moves_nothing_when_the_command_did_not_commit(self):
        s, p = self.in_doubt(2)
        s.ledger.land(ok=False)
        s.ledger.late = False
        known = p.flight[0].hash   # a block reth has, and not the parent of the one in doubt
        real = b.Ledger.head
        before = len(s.reth.engine_calls)
        with mock.patch.object(b.Ledger, "head", lambda l: {**real(l), "headHash": known[2:], "headNumber": FIRST + 3}):
            self.step(p)
        self.assertEqual(len(s.reth.engine_calls), before, "reth does not move")
        self.assertIsNotNone(p.unresolved)
        self.assertEqual(len(p.flight), 1)
        self.assertIn("not " + HEAD_HASH[2:], self.status()["headFault"])
        self.step(p)   # the head is what it should be: it settles
        self.assertIsNone(p.unresolved)
        self.assertNotIn("headFault", self.status())


class Restart(Edges):
    """A restart with two blocks recorded: the one in doubt, and the one built on it."""

    def after_restart(self, k=2):
        s, p = self.in_doubt(k)
        first_run = p.journal.run_id
        for h in p.flight:
            self.assertTrue(h.proving is not None)
        later = self.producer(s, max_in_flight=k)   # the new process: nothing is known but the files
        self.assertNotEqual(later.journal.run_id, first_run)
        return s, later, first_run

    def closed(self, s):
        return [(x["attempt"], x.get("attempt_run"), x["outcome"]) for x in self.lines(s, "resolved")]

    def test_it_settles_the_command_first_and_closes_both_attempts_when_it_committed(self):
        s, p, run = self.after_restart()
        s.ledger.land(ok=True)
        s.ledger.late = False
        self.step(p)
        self.assertEqual([(x["resolved"], x["number"]) for x in self.reports if x.get("resolved")], [("committed", FIRST)])
        self.assertEqual(p.last[0], FIRST)
        self.drive(p, lambda: not b.saved_path(s.cfg).exists())
        self.assertEqual(sorted(self.closed(s)), [(1, run, "committed"), (2, run, "restarted")])
        self.assertEqual([x["recovered"] for x in self.reports if "recovered" in x], [1], "the second block's transaction is sent again")
        self.drive(p, lambda: int(s.ledger.head["headNumber"]) >= FIRST + 1)
        self.assertEqual(self.numbers(s), [FIRST, FIRST + 1])
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (self.canton_head(s), self.canton_head(s)), "reth is where Canton is")
        self.assertEqual(self.in_pool(s), set())

    def test_it_closes_both_attempts_and_loses_nothing_when_it_did_not_commit(self):
        s, p, run = self.after_restart()
        s.ledger.land(ok=False)
        s.ledger.late = False
        self.step(p)
        self.assertEqual([(x["resolved"], x["number"]) for x in self.reports if x.get("resolved")], [("not committed", FIRST)])
        self.assertEqual(sorted(self.closed(s)), [(1, run, "not committed"), (2, run, "restarted")])
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (HEAD_HASH, HEAD_HASH))
        self.assertEqual(self.in_pool(s), self.hashes(2))
        self.assertFalse(b.saved_path(s.cfg).exists())
        self.assertFalse(b.unresolved_path(s.cfg).exists())

    def test_it_waits_for_the_command_and_moves_nothing_until_it_can_settle(self):
        s, p, run = self.after_restart()
        before = len(s.reth.engine_calls)
        s.reth.pool[tp.DAVE] = [tx(tp.DAVE, 0)]
        for _ in range(3):
            self.step(p)
        self.assertEqual(len(s.reth.engine_calls), before)
        self.assertEqual(self.numbers(s), [FIRST])
        self.assertTrue(b.saved_path(s.cfg).exists())
        self.assertEqual(self.closed(s), [])


if __name__ == "__main__":
    unittest.main()
