"""The Advance of the oldest block in a thread of its own. While Canton works on it the producer goes on: it cuts, builds and proves the next blocks,
and it does not take the record on disk for a command in doubt. The thread makes HTTP calls and nothing else, and the producer's thread settles the
answer. The fake participant holds an Advance until the test lets it go (`FakeLedger.hold`)."""
import json, os, sys, threading, time, unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_pipeline as tp
from test_pipeline_edges import Edges, FIRST
from fakes import HEAD_HASH, tx

ALICE, BOB, CAROL = tp.ALICE, tp.BOB, tp.CAROL


class Held(Edges):
    """Helpers for a commit that stays in progress until `release`."""

    def hold(self, s):
        s.ledger.hold = threading.Event()
        s.ledger.entered.clear()
        self.addCleanup(s.ledger.hold.set)   # a failing test does not leave a request waiting

    def release(self, s):
        s.ledger.hold.set()

    def until_sending(self, s, p):
        """Steps until the first Advance has reached the participant and waits there."""
        self.drive(p, lambda: s.ledger.entered.is_set() and p.sending is not None)

    def cut_one(self, s, p, sender, n):
        s.reth.pool[sender] = [tx(sender, 0)]
        self.drive(p, lambda: len(self.lines(s, "cut")) == n)

    def proven(self, p, i):
        self.drive(p, lambda: p.flight[i].state in ("proven", "submitting"), limit=30)


class Case16(Held):
    def test_the_producer_steps_while_a_submit_runs_and_the_record_is_not_settled(self):
        s = self.setup({})
        p = self.pipeline(s, 3)   # a slot stays free while the first block commits, so a step does not wait for it
        self.hold(s)
        self.cut_one(s, p, ALICE, 1)
        self.until_sending(s, p)
        self.assertTrue(b.unresolved_path(s.cfg).exists(), "the record is on disk while the command is out")
        self.cut_one(s, p, BOB, 2)   # the next block is cut and sent to a prover during the commit
        for _ in range(5):
            self.step(p)
        self.assertIsNone(p.unresolved, "the record is not taken for a command in doubt")
        self.assertEqual([x for x in self.reports if x.get("resolved")], [], "nothing is settled by its record while its submit runs")
        self.assertEqual(self.committed(), [])
        self.assertEqual(p.status()["submitting"], FIRST)
        self.assertEqual(len(p.flight), 2)
        self.release(s)
        self.drive(p, lambda: len(self.committed()) == 2)
        self.assertEqual(self.committed(), [FIRST, FIRST + 1], "each commit is booked once")
        self.assertEqual(self.numbers(s), [FIRST, FIRST + 1])
        self.assertEqual([x["outcome"] for x in self.lines(s, "answered")], ["committed", "committed"])
        self.assertEqual([x for x in self.reports if x.get("resolved")], [])
        self.assert_final_never_back(s)
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (self.reports[-1]["blockHash"],) * 2)

    def test_a_build_on_the_tip_that_fails_during_a_commit_goes_back_to_its_base(self):
        s = self.setup({})
        p = self.pipeline(s, 2)
        self.hold(s)
        self.cut_one(s, p, ALICE, 1)
        self.until_sending(s, p)
        tip = p.flight[0].hash
        finals = list(self.finals(s))
        real_call = b.Reth.call
        def broken(reth, method, params):
            if method == "debug_getRawBlock":   # the block is reth's head by now: the failure comes after the import
                raise b.BuilderError("reth cannot build")
            return real_call(reth, method, params)
        s.reth.pool[BOB] = [tx(BOB, 0)]
        with mock.patch.object(b.Reth, "call", broken):
            self.step(p)   # the second cut fails while the first block's Advance is out
        self.assertEqual(s.reth.head, tip, "reth went back to the block the failed one was built on, not below it")
        self.assertIn(tx(BOB, 0)["hash"], self.in_pool(s), "the failed block's own transaction is back in the pool")
        self.assertEqual({e["number"] for e in b.saved_file_entries(s.cfg)}, {FIRST}, "the block in flight keeps its copy, and only its own")
        self.assertTrue(b.unresolved_path(s.cfg).exists())
        self.assertIsNone(p.unresolved)
        self.assertEqual([x for x in self.reports if x.get("resolved")], [])
        self.assertEqual(sum("reth cannot build" in json.dumps(r) for r in self.reports), 1, "the failed cut is told once")
        self.assertEqual(self.finals(s)[len(finals):], [x for x in self.finals(s)[len(finals):] if x == HEAD_HASH], "finalized did not move")
        self.release(s)
        self.drive(p, lambda: self.committed() == [FIRST])
        self.assertEqual(self.committed(), [FIRST], "the commit is booked once")
        self.assertEqual([x["outcome"] for x in self.lines(s, "answered") if x["outcome"] == "committed"], ["committed"])
        self.assert_final_never_back(s)
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (self.reports[-1]["blockHash"],) * 2)


