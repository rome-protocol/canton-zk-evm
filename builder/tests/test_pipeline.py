"""The producer that keeps several blocks in flight, built directly at two and three blocks (`run` still refuses more than one), against the
same fakes as the others. The stand-in prover's answers are set per job (fake-prove.sh, FAKE_PROVER_PLAN), so a block's proof can come
back before an earlier block's. Covers proofs out of order, failures, Canton's head not the parent at submit, and the gateway's proofs read while a block is the tip."""
import json, os, re, sys, tempfile, threading, time, unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import provers as pv
import test_builder as tb
from test_producer import Loop
from fakes import HEAD_HASH, HEAD_NUMBER, tx

ALICE, BOB, CAROL = tb.ALICE, tb.BOB, tb.CAROL
A, B_ = "http://127.0.0.1:7001", "http://127.0.0.1:7002"


def tag(url: str) -> str:
    return re.sub(r"[^a-z0-9]", "_", url)


class Depth(Loop):
    engine = b.Pipeline

    def setUp(self):
        self.plan = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.plan, ignore_errors=True))
        for k, v in {"FAKE_PROVER_PLAN": str(self.plan), "FAKE_LOG": str(self.plan / "fake.log")}.items():
            os.environ[k] = v
            self.addCleanup(os.environ.pop, k, None)

    def script(self, url, *lines):
        (self.plan / tag(url)).write_text("".join(f"{x}\n" for x in lines))

    def pipeline(self, s, k, provers=2, timeout=60):
        """A producer at `k` blocks in flight on `provers` stand-in provers."""
        specs = [f"{n}={u}" for n, u in zip("ab", (A, B_))][:provers]
        s.cfg.pool = b.new_pool(pv.parse_provers(specs, "fake-prove.sh"), timeout) if provers > 1 else None
        return self.producer(s, max_in_flight=k)

    def drive(self, p, until, limit=40):
        """Steps the loop, each step bounded, until `until()` holds."""
        end = time.monotonic() + limit
        while not until():
            self.assertLess(time.monotonic(), end, "the loop did not get there in time")
            self.step(p)
            time.sleep(0.01)

    def step(self, p, wait=30):
        err = []
        def run():
            try:
                p.step()
            except BaseException as e:   # handed back to the test thread
                err.append(e)
        th = threading.Thread(target=run, daemon=True)
        th.start()
        th.join(timeout=wait)
        self.assertFalse(th.is_alive(), f"a step of the loop did not end in {wait} s")
        if err:
            raise err[0]

    def numbers(self, s):
        """The block numbers of the Advances sent to Canton, in order."""
        return [int(re.match(r"ostia-\d+-(\d+)-", x["commandId"]).group(1)) for x in s.ledger.submitted]

    def committed(self):
        return [r["number"] for r in self.reports if r.get("committed")]

    def lines(self, s, kind):
        folder = Path(s.cfg.work_dir) / "journal"
        found = [json.loads(x) for f in sorted(folder.glob("*.jsonl")) for x in f.read_text().splitlines()]
        return [x for x in found if x.get("event") == kind or x.get("kind") == kind]

    def lines_in_order(self, s):
        folder = Path(s.cfg.work_dir) / "journal"
        return [json.loads(x) for f in sorted(folder.glob("*.jsonl")) for x in f.read_text().splitlines()]

    def assert_final_never_back(self, s):
        """reth's finalized block only moves up the chain of committed blocks: Canton's head first, then each block as it committed."""
        order = [HEAD_HASH] + [r["blockHash"] for r in self.reports if r.get("committed")]
        at = [order.index(h) for h in self.finals(s)]
        self.assertEqual(at, sorted(at))

    def finals(self, s):
        """The finalized block of every move of reth's head, in order."""
        return [p[0]["finalizedBlockHash"] for m, p in s.reth.engine_calls if m == "engine_forkchoiceUpdatedV3"]

    def fill(self, s, p, k, senders=(ALICE, BOB, CAROL)):
        """Cuts `k` blocks one after the other, each from a transaction that arrives after the one before was cut. The cut that makes the
        loop full waits in its step for the oldest block, which commits first."""
        for i in range(k):
            s.reth.pool[senders[i]] = [tx(senders[i], 0)]
            self.drive(p, lambda: len(self.lines(s, "cut")) == i + 1)
        self.assertEqual([x["in_flight_at_cut"] for x in self.lines(s, "cut")], list(range(k)))


