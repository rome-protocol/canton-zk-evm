"""The prover pool (provers.py) against the stand-in prover (fake-prove.sh), whose answer is set per job. Run: python3 -m unittest discover -s builder/tests"""
import os, re, sys, tempfile, threading, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import provers as pv
from journal import check_settings

FAKE = str(HERE / "fake-prove.sh")
BLOCK = "0x" + "12" * 32
A, B_, C_ = "http://127.0.0.1:7001", "http://127.0.0.1:7002", "http://127.0.0.1:7003"


def tag(url: str) -> str:
    return re.sub(r"[^a-z0-9]", "_", url)


class Case(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.dir, ignore_errors=True))
        self.plan = self.dir / "plan"
        self.plan.mkdir()
        self.env = {"FAKE_LOG": str(self.dir / "fake.log"), "FAKE_PROVER_PLAN": str(self.plan)}
        for k, v in self.env.items():
            os.environ[k] = v
            self.addCleanup(os.environ.pop, k, None)
        self.input = self.dir / "input.bin"
        self.input.write_text(BLOCK + "\n")
        self.n = 0

    def script(self, url, *lines):
        (self.plan / tag(url)).write_text("".join(f"{l}\n" for l in lines))

    def calls(self):
        log = self.plan / "log"
        return log.read_text().split("\n")[:-1] if log.exists() else []

    def job(self, **k):
        self.n += 1
        return pv.Job(make_input=None, prove_cmd=FAKE, input_path=self.input, out_dir=self.dir / f"out-{self.n}", check=check_block, **k)

    def result(self, ticket, wait=30):
        """The ticket's result; a ticket that does not end in `wait` seconds fails the test at once, with a clear message."""
        self.assertTrue(ticket.done.wait(timeout=wait), f"the ticket did not end in {wait} s (a prover left busy, or a job left waiting)")
        return ticket.result()

    def prove(self, pool, job, wait=30):
        return self.result(pool.submit(job), wait)

    def pool(self, urls, timeout=20, **k):
        return pv.Pool([pv.Prover(f"gpu{i}", u) for i, u in enumerate(urls)], timeout=timeout, cooldown_start=0.4, cooldown_max=1.6, **k)


def check_block(proof):
    if b.committed_hash(proof) != BLOCK:
        raise pv.JobError("the proof commits to another block", outcome="wrong_block")


class OneProver(Case):
    def test_a_proof(self):
        pool = self.pool([A])
        done = self.prove(pool, self.job())
        self.assertEqual(done.prover, "gpu0")
        self.assertEqual(len(done.proof), 2688)
        self.assertTrue((self.dir / "out-1" / "wrapped-proof.hex").is_file())
        self.assertEqual((pool.events(), pool.status()), ([], None))

    def test_a_failure_is_one_try_with_no_retry_no_health_and_no_event(self):
        pool = self.pool([A])
        self.script(A, "fail", "ok")
        with self.assertRaises(pv.JobError) as e:
            self.prove(pool, self.job())
        self.assertTrue(str(e.exception).startswith("fake-prove.sh failed: the prover is down"))
        self.assertEqual(self.calls(), [f"{tag(A)} fail"])
        self.assertEqual((pool.events(), pool.status()), ([], None))
        self.assertEqual(self.prove(pool, self.job()).prover, "gpu0")   # nothing marked it down: the next block goes to it

    def test_a_connection_error_with_one_prover_marks_nothing_down(self):
        pool = self.pool([A])
        self.script(A, "connect", "ok")
        with self.assertRaises(pv.JobError) as e:
            self.prove(pool, self.job())
        self.assertTrue(e.exception.connection)
        self.assertEqual(pool.events(), [])
        self.assertTrue(pool.any_up())
        self.prove(pool, self.job())

    def test_the_builder_never_kills_a_proof_with_one_prover(self):
        pool = self.pool([A], timeout=1)   # prove-one.sh's own limit (CZE_PROVE_TIMEOUT) is the only one: a proof that runs past it ends, not killed
        self.script(A, "sleep 2")
        self.assertEqual(self.prove(pool, self.job()).prover, "gpu0")
        self.assertEqual(self.calls(), [f"{tag(A)} sleep 2"])

    def test_a_proof_that_hangs_is_not_cut_short_by_the_builder_with_one_prover(self):
        pool = self.pool([A], timeout=1)
        seen = []
        pool.run = lambda cmd, args, env=None, timeout=None: seen.append(timeout) or (_ for _ in ()).throw(pv.JobError("prove-one.sh failed: its own timeout"))
        with self.assertRaises(pv.JobError) as e:
            self.prove(pool, self.job())
        self.assertEqual((seen, e.exception.outcome), ([None], "failed"))   # no kill from the builder, and the end is the prove command's own

    def test_a_helper_that_left_the_group_and_holds_the_pipes_does_not_hold_the_job(self):
        pidfile = self.dir / "helper.pid"
        self.addCleanup(lambda: pidfile.exists() and os.kill(int(pidfile.read_text()), 9) if pidfile.exists() else None)
        code = ("import os,subprocess,time;p=subprocess.Popen(['sleep','37'],start_new_session=True);"
                f"open({str(pidfile)!r},'w').write(str(p.pid));time.sleep(60)")
        start = time.monotonic()
        with self.assertRaises(pv.JobError) as e:
            pv.run_command("python3", ["-c", code], timeout=1)
        self.assertEqual(e.exception.outcome, "timeout")
        self.assertLess(time.monotonic() - start, 15)

    def test_one_prover_with_no_url_leaves_the_environment_alone(self):
        os.environ["ZISK_COORDINATOR_URL"] = A
        self.addCleanup(os.environ.pop, "ZISK_COORDINATOR_URL", None)
        pool = pv.Pool([pv.Prover("fake-prove.sh")])
        self.script(A, "ok")
        self.assertEqual(self.prove(pool, self.job()).prover, "fake-prove.sh")
        self.assertEqual(self.calls(), [f"{tag(A)} ok"])

    def test_the_input_tool_failing_is_no_prover_fault(self):
        pool = self.pool([A, B_])
        job = pv.Job(make_input=[str(HERE / "fake-make-input.sh"), "nope", "nope", "nope", str(self.dir / "x")], prove_cmd=FAKE,
                     input_path=self.input, out_dir=self.dir / "o")
        with self.assertRaises(pv.JobError) as e:
            self.prove(pool, job)
        self.assertEqual(e.exception.stage, "input")
        self.assertEqual((self.calls(), pool.events()), ([], []))


