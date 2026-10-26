"""The producer that keeps several blocks in flight, where a block has to be made with nothing in flight: a leg that waits for the blocks before it
(it has its Canton side, and the block is built on a block in flight), the heartbeat, the retries after a refusal, and a leg that has no Canton side
at all (no drain). Built directly at two and three blocks."""
import sys, threading, time, unittest
from unittest import mock
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


class OneAtATime(Modes):
    """Each reason to cut with nothing in flight stops a block on the tip by itself: the loop is filled above a block in flight only when none holds."""

    NOBODY = {"failures": 0, "refusals_in_row": 0, "hunt": None, "control": None, "probe": None, "suspects": []}
    UNKNOWN = "0x" + "11" * 32

    def check_blocks_alone(self, k, **state):
        s = self.setup({})
        p = self.first_in_flight(s, k)
        s.reth.pool[BOB] = [tx(BOB, 0)]
        cuts = len(self.cuts(s))
        for name, value in state.items():
            setattr(p, name, value)
        for _ in range(3):
            self.step(p)
        self.assertEqual(len(self.cuts(s)), cuts, f"nothing is cut on the tip while {sorted(state)} holds")
        self.assertIsNotNone(p.cut_blocked())
        for name in state:
            setattr(p, name, self.NOBODY[name])
        self.assertIsNone(p.cut_blocked(), "and nothing else stops it")
        self.drive(p, lambda: len(self.cuts(s)) == cuts + 1)
        self.assertEqual(self.cuts(s)[-1]["in_flight_at_cut"], 1, "it is cut on the tip of the block in flight, once nothing holds it")

    def test_a_failure_stops_a_block_on_the_tip_at_two(self):
        self.check_blocks_alone(2, failures=1)

    def test_a_failure_stops_a_block_on_the_tip_at_three(self):
        self.check_blocks_alone(3, failures=2)

    def test_a_refusal_streak_stops_a_block_on_the_tip_at_three(self):
        self.check_blocks_alone(3, refusals_in_row=1)

    def test_a_hunt_for_a_transaction_that_cannot_be_proven_stops_a_block_on_the_tip_at_two(self):
        self.check_blocks_alone(2, hunt={"live": [self.UNKNOWN, "0x" + "22" * 32], "probe": [self.UNKNOWN], "parked": []})

    def test_a_hunt_for_a_transaction_that_cannot_be_proven_stops_a_block_on_the_tip_at_three(self):
        self.check_blocks_alone(3, hunt={"live": [self.UNKNOWN, "0x" + "22" * 32], "probe": [self.UNKNOWN], "parked": []})

    def test_a_control_block_stops_a_block_on_the_tip_at_two(self):
        self.check_blocks_alone(2, control={"tx": self.UNKNOWN, "why": "the prover failed"})

    def test_a_probe_stops_a_block_on_the_tip_at_two(self):
        self.check_blocks_alone(2, probe=self.UNKNOWN, suspects=[self.UNKNOWN, "0x" + "22" * 32])

    def test_suspects_still_to_be_tried_stop_a_block_on_the_tip_after_the_streak_is_cleared_at_two(self):
        self.check_blocks_alone(2, suspects=[self.UNKNOWN])   # a commit cleared the refusal streak and no probe is set: the next suspect is tried alone

    def test_suspects_still_to_be_tried_stop_a_block_on_the_tip_after_the_streak_is_cleared_at_three(self):
        self.check_blocks_alone(3, suspects=[self.UNKNOWN, "0x" + "22" * 32], probe=self.UNKNOWN)

    def test_a_block_that_failed_is_made_again_alone_until_it_commits_at_two(self):
        s = self.setup({})
        self.script(tp.A, "sleep 1", "sleep 4")
        self.script(tp.B_, "sleep 4", "sleep 4")
        real, calls = b.finish_proof, []
        def finish(cfg, built, running, attempt=None):
            proven = real(cfg, built, running, attempt)
            if not calls:
                calls.append(built.n)
                raise b.ProvingError("the prover is down", running.kept)   # the first proof fails once
            return proven
        patch = mock.patch.object(b, "finish_proof", finish)
        patch.start()
        self.addCleanup(patch.stop)
        p = self.pipeline(s, 2)
        s.reth.pool[ALICE] = [tx(ALICE, 0)]
        self.drive(p, lambda: p.failures == 1 and len(p.flight) == 1)   # the retry is in flight
        self.assertEqual(self.cuts(s)[-1]["cut_reason"], "retry")
        s.reth.pool[BOB] = [tx(BOB, 0)]
        cuts = len(self.cuts(s))
        for _ in range(3):
            self.step(p)
        self.assertEqual(len(self.cuts(s)), cuts, "nothing is cut above the retry")
        self.drive(p, lambda: len(self.committed()) == 2 and not p.flight)
        self.assertEqual(p.failures, 0)
        self.assertEqual(self.in_pool(s), set())