class OutOfOrder(Depth):
    """a proof that comes back before an earlier block's is held until its block is the oldest."""

    def run_case(self, k):
        s = self.setup({})
        self.script(A, "sleep 2")   # the first block's proof is the slow one; the next ones go to the other prover
        p = self.pipeline(s, k)
        self.fill(s, p, k)
        self.drive(p, lambda: len(self.committed()) == k)
        n0 = HEAD_NUMBER + 1
        self.assertEqual(self.numbers(s), [n0 + i for i in range(k)])   # sent in block order
        self.assertEqual(self.committed(), [n0 + i for i in range(k)])
        took = {r["number"]: r["proveSeconds"] for r in self.reports if r.get("committed")}
        self.assertTrue(all(took[n0 + i] < took[n0] for i in range(1, k)), f"the first block's proof was the slowest: {took}")
        # the next block's Advance is sent only after the answer to the one before
        events = [(x["event"], x["attempt"]) for x in self.lines_in_order(s) if x["event"] in ("submitted", "answered")]
        self.assertEqual(events, [(e, i + 1) for i in range(k) for e in ("submitted", "answered")])
        self.assertEqual(self.refused(s), 0)
        self.assert_final_never_back(s)
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (self.reports[-1]["blockHash"],) * 2)   # final is the newest, and so is the head
        self.assertEqual(p.last[0], n0 + k - 1)
        self.assertEqual(p.flight, [])

    def refused(self, s):
        return len([x for x in self.lines(s, "answered") if x.get("outcome") != "committed"])

    def test_at_two(self):
        self.run_case(2)

    def test_at_three(self):
        self.run_case(3)

    def test_a_proof_of_another_block_is_never_used(self):
        s = self.setup({})
        self.script(A, "sleep 1", "wrong")
        self.script(B_, "wrong")   # the second block's proof commits to a block that is not it, on both provers; the first goes on and commits
        p = self.pipeline(s, 2)
        self.fill(s, p, 2)
        self.drive(p, lambda: not p.flight)
        self.assertEqual(self.numbers(s), [HEAD_NUMBER + 1])   # the second block was never sent, with that proof or any other
        self.assertEqual(self.committed(), [HEAD_NUMBER + 1])
        self.assertIn("not this block", json.dumps(self.reports[-1]))


class HeadCheck(Depth):
    """Canton's head is not the parent of the block to submit."""

    def two_blocks(self, k):
        """k blocks in flight: the first is slow, so the others are proven and wait. Returns the setup, the producer and the head as the first block's cut read it."""
        s = self.setup({})
        self.script(A, "sleep 1")
        p = self.pipeline(s, k)
        self.stale = {}
        real = b.Ledger.head
        calls = []
        def head(ledger):
            found = real(ledger)
            calls.append(found)
            return self.stale["make"](calls[0]) if len(calls) > 1 and "make" in self.stale else found
        patch = mock.patch.object(b.Ledger, "head", head)
        patch.start()
        self.addCleanup(patch.stop)
        self.calls = calls
        return s, p

    def check_lagging(self, k):
        s, p = self.two_blocks(k)
        self.stale["make"] = dict   # Canton's head as it was before the first block: a read that lags its commit
        self.fill(s, p, k)
        self.assertEqual(self.committed(), [HEAD_NUMBER + 1])
        sent, fcs, builds = len(s.ledger.submitted), len(s.reth.engine_calls), len(self.built(s))
        self.step(p)   # the second block is proven and next: its parent is not the head that was read
        self.assertEqual(len(s.ledger.submitted), sent, "nothing is sent while the head is not the block's parent")
        self.assertEqual(len(s.reth.engine_calls), fcs, "reth does not move")
        self.assertIn("not block", self.status()["headFault"])
        self.assertIn("not block", self.status()["lastError"]["error"])
        self.assertEqual(self.status()["blocksRefused"], 0)
        self.assertFalse(p.suspects)
        s.reth.pool[CAROL] = [tx(CAROL, 0)]
        self.step(p)   # and nothing is cut meanwhile
        self.assertEqual((len(s.reth.engine_calls), len(self.built(s))), (fcs, builds))
        self.stale.clear()   # the read catches up: the block goes, and the fault is gone
        self.drive(p, lambda: len(self.committed()) >= 2)
        self.assertEqual(self.numbers(s)[:2], [HEAD_NUMBER + 1, HEAD_NUMBER + 2])
        self.assertNotIn("headFault", self.status())
        self.assert_final_never_back(s)
        self.assertEqual(self.refused_count(s), 0)

    def refused_count(self, s):
        return len([x for x in self.lines(s, "answered") if x.get("outcome") != "committed"])

    def test_a_head_that_lags_at_two(self):
        self.check_lagging(2)

    def test_a_head_that_lags_at_three(self):
        self.check_lagging(3)

    def check_foreign(self, k):
        s, p = self.two_blocks(k)
        self.stale["make"] = lambda first: {**first, "headHash": "cd" * 32, "headNumber": HEAD_NUMBER + 1}   # a block reth does not have
        self.fill(s, p, k)
        sent, fcs = len(s.ledger.submitted), len(s.reth.engine_calls)
        self.step(p)
        self.assertEqual((len(s.ledger.submitted), len(s.reth.engine_calls)), (sent, fcs))
        self.assertTrue(p.stop.is_set())   # the producer ends
        self.assertIn("does not have", p.fatal)
        self.assertEqual(self.status()["blocksRefused"], 0)

    def test_a_head_reth_does_not_have_stops_the_producer_at_two(self):
        self.check_foreign(2)

    def test_a_head_reth_does_not_have_stops_the_producer_at_three(self):
        self.check_foreign(3)


