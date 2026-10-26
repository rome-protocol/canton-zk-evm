"""The producer that keeps several blocks in flight, where a block has to be made with nothing in flight: a leg that waits for the blocks before it
(it has its Canton side, and the block is built on a block in flight), the heartbeat, the retries after a refusal, and a leg that has no Canton side
at all (no drain). Built directly at two and three blocks."""
import sys, threading, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
import test_pipeline as tp
import test_pipeline_edges as te
from fakes import HEAD_HASH, HEAD_NUMBER, tx

ALICE, BOB, CAROL = tb.ALICE, tb.BOB, tb.CAROL
FIRST = HEAD_NUMBER + 1


class Modes(te.Edges):
    def kept(self, s):
        return sorted((x["number"], x["hash"]) for x in b.read_saved_entries(s.cfg) or [])

    def in_pool(self, s):
        return {t["hash"] for ts in s.reth.pool.values() for t in ts}

    def cuts(self, s):
        return self.lines(s, "cut")

    def first_in_flight(self, s, k):
        """Block N is cut from ALICE's transaction, and its proof is slow."""
        self.script(tp.A, "sleep 3")
        p = self.pipeline(s, k)
        s.reth.pool[ALICE] = [tx(ALICE, 0)]
        self.drive(p, lambda: len(p.flight) == 1)
        return p


class Legs(Modes):
    """A leg that matches on Canton's head waits for the blocks in flight; a leg that has no Canton side does not make the producer drain."""

    def waiting_leg(self, k):
        s = self.setup({}, terms=[tb.TERMS])
        p = self.first_in_flight(s, k)
        leg = tx(BOB, 0)
        s.reth.tx_legs[leg["hash"]] = [tb.PAY]
        s.reth.pool[BOB] = [leg]
        return s, p, leg

    def check_waits_then_goes_in_on_the_head(self, k):
        s, p, leg = self.waiting_leg(k)
        n = p.flight[0].number
        kept = self.kept(s)
        self.assertEqual([x for x, _ in kept], [n])
        self.drive(p, lambda: any(x.get("skipped") for x in self.reports))
        left = [x for x in self.reports if x.get("skipped")][0]["leftOut"]
        self.assertEqual(left, [{"transaction": leg["hash"], "reason": b.LEG_WAITS}])
        self.assertTrue(p.leg_wait)
        self.assertEqual(self.kept(s), kept, "the empty rebuild on the tip takes none of N's entries")
        self.assertEqual(s.reth.head, p.flight[-1].hash, "reth is back on the tip")
        self.assertEqual(self.in_pool(s), {leg["hash"]}, "only the leg is back in the pool")
        cuts, built = len(self.cuts(s)), len(self.blocks_built(s))
        for _ in range(3):   # nothing is cut while a block is in flight: the leg waits
            self.step(p)
        self.assertEqual((len(self.cuts(s)), len(self.blocks_built(s))), (cuts, built))
        self.drive(p, lambda: any(x.get("legTransactions") == [leg["hash"]] for x in self.reports))
        carrying = [x for x in self.reports if x.get("legTransactions") == [leg["hash"]]][0]
        self.assertTrue(carrying["committed"])
        self.assertEqual(self.cuts(s)[-1]["in_flight_at_cut"], 0, "the leg went in on a block cut with nothing in flight")
        self.assertEqual(carrying["number"], n + 1)
        self.assertEqual(self.numbers(s), [n, n + 1])
        self.assertFalse(p.leg_wait)
        self.assertEqual(self.in_pool(s), set())

    def test_a_leg_waits_for_the_block_in_flight_at_two(self):
        self.check_waits_then_goes_in_on_the_head(2)

    def test_a_leg_waits_for_the_block_in_flight_at_three(self):
        self.check_waits_then_goes_in_on_the_head(3)

    def test_a_restart_right_after_recovers_the_block_in_flights_transactions(self):
        s, p, leg = self.waiting_leg(2)
        self.drive(p, lambda: any(x.get("skipped") for x in self.reports))
        later = self.producer(s, max_in_flight=2)   # the process was stopped: nothing is known but the files
        self.step(later)
        self.assertEqual([x["recovered"] for x in self.reports if "recovered" in x], [1])
        self.assertEqual(s.reth.head, later.flight[-1].hash, "the block is cut again on Canton's head, with the leg in it")
        self.assertEqual({t["hash"] for t in later.flight[0].built.chosen}, {tx(ALICE, 0)["hash"], leg["hash"]})
        self.drive(later, lambda: any(x.get("legTransactions") == [leg["hash"]] for x in self.reports))
        self.assertEqual(self.in_pool(s), set())

    def test_a_leg_with_no_canton_side_is_left_out_with_its_own_reason_and_nothing_drains(self):
        s = self.setup({})   # no terms: the leg has no Canton side even on Canton's head
        p = self.first_in_flight(s, 2)
        bogus = tx(BOB, 0)
        s.reth.tx_legs[bogus["hash"]] = [tb.PAY]
        s.reth.pool[BOB] = [bogus]
        s.reth.pool[CAROL] = [tx(CAROL, 0)]
        cuts = len(self.cuts(s))
        self.drive(p, lambda: len(self.cuts(s)) == cuts + 1)
        self.assertFalse(p.leg_wait)
        self.assertEqual(len(p.flight) + len(self.committed()), 2, "the block went in flight on the tip, carrying the other transaction")
        self.assertEqual(self.cuts(s)[-1]["in_flight_at_cut"], 1)
        reasons = [x["reason"] for r in self.reports for x in r.get("leftOut", [])] + [x["reason"] for h in p.flight for x in h.built.left_out]
        self.assertTrue(reasons and all("has no Canton side" in x and x != b.LEG_WAITS for x in reasons), reasons)
        self.assertIn(bogus["hash"], self.in_pool(s))
        self.drive(p, lambda: len(self.committed()) == 2)
        self.assertEqual([x["in_flight_at_cut"] for x in self.cuts(s)][:2], [0, 1], "blocks kept being cut on the tip")


