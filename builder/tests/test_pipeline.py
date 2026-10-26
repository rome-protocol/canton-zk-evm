"""The producer that keeps several blocks in flight, built directly at two and three blocks (`run` still refuses more than one), against the
same fakes as the others. The stand-in prover's answers are set per job (fake-prove.sh, FAKE_PROVER_PLAN), so a block's proof can come
back before an earlier block's. Cases: proofs out of order, Canton's head not the parent at submit, and the gateway's proofs read while a block is the tip."""
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
    """Case 7: a proof that comes back before an earlier block's is held until its block is the oldest."""

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
    """Case 11: Canton's head is not the parent of the block to submit."""

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
    """Case 13: the gateway's proofs are read while the block is the tip. The fake reth, like the real one, answers eth_getProof only for the
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


if __name__ == "__main__":
    unittest.main()