class GatewayProofs(Depth):
    """the gateway's proofs are read while the block is the tip. The fake reth, like the real one, answers eth_getProof only for the
    newest block and its parent, so a block read after another was built on it would fail."""

    def check(self, k):
        s = self.setup({})
        self.script(A, "sleep 2")
        p = self.pipeline(s, k)
        self.fill(s, p, k)
        self.drive(p, lambda: len(self.committed()) == k)
        n0 = HEAD_NUMBER + 1
        self.assertEqual(self.committed(), [n0 + i for i in range(k)])
        reads = [int(q[2], 16) for m, q in s.reth.ws_calls if m == "eth_getProof"]
        self.assertEqual(sorted(set(reads)), [n0 + i for i in range(k)])
        # each block's proofs were read before the next block was built
        steps = [("build", None) if m == "testing_buildBlockV1" else ("proof", int(q[2], 16)) for m, q in s.reth.ws_calls if m in ("testing_buildBlockV1", "eth_getProof")]
        built = 0
        for kind, number in steps:
            if kind == "build":
                built += 1
            else:
                self.assertEqual(number, n0 + built - 1, "a proof was read after the next block was built")

    def test_at_two(self):
        self.check(2)

    def test_at_three(self):
        self.check(3)


class Failures(Depth):
    """An oldest block that is refused or fails cancels the blocks built on it, one unwind takes reth back to the last block
    Canton committed, and an unwind that cannot finish is finished by the next step before anything else is done."""

    SENDERS = (ALICE, BOB, CAROL)

    def hashes(self, k, first=0):
        return {tx(x, 0)["hash"] for x in self.SENDERS[first:k]}

    def in_pool(self, s):
        return {t["hash"] for ts in s.reth.pool.values() for t in ts}

    def failing(self, numbers):
        """The proof of each block with one of these numbers fails, after the prover returned it."""
        real = b.finish_proof
        def finish(cfg, built, running, attempt=None):
            proven = real(cfg, built, running, attempt)
            if built.n in numbers:
                raise b.ProvingError("the prover is down", running.kept)
            return proven
        patch = mock.patch.object(b, "finish_proof", finish)
        patch.start()
        self.addCleanup(patch.stop)

    def lone(self, s):
        """How many times reth's head, safe and finalized block were set to one and the same block that is not Canton's head at the start."""
        return [p[0]["headBlockHash"] for m, p in s.reth.engine_calls
                if m == "engine_forkchoiceUpdated" + "V3" and p[0]["headBlockHash"] == p[0]["safeBlockHash"] == p[0]["finalizedBlockHash"]]

    def cancelled(self, s, k, culprit=1):
        found = self.lines(s, "cancelled")
        self.assertEqual([(x["attempt"], x["depends_on"]) for x in found], [(i, culprit) for i in range(culprit + 1, k + 1)])

    # a refused block
    def check_refused(self, k):
        s = self.setup({}, refuse="the sidecar refused the proof")
        self.script(A, "sleep 1")   # the first block is slow: the others are proven when it is answered
        p = self.pipeline(s, k)
        self.fill(s, p, k)
        n0 = HEAD_NUMBER + 1
        self.assertEqual(self.numbers(s), [n0], "only the oldest block is ever sent")
        self.assertEqual(self.committed(), [])
        self.cancelled(s, k)
        self.assertEqual(p.flight, [])
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (HEAD_HASH, HEAD_HASH))
        self.assertEqual(self.in_pool(s), self.hashes(k))   # every transaction is back in the pool
        self.assertEqual(p.suspects, [])
        self.assertFalse(p.unwind_pending)
        self.assertEqual(self.lines(s, "cancelled")[0]["reason"], "an earlier block did not commit")
        s.ledger.refuse = None
        self.drive(p, lambda: self.committed())
        self.assertEqual(self.committed()[0], n0)   # the next block is at the height of the refused one

    def test_a_refused_block_cancels_the_ones_built_on_it_at_two(self):
        self.check_refused(2)

    def test_a_refused_block_cancels_the_ones_built_on_it_at_three(self):
        self.check_refused(3)

    # a block whose proof fails
    def check_oldest_fails(self, k):
        s = self.setup({})
        self.script(A, "sleep 1")
        self.failing({HEAD_NUMBER + 1})
        p = self.pipeline(s, k)
        self.fill(s, p, k)
        self.assertEqual(self.numbers(s), [], "nothing is sent for a block whose proof failed")
        self.cancelled(s, k)
        self.assertEqual(p.flight, [])
        self.assertEqual(self.lone(s), [HEAD_HASH, HEAD_HASH], "one move to the start, one unwind")
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (HEAD_HASH, HEAD_HASH))
        self.assertEqual(self.in_pool(s), self.hashes(k))
        self.assertEqual(p.suspects, [])
        self.assertFalse(p.unwind_pending)

    def test_the_oldest_block_failing_at_two(self):
        self.check_oldest_fails(2)

    def test_the_oldest_block_failing_at_three(self):
        self.check_oldest_fails(3)

    def check_newest_fails(self, k):
        """The newest block fails first: the ones before it commit, and it is unwound when it is the oldest."""
        s = self.setup({})
        self.script(A, "sleep 1")
        self.failing({HEAD_NUMBER + k})
        p = self.pipeline(s, k)
        self.fill(s, p, k)
        n0 = HEAD_NUMBER + 1
        if k == 2:   # filling the loop waited for the first block, which committed; the failed one is next
            self.assertEqual(self.committed(), [n0])
        self.assertEqual(self.lone(s), [HEAD_HASH], "nothing is unwound while a block before the failed one is in flight")
        self.drive(p, lambda: p.last[0] == HEAD_NUMBER + k - 1 and not p.flight)
        self.assertEqual(self.committed(), [n0 + i for i in range(k - 1)])
        self.assertEqual(self.numbers(s), [n0 + i for i in range(k - 1)])
        last = self.reports and [r["blockHash"] for r in self.reports if r.get("committed")][-1]
        self.assertEqual(self.lone(s), [HEAD_HASH, last], "one unwind, to the last block that committed")
        self.assertEqual(self.cancelled_blocks(s), [])   # the failed block was the newest: it cancels none
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (last, last))
        self.assertEqual(self.in_pool(s), self.hashes(k, k - 1))   # only the failed block's transaction is back
        self.assert_final_never_back(s)

    def cancelled_blocks(self, s):
        return self.lines(s, "cancelled")

    def test_the_newest_block_failing_at_two(self):
        self.check_newest_fails(2)

    def test_the_newest_block_failing_at_three(self):
        self.check_newest_fails(3)

    # an unwind that cannot finish
    def unwind_that_cannot_finish(self, k, how):
        s = self.setup({})
        self.script(A, "sleep 1")
        self.failing({HEAD_NUMBER + 1})
        if how == "forkchoice":
            s.reth.no_state_for_genesis = True   # reth cannot move back to the start
        else:
            s.reth.crash_on_send = True   # the first transaction sent again breaks the connection
        p = self.pipeline(s, k)
        self.fill(s, p, k)
        self.assertTrue(p.unwind_pending)
        self.assertEqual(self.in_pool(s), set(), "nothing was sent again")
        self.assertTrue(b.saved_path(s.cfg).exists(), "the kept copy is not cleared")
        cuts, sends, held = len(self.lines(s, "cut")), len(s.ledger.submitted), s.reth.head
        if how == "forkchoice":   # the next step tries again and fails again: nothing else happens
            s.reth.pool[CAROL] = [tx(CAROL, 5)]
            self.step(p)
            self.assertTrue(p.unwind_pending)
            self.assertEqual((len(self.lines(s, "cut")), len(s.ledger.submitted), s.reth.head), (cuts, sends, held))
            self.assertTrue(b.saved_path(s.cfg).exists())
            s.reth.pool.clear()
            s.reth.no_state_for_genesis = False
        self.step(p)   # reth goes to the last block that committed, and the transactions are sent again
        self.assertFalse(p.unwind_pending)
        self.assertEqual((len(self.lines(s, "cut")), len(s.ledger.submitted)), (cuts, sends), "that step cut and sent nothing")
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (HEAD_HASH, HEAD_HASH))
        self.assertEqual(self.in_pool(s), self.hashes(k))
        self.assertFalse(b.saved_path(s.cfg).exists())
        self.assertEqual([r for r in self.reports if r.get("lostTransactions")], [])
        self.assertEqual(self.status()["blocksRefused"], 0)

    def test_a_forkchoice_that_fails_in_the_unwind_at_two(self):
        self.unwind_that_cannot_finish(2, "forkchoice")

    def test_a_forkchoice_that_fails_in_the_unwind_at_three(self):
        self.unwind_that_cannot_finish(3, "forkchoice")

    def test_a_resend_that_raises_in_the_unwind_at_two(self):
        self.unwind_that_cannot_finish(2, "resend")

    def test_a_resend_that_raises_in_the_unwind_at_three(self):
        self.unwind_that_cannot_finish(3, "resend")

    def test_a_head_that_is_not_the_last_block_stops_the_unwind(self):
        s = self.setup({})
        self.script(A, "sleep 1")
        self.failing({HEAD_NUMBER + 1})
        s.reth.no_state_for_genesis = True
        p = self.pipeline(s, 2)
        self.fill(s, p, 2)
        self.assertTrue(p.unwind_pending)
        real = b.Ledger.head
        with mock.patch.object(b.Ledger, "head", lambda l: {**real(l), "headHash": "cd" * 32, "headNumber": HEAD_NUMBER + 1}):
            s.reth.no_state_for_genesis = False
            fcs = len(s.reth.engine_calls)
            self.step(p)
        self.assertTrue(p.unwind_pending)
        self.assertEqual(len(s.reth.engine_calls), fcs, "reth does not move")
        self.assertIn("not block", self.status()["headFault"])

    def check_refused_and_stuck(self, k):
        s = self.setup({}, refuse="the sidecar refused the proof")
        self.script(A, "sleep 1")
        s.reth.no_state_for_genesis = True
        p = self.pipeline(s, k)
        self.fill(s, p, k)
        self.assertTrue(p.unwind_pending)
        self.assertEqual(self.numbers(s), [HEAD_NUMBER + 1])
        self.cancelled(s, k)
        self.assertTrue(b.saved_path(s.cfg).exists())
        self.assertIn("no state found", self.reports[-1]["rewindError"])
        s.reth.no_state_for_genesis = False
        self.step(p)
        self.assertFalse(p.unwind_pending)
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (HEAD_HASH, HEAD_HASH))
        self.assertEqual(self.in_pool(s), self.hashes(k))
        self.assertFalse(b.saved_path(s.cfg).exists())

    def test_a_refusal_whose_move_back_fails_is_finished_by_the_next_step_at_two(self):
        self.check_refused_and_stuck(2)

    def test_a_refusal_whose_move_back_fails_is_finished_by_the_next_step_at_three(self):
        self.check_refused_and_stuck(3)