class OneProver(Modes):
    """The default `run --max-in-flight 2` with no --prover: two blocks, one prover."""

    def test_a_chain_of_commits_goes_in_order_at_two(self):
        s = self.setup({})
        p = self.pipeline(s, 2, provers=1)
        self.assertIsNone(s.cfg.pool)
        for i, sender in enumerate((ALICE, BOB, CAROL)):
            s.reth.pool[sender] = [tx(sender, 0)]
            self.drive(p, lambda: len(self.committed()) == i + 1)
        self.drive(p, lambda: not p.flight)
        self.assertEqual(self.numbers(s), [FIRST, FIRST + 1, FIRST + 2])
        self.assertEqual(self.committed(), [FIRST, FIRST + 1, FIRST + 2])
        self.assert_final_never_back(s)
        self.assertEqual((s.reth.head, self.finals(s)[-1]), (self.canton_head(s),) * 2)
        self.assertEqual(self.in_pool(s), set())

    def test_run_builds_the_engine_the_depth_names(self):
        s = self.setup({})
        built = []
        def fake(name):
            class Engine:
                def __init__(self, *a, **kw):
                    built.append((name, kw["max_in_flight"]))
                fatal = None
                def run(self):
                    pass
            return Engine
        for k, name in ((1, "Producer"), (2, "Pipeline"), (3, "Pipeline")):
            with mock.patch.object(b, "Producer", fake("Producer")), mock.patch.object(b, "Pipeline", fake("Pipeline")), \
                    mock.patch.object(b.Config, "from_env", classmethod(lambda cls: s.cfg)), \
                    mock.patch.object(b.signal, "signal"), \
                    mock.patch.object(sys, "argv", ["builder", "run", "--max-in-flight", str(k), *(["--prover", f"a={tp.A}", "--prover", f"b={tp.B_}"] if k == 3 else [])]):
                self.assertEqual(b.main(), 0)
            self.assertEqual(built[-1], (name, k))


class Stop(Modes):
    """A stop (SIGTERM) with two blocks in flight: the submit that is running finishes, nothing is cut, and the next start sends the rest again."""

    def wait_for(self, until, limit=30):
        end = time.monotonic() + limit
        while not until():
            self.assertLess(time.monotonic(), end, "the run did not get there in time")
            time.sleep(0.02)

    def stopped_step(self, early):
        """A signal that arrives before the step (early) or while it cuts the block that fills the loop: what the step does."""
        s = self.setup({})
        self.script(tp.A, "sleep 1")
        p = self.pipeline(s, 2)
        s.reth.pool[ALICE] = [tx(ALICE, 0)]
        self.drive(p, lambda: len(p.flight) == 1)
        s.reth.pool[BOB] = [tx(BOB, 0)]
        cuts = len(self.cuts(s))
        if early:
            self.stop.set()
        else:
            real = p.cut
            def cut(*a, **kw):
                self.stop.set()   # the signal arrives while the block is being cut
                return real(*a, **kw)
            p.cut = cut
        self.step(p)
        return s, p, cuts

    def test_a_signal_during_a_cut_starts_no_submit_at_two(self):
        s, p, cuts = self.stopped_step(early=False)
        self.assertEqual(self.numbers(s), [], "the oldest block is not submitted after the signal")
        self.assertEqual(len(self.cuts(s)), cuts + 1, "the block that was being cut is in flight, and kept for the next start")
        self.assertEqual(len(p.flight), 2)
        p.abandon()
        self.assertTrue(all(e.proving.ticket.cancelled for e in p.flight))
        self.assertEqual(sorted(x["number"] for x in b.read_saved_entries(s.cfg)), [FIRST, FIRST + 1])

    def test_a_signal_before_a_step_cuts_nothing_and_submits_nothing_at_two(self):
        s, p, cuts = self.stopped_step(early=True)
        self.assertEqual((len(self.cuts(s)), self.numbers(s)), (cuts, []))
        self.assertEqual(len(p.flight), 1)

    def test_a_signal_while_the_step_waits_for_the_oldest_proof_submits_nothing_at_two(self):
        s = self.setup({})
        self.script(tp.A, "sleep 3")   # the oldest block's proof is slow; the second block is proven on the other prover meanwhile
        p = self.pipeline(s, 2, provers=2)
        s.reth.pool[ALICE] = [tx(ALICE, 0)]
        self.drive(p, lambda: len(p.flight) == 1)
        s.reth.pool[BOB] = [tx(BOB, 0)]
        real = p.cut
        def cut(*a, **kw):
            found = real(*a, **kw)
            threading.Timer(0.5, self.stop.set).start()   # the signal arrives once the loop is full and the step waits for the oldest proof
            return found
        p.cut = cut
        started = time.monotonic()
        self.step(p)
        self.assertLess(time.monotonic() - started, 2.5, "the wait ended with the signal, not with the proof")
        self.assertTrue(self.stop.is_set())
        self.assertEqual(self.numbers(s), [], "no Advance is sent after the signal")
        self.assertEqual(len(p.flight), 2)
        p.abandon()
        self.assertTrue(all(e.proving.ticket.cancelled for e in p.flight))
        self.assertEqual(sorted(x["number"] for x in b.read_saved_entries(s.cfg)), [FIRST, FIRST + 1])
        self.stop.clear()
        self.script(tp.A, "true")
        later = self.producer(s, max_in_flight=2)   # the next start
        self.step(later)
        self.assertEqual([x["recovered"] for x in self.reports if "recovered" in x], [2])
        self.drive(later, lambda: not later.flight and not self.in_pool(s) and self.committed())
        self.assertEqual(self.numbers(s), [FIRST], "both blocks' transactions went in again, as one block on Canton's head")

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