class Heartbeat(Modes):
    def test_a_heartbeat_is_cut_only_with_nothing_in_flight(self):
        s = self.setup({})
        p = self.first_in_flight(s, 2)
        p.empty_every = 5
        self.now[0] += 100
        cuts = len(self.cuts(s))
        for _ in range(3):
            self.step(p)
        self.assertEqual(len(self.cuts(s)), cuts, "no heartbeat above a block in flight")
        self.drive(p, lambda: not p.flight and self.committed())
        self.now[0] += 100
        self.drive(p, lambda: len(self.cuts(s)) == cuts + 1)
        self.assertEqual((self.cuts(s)[-1]["cut_reason"], self.cuts(s)[-1]["in_flight_at_cut"]), ("heartbeat", 0))


class AfterARefusal(Modes):
    def test_the_retry_after_a_refusal_is_made_alone_until_it_commits(self):
        s = self.setup({}, refuse="the sidecar refused the proof")
        self.script(tp.A, "sleep 1", "sleep 3")
        self.script(tp.B_, "ok", "sleep 3")
        p = self.pipeline(s, 2)
        self.fill(s, p, 2)
        self.assertEqual((p.flight, p.refusals_in_row), ([], 1))
        s.ledger.refuse = None
        self.drive(p, lambda: len(p.flight) == 1)
        self.assertEqual(self.cuts(s)[-1]["cut_reason"], "retry")
        s.reth.pool[tp.DAVE] = [tx(tp.DAVE, 0)]
        cuts = len(self.cuts(s))
        for _ in range(3):
            self.step(p)
        self.assertEqual(len(self.cuts(s)), cuts, "nothing is cut above the retry")
        self.assertIsNotNone(p.cut_blocked())
        self.drive(p, lambda: len(self.committed()) >= 1)
        self.assertEqual(p.refusals_in_row, 0)
        self.drive(p, lambda: len(self.committed()) == 2 and not p.flight)
        self.assertEqual(self.in_pool(s), set())


class Stop(Modes):
    """A stop (SIGTERM) with two blocks in flight: the submit that is running finishes, nothing is cut, and the next start sends the rest again."""

    def wait_for(self, until, limit=30):
        end = time.monotonic() + limit
        while not until():
            self.assertLess(time.monotonic(), end, "the run did not get there in time")
            time.sleep(0.02)

    def test_the_running_submit_finishes_and_the_next_start_recovers_the_rest(self):
        s = self.setup({})
        self.script(tp.A, "sleep 3")   # the first block's proof is the slow one: the second is proven before it
        p = self.pipeline(s, 2)
        real, submitted = p.submit_oldest, []
        def submit(entry):
            if not submitted:
                submitted.append(entry.number)
                self.stop.set()   # the signal arrives while the Advance is on its way
            return real(entry)
        p.submit_oldest = submit
        run = threading.Thread(target=p.run, daemon=True)
        run.start()
        s.reth.pool[ALICE] = [tx(ALICE, 0)]
        self.wait_for(lambda: len(p.flight) == 1)
        s.reth.pool[BOB] = [tx(BOB, 0)]
        self.wait_for(lambda: len(self.cuts(s)) == 2)
        s.reth.pool[CAROL] = [tx(CAROL, 0)]
        run.join(60)
        self.assertFalse(run.is_alive())
        self.assertEqual(self.numbers(s), [FIRST], "the submit that was running finished, and nothing else was sent")
        self.assertEqual(self.committed(), [FIRST])
        self.assertEqual(len(self.cuts(s)), 2, "nothing was cut after the signal")
        self.assertEqual(self.status()["state"], "stopped")
        self.assertEqual([x["number"] for x in b.read_saved_entries(s.cfg)], [FIRST + 1], "the second block's transaction is kept")
        self.assertTrue(all(h.proving.ticket.cancelled for h in p.flight), "its proof is given up")
        later = self.producer(s, max_in_flight=2)
        self.step(later)
        self.assertEqual([x["recovered"] for x in self.reports if "recovered" in x], [1])
        self.drive(later, lambda: not later.flight and not self.in_pool(s) and int(s.ledger.head["headNumber"]) >= FIRST + 1)
        self.assertEqual(self.numbers(s)[:2], [FIRST, FIRST + 1])
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (self.canton_head(s), self.canton_head(s)))
        self.assertEqual(self.in_pool(s), set())


if __name__ == "__main__":
    unittest.main()