class InputToolFails(Depth):
    """A block whose input tool fails once is a failure of the service: one report, no transaction held back, and the retry commits it."""

    def run_case(self, engine, k):
        self.engine = engine
        s = self.setup({})
        p = self.pipeline(s, k)
        t = tx(ALICE, 0)
        s.reth.pool[ALICE] = [t]
        os.environ["FAKE_INPUT_FAILS_FOR"] = t["hash"][2:]
        self.addCleanup(os.environ.pop, "FAKE_INPUT_FAILS_FOR", None)
        self.step(p)
        failed, self.failures_after = list(self.reports), p.failures
        del os.environ["FAKE_INPUT_FAILS_FOR"]
        self.drive(p, lambda: self.committed())
        events = [x["event"] for x in self.lines_in_order(s) if "event" in x]
        return s, p, failed, events, t

    def check(self, k):
        s, p, failed, events, t = self.run_case(b.Pipeline, k)
        self.assertEqual([r["committed"] for r in failed], [False], "one failure report")
        self.assertEqual(events.count("excluded"), 0)
        self.assertEqual(p.excluded, {})
        self.assertFalse(p.hunt)
        self.assertEqual(self.failures_after, 1)
        self.assertEqual(self.committed(), [HEAD_NUMBER + 1])
        self.assertEqual(self.reports[-1]["transactions"], [t["hash"]])
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (self.reports[-1]["blockHash"],) * 2)
        return events

    def test_at_one_it_is_what_the_single_block_producer_does(self):
        mine = self.check(1)
        _, _, failed, events, _ = self.run_case(b.Producer, 1)
        self.assertEqual([r["committed"] for r in failed], [False])
        self.assertEqual([e for e in mine if e not in ("cancelled",)], events)

    def test_at_two(self):
        self.check(2)

    def test_at_three(self):
        self.check(3)


if __name__ == "__main__":
    unittest.main()