class Pool2(Case):
    def test_the_oldest_ready_blocks_go_to_different_provers_one_job_each(self):
        pool = self.pool([A, B_])
        self.script(A, "sleep 1")
        self.script(B_, "sleep 1")
        tickets = [pool.submit(self.job()) for _ in range(3)]
        time.sleep(0.4)
        self.assertEqual(len(self.calls()), 2)    # a third waits: a prover never gets a second job
        self.assertEqual(sorted(c.split()[0] for c in self.calls()), sorted([tag(A), tag(B_)]))
        for t in tickets:
            self.result(t)
        self.assertEqual(len(self.calls()), 3)

    def test_a_failure_is_retried_once_on_the_other_prover_and_the_first_goes_down(self):
        pool = self.pool([A, B_])
        self.script(A, "fail")
        done = self.prove(pool, self.job())
        self.assertEqual((done.prover, done.tried), ("gpu1", ["gpu0"]))
        self.assertEqual(self.calls(), [f"{tag(A)} fail", f"{tag(B_)} ok"])
        (ev,) = pool.events()
        self.assertEqual((ev["name"], ev["state"]), ("gpu0", "down"))
        self.assertIn("then succeeded on gpu1", ev["reason"])
        self.assertEqual([p["state"] for p in pool.status()], ["down", "up"])
        self.prove(pool, self.job())   # gpu0 is in its cool-down: the next block goes to gpu1 though gpu0 is free
        self.assertEqual(self.calls()[-1], f"{tag(B_)} ok")

    def test_a_proof_of_another_block_counts_as_a_failure_and_is_retried(self):
        pool = self.pool([A, B_])
        self.script(A, "wrong")
        self.assertEqual(self.prove(pool, self.job()).prover, "gpu1")
        self.assertEqual([e["name"] for e in pool.events()], ["gpu0"])

    def test_a_prover_that_cannot_be_reached_is_down_before_a_waiting_job_can_be_given_it(self):
        pool = self.pool([A, B_])
        states = []
        real = pool.cond.notify_all
        pool.cond.notify_all = lambda: (states.append((pool.provers[0].busy, pool.provers[0].state)), real())[1]
        pool._release(pool.provers[0], pv.JobError("refused", connection=True), failed=True)
        self.assertEqual(states[-1], (False, "down"))   # when the waiters wake, the prover is already down

    def test_a_connection_error_takes_the_prover_down_at_once(self):
        pool = self.pool([A, B_])
        self.script(A, "connect")
        self.assertEqual(self.prove(pool, self.job()).prover, "gpu1")
        (ev,) = pool.events()
        self.assertEqual((ev["name"], ev["state"]), ("gpu0", "down"))
        self.assertIn("connection error", ev["reason"])

    def test_a_connection_error_marks_it_down_even_when_the_retry_fails_too(self):
        pool = self.pool([A, B_])
        self.script(A, "connect")
        self.script(B_, "fail")
        with self.assertRaises(pv.JobError):
            self.prove(pool, self.job())
        self.assertEqual([(e["name"], e["state"]) for e in pool.events()], [("gpu0", "down")])   # gpu1 only failed a block

    def test_a_hang_is_killed_retried_and_the_hung_prover_goes_down(self):
        pool = self.pool([A, B_], timeout=1)
        self.script(A, "hang")
        done = self.prove(pool, self.job())
        self.assertEqual(done.prover, "gpu1")
        (ev,) = pool.events()
        self.assertEqual((ev["name"], ev["state"]), ("gpu0", "down"))
        self.assertIn("timeout", ev["reason"])
        self.assertEqual(subprocess_count("sleep 3607"), 0)

    def test_a_block_that_fails_on_every_prover_is_a_block_failure_and_marks_none_down(self):
        pool = self.pool([A, B_])
        self.script(A, "fail", "fail")
        self.script(B_, "fail", "fail")
        for _ in range(2):   # the hunt for the bad transaction sends several blocks: still none goes down
            with self.assertRaises(pv.JobError) as e:
                self.prove(pool, self.job())
            self.assertIn("every prover", str(e.exception))
        self.assertEqual(len(self.calls()), 4)   # one retry each, not more
        self.assertEqual((pool.events(), [p["state"] for p in pool.status()]), ([], ["up", "up"]))

    def test_one_slow_block_that_times_out_on_every_prover_takes_none_down(self):
        pool = self.pool([A, B_], timeout=1)
        self.script(A, "hang")
        self.script(B_, "hang")
        with self.assertRaises(pv.JobError) as e:
            self.prove(pool, self.job())
        self.assertEqual(e.exception.outcome, "timeout")
        self.assertEqual((pool.events(), [p["state"] for p in pool.status()]), ([], ["up", "up"]))
        self.assertEqual(subprocess_count("sleep 3607"), 0)

    def test_cool_down_then_the_prover_is_tried_again_and_is_up(self):
        pool = self.pool([A, B_])
        self.script(A, "connect")
        self.prove(pool, self.job())
        pool.events()
        time.sleep(0.5)   # the cool-down is 0.4 s here
        self.script(B_, "sleep 1")
        t = pool.submit(self.job())   # gpu0 is free and its cool-down is over; gpu1 is not: the job goes to gpu0 to try it
        time.sleep(0.3)
        self.assertEqual(self.result(t).prover, "gpu0")
        self.assertEqual([(e["name"], e["state"]) for e in pool.events()], [("gpu0", "up")])
        self.assertEqual(pool.status()[0]["state"], "up")

    def test_the_cool_down_doubles_with_each_new_fault_and_a_proof_resets_it(self):
        pool = self.pool([A, B_])
        gpu0 = pool.provers[0]
        self.script(A, "connect", "connect")
        self.prove(pool, self.job())
        self.assertEqual(gpu0.cooldown, 0.8)
        time.sleep(0.5)
        self.script(B_, "sleep 1")
        t = pool.submit(self.job())     # gpu0 tried again: connection error again
        self.result(t)
        self.assertEqual(gpu0.cooldown, 1.6)
        pool.events()
        time.sleep(1.0)
        self.script(B_, "sleep 1")
        self.prove(pool, self.job())          # gpu0 answers ok now
        self.assertEqual((gpu0.state, gpu0.cooldown), ("up", 0.4))

    def test_with_every_prover_down_nothing_is_cut_and_a_job_waits_for_the_first_cool_down(self):
        pool = self.pool([A, B_])
        self.script(A, "connect")
        self.script(B_, "connect")
        with self.assertRaises(pv.JobError):
            self.prove(pool, self.job())
        self.assertEqual({e["name"] for e in pool.events()}, {"gpu0", "gpu1"})
        self.assertFalse(pool.any_up())    # the producer cuts nothing now
        start = time.monotonic()
        self.assertEqual(self.prove(pool, self.job()).prover in ("gpu0", "gpu1"), True)   # the next job waits for a cool-down, then runs
        self.assertGreater(time.monotonic() - start, 0.25)
        self.assertTrue(pool.any_up())

    def test_a_cancelled_block_is_not_retried_and_does_not_touch_health(self):
        pool = self.pool([A, B_])
        self.script(A, "sleep 1", "ok")
        t = pool.submit(self.job())
        time.sleep(0.4)
        t.cancel()
        self.result(t)    # the job ran to the end; its result is the caller's to throw away
        self.assertEqual(pool.events(), [])
        self.script(A, "fail")
        self.script(B_, "ok")
        t2 = pool.submit(self.job())
        t2.cancel()
        try:
            self.result(t2)
        except pv.JobError:
            pass
        self.assertEqual(pool.events(), [])    # a failed, cancelled job marks no prover down, and is not retried
        self.assertEqual([p["state"] for p in pool.status()], ["up", "up"])

    def test_a_cancel_wakes_a_block_that_waits_for_a_prover(self):
        pool = self.pool([A, B_])
        self.script(A, "sleep 3")
        self.script(B_, "sleep 3")
        busy = [pool.submit(self.job()), pool.submit(self.job())]
        time.sleep(0.4)
        waiting = pool.submit(self.job())   # both provers are busy: it waits
        time.sleep(0.2)
        waiting.cancel()
        self.assertTrue(waiting.done.wait(timeout=1.5), "a cancelled block kept waiting for a prover to be freed")
        with self.assertRaises(pv.JobError) as e:
            waiting.result()
        self.assertEqual(e.exception.outcome, "cancelled")
        self.assertEqual(len(self.calls()), 2)   # only the two busy blocks were ever sent
        for t in busy:
            self.result(t)

    def test_a_cancelled_block_that_ends_with_a_connection_error_marks_no_prover_down(self):
        gate, started = threading.Event(), threading.Event()
        def fake_run(cmd, args, env=None, timeout=None):
            started.set()
            gate.wait(timeout=30)
            raise pv.JobError("cannot connect", outcome="failed", connection=True)
        pool = self.pool([A, B_], run=fake_run)
        t = pool.submit(self.job())
        self.assertTrue(started.wait(timeout=5), "the job did not start on a prover")   # the cancel must come while the job runs
        t.cancel()
        gate.set()
        with self.assertRaises(pv.JobError) as e:
            self.result(t)
        self.assertTrue(e.exception.connection)   # the connection-error path ran
        self.assertEqual(pool.events(), [])
        self.assertEqual([p["state"] for p in pool.status()], ["up", "up"])

    def test_a_retry_goes_to_a_prover_that_is_up_not_to_one_just_rested(self):
        pool = self.pool([A, B_, C_])
        clock = [1000.0]
        pool.clock = lambda: clock[0]
        pool._down(pool.provers[1], "test")   # gpu1 rests until 1000.4
        pool.events()
        self.script(A, "fail")
        self.script(B_, "fail")   # gpu1 must not be tried at all
        self.script(C_, "ok")
        run = pool.run
        def run_then_time_passes(*a, **k):
            try:
                return run(*a, **k)
            finally:
                clock[0] += 1000   # gpu1's cool-down ends while gpu0's try is over and the retry is chosen
        pool.run = run_then_time_passes
        done = self.prove(pool, self.job())
        self.assertEqual((done.prover, done.tried), ("gpu2", ["gpu0"]))
        self.assertEqual(self.calls(), [f"{tag(A)} fail", f"{tag(C_)} ok"])

    def test_a_prover_whose_cool_down_is_over_is_tried_by_the_next_block_even_when_one_before_it_is_free(self):
        pool = self.pool([A, B_])
        spare = pool.provers[1]
        pool._down(spare, "test")
        pool.events()
        self.assertEqual(spare.state, "down")
        time.sleep(0.5)   # the cool-down is 0.4 s here
        done = self.prove(pool, self.job())   # gpu0 is up and listed first, and free; the block still goes to the rested gpu1
        self.assertEqual(done.prover, "gpu1")
        self.assertEqual([(e["name"], e["state"]) for e in pool.events()], [("gpu1", "up")])
        self.assertEqual([p["state"] for p in pool.status()], ["up", "up"])
        self.assertEqual(self.prove(pool, self.job()).prover, "gpu0")   # and after that, the order is the listed one again

    def test_a_remote_input_is_copied_to_the_shared_folder_and_removed(self):
        shared = self.dir / "shared"
        shared.mkdir()
        seen = []
        def fake_run(cmd, args, env=None, timeout=None):
            seen.append((Path(args[0]), env["ZISK_COORDINATOR_URL"], Path(args[0]).read_text()))
            raise pv.JobError("stop here")
        pool = self.pool([A, B_], run=fake_run)
        with self.assertRaises(pv.JobError):
            self.prove(pool, self.job(input_dir=shared))
        self.assertEqual(len(seen), 2)
        self.assertTrue(all(p.parent == shared and text == BLOCK + "\n" for p, _, text in seen))
        self.assertEqual({u for _, u, _ in seen}, {A, B_})
        self.assertEqual(list(shared.iterdir()), [])

    def test_an_error_that_is_not_a_job_error_frees_the_prover_and_marks_none_down(self):
        calls = []
        def fake_run(cmd, args, env=None, timeout=None):
            calls.append(args)
            if len(calls) == 1:
                raise OSError("cannot start the prove command")
            pv.run_command(cmd, args, env=env, timeout=timeout)
        pool = self.pool([A, B_], run=fake_run)
        with self.assertRaises(OSError):
            self.prove(pool, self.job())
        done = self.prove(pool, self.job())   # it would wait for ever if the prover stayed busy
        self.assertEqual(len(calls), 2)
        self.assertEqual(pool.events(), [])
        self.assertEqual(done.prover in ("gpu0", "gpu1"), True)
        self.assertEqual([p["state"] for p in pool.status()], ["up", "up"])

    def test_a_missing_shared_folder_fails_the_block_and_the_next_one_proves_once_it_exists(self):
        shared = self.dir / "shared"
        pool = self.pool([A, B_])
        for _ in range(2):
            with self.assertRaises(OSError):
                self.prove(pool, self.job(input_dir=shared))
        shared.mkdir()
        done = self.prove(pool, self.job(input_dir=shared))
        self.assertEqual(done.tried, [])
        self.assertEqual(pool.events(), [])

    def test_one_prover_survives_a_non_job_error_and_the_ticket_ends(self):
        calls = []
        def fake_run(cmd, args, env=None, timeout=None):
            calls.append(args)
            if len(calls) == 1:
                raise PermissionError("denied")
            pv.run_command(cmd, args, env=env, timeout=timeout)
        pool = self.pool([A], run=fake_run)
        t1 = pool.submit(self.job())
        t2 = pool.submit(self.job())   # waits behind the first
        with self.assertRaises(PermissionError):
            self.result(t1)
        self.assertEqual(self.result(t2).prover, "gpu0")