class Ordering(Held):
    def test_the_next_block_is_not_submitted_before_the_answer_to_the_one_before(self):
        s = self.setup({})
        p = self.pipeline(s, 3)
        self.hold(s)
        self.cut_one(s, p, ALICE, 1)
        self.until_sending(s, p)
        self.cut_one(s, p, BOB, 2)
        self.proven(p, 1)
        for _ in range(5):
            self.step(p)
        self.assertEqual(p.flight[1].state, "proven", "the next block is proven and waits")
        self.assertEqual(self.numbers(s), [FIRST], "its Advance has not been sent")
        self.release(s)
        self.drive(p, lambda: len(self.committed()) == 2)
        self.assertEqual(self.numbers(s), [FIRST, FIRST + 1])

    def test_the_next_advance_starts_before_the_paid_traffic_of_the_commit_is_read(self):
        s = self.setup({})
        s.ledger.paid = 1234
        p = self.pipeline(s, 3)
        order = []
        real_send, real_paid = b.send_advance, b.Ledger.paid_traffic
        def send(cfg, sub):
            order.append(("send", sub.n))
            return real_send(cfg, sub)
        def paid(ledger, *a, **kw):
            order.append(("paid", None))
            return real_paid(ledger, *a, **kw)
        self.hold(s)
        with mock.patch.object(b, "send_advance", send), mock.patch.object(b.Ledger, "paid_traffic", paid):
            self.cut_one(s, p, ALICE, 1)
            self.until_sending(s, p)
            self.cut_one(s, p, BOB, 2)
            self.proven(p, 1)
            self.release(s)
            self.drive(p, lambda: len(self.committed()) == 2)
        self.assertEqual(order, [("send", FIRST), ("send", FIRST + 1), ("paid", None), ("paid", None)], "the next Advance goes before the first paid read")

    def test_a_proof_that_finishes_during_the_commit_goes_before_the_paid_traffic(self):
        for k in (2, 3):
            with self.subTest(k=k):
                s = self.setup({})
                s.ledger.paid = 1234
                p = self.pipeline(s, k, provers=1)
                order = []
                real_send, real_paid = b.send_advance, b.Ledger.paid_traffic
                def send(cfg, sub):
                    order.append(("send", sub.n))
                    return real_send(cfg, sub)
                def paid(ledger, *a, **kw):
                    order.append(("paid", None))
                    return real_paid(ledger, *a, **kw)
                self.hold(s)
                with mock.patch.object(b, "send_advance", send), mock.patch.object(b.Ledger, "paid_traffic", paid):
                    self.cut_one(s, p, ALICE, 1)
                    self.until_sending(s, p)
                    os.environ["FAKE_PROVER_SLEEP"] = "1.5"   # the next block's proof takes a while, and no step looks at it meanwhile
                    self.addCleanup(os.environ.pop, "FAKE_PROVER_SLEEP", None)
                    def release_when_proved():
                        end = time.monotonic() + 20
                        while time.monotonic() < end and not (len(p.flight) > 1 and p.flight[1].proving is not None):
                            time.sleep(0.01)
                        p.flight[1].proving.ticket.done.wait(20)   # no step has collected it: the block is still `proving` when the commit is let go
                        self.release(s)
                    releaser = threading.Thread(target=release_when_proved, daemon=True)
                    releaser.start()
                    s.reth.pool[BOB] = [tx(BOB, 0)]
                    self.drive(p, lambda: len(self.committed()) == 2)
                    releaser.join(5)
                self.assertEqual(order[:3], [("send", FIRST), ("send", FIRST + 1), ("paid", None)], f"the next Advance goes before the paid read: {order}")

    def test_a_kill_during_the_late_paid_traffic_read_leaves_the_commit_closed(self):
        s = self.setup({})
        s.ledger.paid = 1234
        p = self.pipeline(s, 3)
        def killed(ledger, *a, **kw):
            raise KeyboardInterrupt   # the process dies in the read, after the next block's record has replaced the first one's
        self.hold(s)
        with mock.patch.object(b.Ledger, "paid_traffic", killed):
            self.cut_one(s, p, ALICE, 1)
            self.until_sending(s, p)
            self.cut_one(s, p, BOB, 2)
            self.proven(p, 1)
            self.release(s)
            with self.assertRaises(KeyboardInterrupt):
                self.drive(p, lambda: False)
        self.assertEqual(self.numbers(s), [FIRST, FIRST + 1], "the next Advance went out before the read")
        mine = [x["event"] for x in self.lines_in_order(s) if x.get("attempt") == 1]
        self.assertEqual(mine[-2:], ["answered", "final_seen"], f"the first attempt has its last line: {mine}")
        self.assertEqual([x["outcome"] for x in self.lines(s, "answered") if x["attempt"] == 1], ["committed"])
        again = self.pipeline(s, 3)   # a restart: the record on disk is the second block's, and only that one is settled
        self.drive(again, lambda: not b.unresolved_path(s.cfg).exists())
        mine = [x["event"] for x in self.lines_in_order(s) if x.get("attempt") == 1]
        self.assertEqual(mine.count("answered"), 1)
        self.assertNotIn("resolved", mine)

    def test_a_refusal_at_the_oldest_with_the_next_proven_sends_nothing_more(self):
        s = self.setup({})
        p = self.pipeline(s, 3)
        self.hold(s)
        self.cut_one(s, p, ALICE, 1)
        self.until_sending(s, p)
        self.cut_one(s, p, BOB, 2)
        self.proven(p, 1)
        s.ledger.refuse = "the sidecar refused the proof"
        self.release(s)
        self.drive(p, lambda: any(r.get("committed") is False for r in self.reports))
        self.assertEqual(self.numbers(s), [FIRST], "the next block was never submitted")
        self.assertEqual([(x["attempt"], x["depends_on"]) for x in self.lines(s, "cancelled")], [(2, 1)])
        self.assertEqual(p.flight, [])
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (HEAD_HASH, HEAD_HASH))
        self.assertEqual(self.in_pool(s), {tx(ALICE, 0)["hash"], tx(BOB, 0)["hash"]})
        self.assert_final_never_back(s)

    def test_an_unknown_answer_at_the_oldest_with_the_next_proven_sends_nothing_until_it_is_settled(self):
        s = self.setup({})
        s.ledger.late = True   # the Advance times out; the command commits only when the test says
        s.ledger.no_completion = True
        self.script(tp.A, "sleep 2")   # the first block's proof is the slow one: the second is proven before its Advance goes
        p = self.pipeline(s, 3)
        self.cut_one(s, p, ALICE, 1)
        self.cut_one(s, p, BOB, 2)
        self.proven(p, 1)
        self.drive(p, lambda: p.unresolved is not None)
        for _ in range(5):
            self.step(p)
        self.assertEqual(self.numbers(s), [FIRST], "the next block waits while the command is in doubt")
        self.assertEqual(len(self.lines(s, "cut")), 2, "and nothing is cut")
        self.assertIsNone(p.sending)
        s.ledger.land(ok=True)
        s.ledger.late = False
        s.ledger.no_completion = False
        self.drive(p, lambda: len(self.committed()) >= 1 and len(self.numbers(s)) == 2)
        self.assertEqual(self.numbers(s), [FIRST, FIRST + 1])
        self.drive(p, lambda: not p.flight)
        self.assertEqual(self.lines(s, "cancelled"), [])
        self.assertEqual(s.reth.head, self.canton_head(s))


