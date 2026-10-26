"""The producer that keeps several blocks in flight, where a block has to be made with nothing in flight: a leg that waits for the blocks before it
(it has its Canton side, and the block is built on a block in flight), the heartbeat, the retries after a refusal, and a leg that has no Canton side
at all (no drain). Built directly at two and three blocks."""
import json, sys, threading, time, unittest
from datetime import datetime, timedelta, timezone
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

    def test_a_pause_that_ended_early_does_not_hide_the_wait_at_two(self):
        """The block cut on a block in flight reads the chain contract of that block, which is as old as its submit. A pause that was lifted
        since must not turn the wait into a reason on the explorer: the legs wait for the blocks in flight and are judged on a fresh head."""
        s = self.setup({}, terms=[tb.TERMS])
        s.ledger.chain_extra = {"pausedUntil": (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")}
        p = self.first_in_flight(s, 2)
        s.ledger.chain_extra = {}   # the confirmer lifted the pause while the first block is proven
        leg = tx(BOB, 0)
        s.reth.tx_legs[leg["hash"]] = [tb.PAY]
        s.reth.pool[BOB] = [leg]
        self.drive(p, lambda: any(x.get("skipped") for x in self.reports))
        left = [x for x in self.reports if x.get("skipped")][0]["leftOut"]
        self.assertEqual(left, [{"transaction": leg["hash"], "reason": b.LEG_WAITS}])
        self.assertTrue(p.leg_wait)

    def test_a_pause_in_force_leaves_the_leg_out_for_the_pause_and_nothing_waits_at_two(self):
        """The pause is read on the chain contract Canton has now: a leg is left out for it, leg_wait stays off, and the producer keeps cutting
        blocks in a row instead of draining after every second block."""
        s = self.setup({}, terms=[tb.TERMS])
        s.ledger.chain_extra = {"pausedUntil": (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")}
        p = self.first_in_flight(s, 2)
        leg = tx(BOB, 0)
        s.reth.tx_legs[leg["hash"]] = [tb.PAY]
        s.reth.pool[BOB] = [leg]
        self.drive(p, lambda: any(x.get("skipped") for x in self.reports))
        left = [x for x in self.reports if x.get("skipped")][0]["leftOut"]
        self.assertEqual([x["transaction"] for x in left], [leg["hash"]])
        self.assertTrue(left[0]["reason"].startswith("the Canton legs are paused until 20"), left)
        self.assertFalse(p.leg_wait)
        self.assertIsNone(p.one_at_a_time())

    def test_a_leg_waits_for_the_block_in_flight_at_two(self):
        self.check_waits_then_goes_in_on_the_head(2)

    def test_a_leg_waits_for_the_block_in_flight_at_three(self):
        self.check_waits_then_goes_in_on_the_head(3)

    def test_a_leg_left_out_goes_in_on_the_next_cut_when_the_block_in_flight_is_refused(self):
        """The wait for the blocks in flight ends with no commit: the leg is not held for the pause of a pool that holds nothing includable."""
        s, p, leg = self.waiting_leg(2)
        self.drive(p, lambda: any(x.get("skipped") for x in self.reports))
        self.assertTrue(p.leg_wait)
        self.assertIsNone(p.held, "a block that held only a leg that waits is not looked at again after a pause")
        s.ledger.refuse = "the sidecar refused the proof"
        self.drive(p, lambda: p.refusals_in_row == 1 and not p.flight)
        s.ledger.refuse = None
        self.assertEqual(self.committed(), [])
        at = self.now[0]
        self.drive(p, lambda: any(x.get("legTransactions") == [leg["hash"]] and x.get("committed") for x in self.reports), limit=20)
        self.assertEqual(self.now[0], at, "the fake clock never passed RECHECK_BASE: the leg went in on the next cut, not after the pause")
        self.assertEqual(self.in_pool(s), set())
        self.assertFalse(p.leg_wait)

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


class InFlightStatus(Modes):
    """The status file lists the blocks in flight now, with their states, once the producer can keep more than one."""

    def test_the_status_lists_the_blocks_in_flight_with_their_states_at_three(self):
        s = self.setup({})
        p = self.first_in_flight(s, 3)
        listed = p.status()["inFlight"]
        self.assertEqual([(x["number"], x["state"]) for x in listed], [(FIRST, "proving")])
        self.assertEqual(listed[0]["attempt"], p.flight[0].attempt.seq)
        s.reth.pool[BOB] = [tx(BOB, 0)]
        self.drive(p, lambda: len(p.flight) == 2)
        self.assertEqual([x["number"] for x in p.status()["inFlight"]], [FIRST, FIRST + 1], "the oldest first")
        self.assertEqual(json.loads(json.dumps(p.status()))["inFlight"], p.status()["inFlight"], "it is plain JSON")

    def test_the_status_names_each_block_hash_and_the_prover_it_is_on_at_three(self):
        s = self.setup({})
        p = self.first_in_flight(s, 3)
        listed = p.status()["inFlight"][0]
        self.assertEqual(listed["hash"], p.flight[0].hash)
        self.assertEqual(listed["prover"], p.flight[0].proving.ticket.prover)
        self.assertEqual(set(listed), {"number", "hash", "attempt", "state", "prover"})

    def test_the_written_status_lists_a_new_block_at_once_at_three(self):
        s = self.setup({})
        p = self.first_in_flight(s, 3)
        self.assertEqual([x["number"] for x in p.status_last["inFlight"]], [FIRST], "the file was written when the block was cut")
        s.reth.pool[BOB] = [tx(BOB, 0)]
        self.drive(p, lambda: len(p.flight) == 2)
        self.assertEqual([x["number"] for x in p.status_last["inFlight"]], [FIRST, FIRST + 1])

    def test_the_final_status_of_a_stop_lists_no_block_in_flight_at_two(self):
        s = self.setup({})
        p = self.first_in_flight(s, 2)
        p.abandon()
        p.write_status("stopped", final=True)
        self.assertEqual(p.status_last["inFlight"], [], "the blocks given up are not in flight")

    def test_the_status_lists_nothing_once_every_block_is_final_at_two(self):
        s = self.setup({})
        p = self.first_in_flight(s, 2)
        self.drive(p, lambda: not p.flight and self.committed())
        self.assertEqual(p.status()["inFlight"], [])

    def test_the_status_of_one_block_at_a_time_has_no_in_flight_list(self):
        s = self.setup({})
        self.engine = None   # `Producer`, the engine of `run` at depth 1
        p = self.producer(s)
        self.assertNotIn("inFlight", p.status())
        self.assertNotIn("submitting", p.status())


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

    def test_a_stop_with_three_blocks_in_flight_gives_up_all_three_and_the_next_start_sends_them_again(self):
        s = self.setup({})
        self.script(tp.A, "sleep 4")   # the first block's proof is the slow one: the others are cut on the other prover while it runs
        p = self.pipeline(s, 3)
        real = p.cut
        def cut(*a, **kw):
            found = real(*a, **kw)
            if len(self.cuts(s)) == 3:
                self.stop.set()   # the signal arrives with the loop full
            return found
        p.cut = cut
        for i, sender in enumerate((ALICE, BOB, CAROL)):
            s.reth.pool[sender] = [tx(sender, 0)]
            self.drive(p, lambda i=i: len(self.cuts(s)) == i + 1)
        self.assertEqual([e.number for e in p.flight], [FIRST, FIRST + 1, FIRST + 2])
        p.abandon()
        self.assertEqual(self.numbers(s), [], "no Advance is sent after the signal")
        self.assertTrue(all(e.proving.ticket.cancelled for e in p.flight), "every proof is given up")
        self.assertEqual(sorted(x["number"] for x in b.read_saved_entries(s.cfg)), [FIRST, FIRST + 1, FIRST + 2], "every block's transaction is kept")
        self.stop.clear()
        self.script(tp.A, "true")
        later = self.producer(s, max_in_flight=3)
        self.step(later)
        self.assertEqual([x["recovered"] for x in self.reports if "recovered" in x], [3])
        self.drive(later, lambda: not later.flight and not self.in_pool(s) and self.committed())
        self.assertEqual(self.numbers(s), [FIRST], "the three blocks' transactions went in again, as one block on Canton's head")

    def test_an_empty_block_given_up_at_a_stop_gets_its_last_line(self):
        """Its transactions are none, so no kept file names its attempt, and the next start closes nothing for it: the stop does."""
        s = self.setup({})
        self.script(tp.A, "sleep 3")
        p = self.pipeline(s, 2)
        p.empty_every = 5
        self.now[0] += 100
        self.drive(p, lambda: len(p.flight) == 1)
        empty, run = p.flight[0].attempt.seq, p.journal.run_id
        self.assertEqual(self.cuts(s)[-1]["cut_reason"], "heartbeat")
        s.reth.pool[BOB] = [tx(BOB, 0)]
        real = p.cut
        def cut(*a, **kw):
            found = real(*a, **kw)
            self.stop.set()   # the signal arrives with the second block cut above the empty one
            return found
        p.cut = cut
        self.step(p)
        self.assertEqual(len(p.flight), 2)
        full = p.flight[1].attempt.seq
        p.abandon()
        closed = [x for x in self.lines(s, "resolved") if x.get("attempt") == empty]
        self.assertEqual([(x["outcome"], x.get("attempt_run", run)) for x in closed], [("restarted", run)], "one last line, from the stop")
        self.assertEqual([x for x in self.lines(s, "resolved") if x.get("attempt") == full], [], "a block with transactions is closed by the next start, from the kept file")
        self.stop.clear()
        later = self.producer(s, max_in_flight=2)
        self.step(later)
        self.assertEqual(len([x for x in self.lines(s, "resolved") if x.get("attempt") == empty and x.get("attempt_run") == run]), 1, "the next start does not close it a second time")
        self.assertEqual(len([x for x in self.lines(s, "resolved") if x.get("attempt") == full and x.get("attempt_run") == run]), 1)

    def test_the_running_submit_finishes_and_the_next_start_recovers_the_rest(self):
        s = self.setup({})
        self.script(tp.A, "sleep 3")   # the first block's proof is the slow one: the second is proven before it
        p = self.pipeline(s, 2)
        real, submitted = p.start_send, []
        def submit(entry):
            real(entry)
            if not submitted:
                submitted.append(entry.number)
                self.stop.set()   # the signal arrives while the Advance is on its way
        p.start_send = submit
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