class Timeouts(Case):
    def test_a_fractional_timeout_is_passed_rounded_up_never_as_zero(self):
        for timeout, passed in ((1.2, "2"), (0.5, "1")):
            seen = []
            pool = pv.Pool([pv.Prover("gpu0", A), pv.Prover("gpu1", B_)], timeout=timeout,
                           run=lambda cmd, args, env=None, timeout=None: seen.append(env["CZE_PROVE_TIMEOUT"]) or (_ for _ in ()).throw(OSError("stop")))
            with self.assertRaises(OSError):
                self.prove(pool, pv.Job(make_input=None, prove_cmd="x", input_path=self.input, out_dir=self.dir / f"o-{passed}", check=None))
            self.assertEqual(seen, [passed])


class Settings(unittest.TestCase):
    def test_the_heartbeat_floor_is_one_proof_whatever_the_number_of_provers(self):
        for provers in (1, 2, 3):
            with self.assertRaises(ValueError) as e:
                check_settings("on_demand", 0, 3.2, provers=provers)
            self.assertIn("cannot keep up", str(e.exception))
            check_settings("on_demand", 0, 6.3, provers=provers)

    def test_prover_flags(self):
        ps = pv.parse_provers(["gpu0=http://127.0.0.1:7000", "gpu1=https://10.0.0.2:7000"], "prove-one.sh")
        self.assertEqual([(p.name, p.url) for p in ps], [("gpu0", "http://127.0.0.1:7000"), ("gpu1", "https://10.0.0.2:7000")])
        (one,) = pv.parse_provers([], "prove-one.sh", "http://127.0.0.1:7000")
        self.assertEqual((one.name, one.url), ("prove-one.sh", "http://127.0.0.1:7000"))
        for bad in ("gpu0", "=http://x", "gpu0=ftp://x", "a b=http://x"):
            with self.assertRaises(ValueError):
                pv.parse_provers([bad], "x")
        with self.assertRaises(ValueError):
            pv.parse_provers(["a=http://x", "a=http://y"], "x")


def subprocess_count(pattern: str) -> int:
    import subprocess
    out = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True).stdout.split()
    return len([p for p in out if p != str(os.getpid())])


if __name__ == "__main__":
    unittest.main()