class Thread(Held):
    def test_the_thread_makes_http_calls_and_nothing_else(self):
        """No call to reth, no journal line and no file write comes from the Advance's thread."""
        s = self.setup({})
        p = self.pipeline(s, 2)
        seen = []
        def watch(owner, name):
            real = getattr(owner, name)
            def wrapped(*a, **kw):
                if threading.current_thread().name.startswith("advance-"):
                    seen.append(name)
                return real(*a, **kw)
            return mock.patch.object(owner, name, wrapped)
        patches = [watch(b.Reth, "call"), watch(b.Reth, "forkchoice"), watch(b.Journal, "event"), watch(b, "save_unresolved"), watch(b, "clear_unresolved"),
                   watch(b, "clear_saved"), watch(b, "save_kept")]
        for x in patches:
            x.start()
            self.addCleanup(x.stop)
        names = []
        real_send = b.send_advance
        def send(cfg, sub):
            names.append(threading.current_thread().name)
            return real_send(cfg, sub)
        with mock.patch.object(b, "send_advance", send):
            self.cut_one(s, p, ALICE, 1)
            self.cut_one(s, p, BOB, 2)
            self.drive(p, lambda: len(self.committed()) == 2)
        self.assertEqual(seen, [])
        self.assertEqual(names, [f"advance-{FIRST}", f"advance-{FIRST + 1}"])
        self.assertNotIn(threading.current_thread().name, names)

    def test_a_stop_during_a_submit_waits_for_the_answer_and_books_it(self):
        s = self.setup({})
        p = self.pipeline(s, 2)
        self.hold(s)
        run = threading.Thread(target=p.run, daemon=True)
        run.start()
        s.reth.pool[ALICE] = [tx(ALICE, 0)]
        self.assertTrue(s.ledger.entered.wait(30), "the Advance reached the participant")
        self.stop.set()
        time.sleep(0.3)
        self.assertTrue(run.is_alive(), "the run does not end while the Advance is out")
        self.release(s)
        run.join(30)
        self.assertFalse(run.is_alive())
        self.assertEqual(self.committed(), [FIRST], "the answer is booked once")
        self.assertFalse(b.unresolved_path(s.cfg).exists())
        self.assertFalse(b.saved_path(s.cfg).exists(), "nothing is left kept")
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (self.reports[-1]["blockHash"],) * 2)
        self.assertEqual(self.status()["state"], "stopped")

    def test_a_stop_after_an_answer_that_cannot_be_booked_leaves_the_record_for_the_next_start(self):
        s = self.setup({})
        p = self.pipeline(s, 2)
        self.hold(s)
        run = threading.Thread(target=p.run, daemon=True)
        run.start()
        s.reth.pool[ALICE] = [tx(ALICE, 0)]
        self.assertTrue(s.ledger.entered.wait(30))
        self.stop.set()
        real = b.settle_reply
        def broken(*a, **kw):
            raise b.BuilderError("reth is down")
        with mock.patch.object(b, "settle_reply", broken):
            self.release(s)
            run.join(30)
        self.assertFalse(run.is_alive())
        self.assertTrue(b.unresolved_path(s.cfg).exists(), "the record stays")
        self.assertTrue(b.saved_path(s.cfg).exists(), "and so do the transactions")
        later = self.producer(s, max_in_flight=2)
        self.step(later)
        self.assertEqual([x["resolved"] for x in self.reports if x.get("resolved")], ["committed"], "the next start settles it by its command id")
        self.assertEqual(self.numbers(s), [FIRST], "and it is not sent again")


if __name__ == "__main__":
    unittest.main()
