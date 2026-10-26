"""The pre-check (precheck.py) against the stand-in emulator (fake-ziskemu.sh), whose behaviour is set by each input's first line.
Run: python3 -m unittest discover -s builder/tests"""
import json, os, sys, tempfile, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import precheck as pc

FAKE = str(HERE / "fake-ziskemu.sh")


class Case(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.dir, ignore_errors=True))
        os.environ["FAKE_LOG"] = str(self.dir / "fake.log")
        self.addCleanup(os.environ.pop, "FAKE_LOG", None)
        self.elf = self.dir / "guest.elf"
        self.elf.write_bytes(b"elf")
        self.emu = pc.Emulator(FAKE, str(self.elf))
        self.budgets = pc.Budgets(max_steps=1000, timeout=5, max_input_bytes=1000, max_codes=3, max_code_bytes=100)

    def files(self, line="steps=500", pad=0, codes=("60",)):
        i = self.dir / "input.bin"
        i.write_text(line + "\n" + "x" * pad)
        w = self.dir / "witness.json"
        w.write_text(json.dumps({"state": [], "codes": ["0x" + c for c in codes], "keys": [], "headers": []}))
        return i, w

    def verdict(self, line="steps=500", pad=0, codes=("60",), budgets=None):
        i, w = self.files(line, pad, codes)
        return pc.evaluate(self.emu, budgets or self.budgets, i, w)

    def emulated(self):
        p = Path(os.environ["FAKE_LOG"])
        return p.read_text().count("ziskemu") if p.exists() else 0


class TestVerdicts(Case):
    def test_pass(self):
        v = self.verdict("steps=1000")
        self.assertTrue(v.ok)
        self.assertEqual((v.steps, v.codes, v.code_bytes), (1000, 1, 1))
        self.assertGreater(v.input_bytes, 0)
        self.assertEqual(sorted(v.fields()), ["codeBytes", "codes", "cost", "inputBytes", "predictedSeconds", "seconds", "steps", "verdict"])
        self.assertEqual((v.cost, round(v.predicted, 3)), (3000, 15.0))

    def test_over_steps(self):
        v = self.verdict("steps=1001")
        self.assertEqual((v.verdict, v.steps), (pc.STEPS, 1001))
        self.assertIn("over the proving budget", v.reason())

    def test_over_time_kills_the_whole_process_group(self):
        child = self.dir / "child.pid"
        b = pc.Budgets(max_steps=1000, timeout=0.5, max_input_bytes=1000, max_codes=3, max_code_bytes=100)
        t = time.monotonic()
        v = self.verdict(f"steps=5 sleep=20 child={child}", budgets=b)
        self.assertEqual(v.verdict, pc.TIME)
        self.assertLess(time.monotonic() - t, 10)
        pid = int(child.read_text())
        time.sleep(0.3)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_over_input_bytes_is_not_emulated(self):
        v = self.verdict(pad=1200)
        self.assertEqual(v.verdict, pc.INPUT_BYTES)
        self.assertEqual(self.emulated(), 0)

    def test_over_code_count(self):
        v = self.verdict(codes=("60", "61", "62", "63"))
        self.assertEqual((v.verdict, v.codes), (pc.CODES, 4))
        self.assertEqual(self.emulated(), 0)

    def test_the_same_code_twice_counts_once(self):
        self.assertTrue(self.verdict(codes=("60", "60", "61", "62")).ok)

    def test_over_code_bytes(self):
        v = self.verdict(codes=("ab" * 60, "cd" * 60))
        self.assertEqual((v.verdict, v.code_bytes), (pc.CODE_BYTES, 120))

    def test_guest_abort_on_heap(self):
        v = self.verdict("abort=heap")
        self.assertEqual(v.verdict, pc.GUEST)
        self.assertIn("OOM", v.detail)

    def test_guest_failure(self):
        self.assertEqual(self.verdict("abort=fail").verdict, pc.GUEST)

    def test_over_the_predicted_proof_time(self):
        b = pc.Budgets(max_steps=10**9, timeout=5, max_input_bytes=1000, max_codes=3, max_code_bytes=100, budget_seconds=120)
        self.assertTrue(self.verdict("steps=5 cost=%d" % int(105 * pc.DEFAULT_COST_PER_SECOND), budgets=b).ok)
        v = self.verdict("steps=5 cost=%d" % int(106 * pc.DEFAULT_COST_PER_SECOND), budgets=b)
        self.assertEqual(v.verdict, pc.COST)
        self.assertAlmostEqual(v.predicted, 121, delta=0.01)
        self.assertIn("predicted proof time", v.reason())

    def test_the_real_report_is_read(self):   # a shortened copy of the output of `ziskemu -X` (ZisK 1.3.1) on an honest block
        out = (HERE / "fixtures" / "ziskemu-x-report.out").read_text()
        self.assertEqual(pc.parse_steps(out), 6752005)
        self.assertEqual(pc.parse_cost(out), 1157634907)

    def test_the_report_at_the_step_cap_is_read(self):   # `-X -n 1000`: the report, then the error line
        out = (HERE / "fixtures" / "ziskemu-step-cap.out").read_text()
        self.assertEqual(pc.parse_steps(out), 1000)
        self.assertEqual(pc.parse_cost(out), 287687250)
        self.assertIn(pc.STEP_CAP_MARKER, out)

    def test_figures_are_read_from_line_starts_only(self):
        self.assertEqual(pc.parse_steps("STEPS: 1,234"), 1234)   # a colon is tolerated
        self.assertIsNone(pc.parse_steps("no figure here"))
        self.assertIsNone(pc.parse_steps("MAX STEPS 12"))
        self.assertIsNone(pc.parse_cost("no figure here"))
        self.assertIsNone(pc.parse_cost("TOTAL 5 99.00%"))   # only the TOTAL line that is 100 %
        self.assertIsNone(pc.parse_cost("cost_total: 1,234,567"))   # the invented layout is not the real one

    def test_the_emulator_is_stopped_one_step_past_the_budget(self):
        b = pc.Budgets(max_steps=500, timeout=5, max_input_bytes=1000, max_codes=3, max_code_bytes=100, budget_seconds=120)
        self.assertTrue(self.verdict("steps=500", budgets=b).ok)
        v = self.verdict("steps=501", budgets=b)   # the cap is 501: the emulator stops, prints its report and the cap error: a verdict, not a failure
        self.assertEqual((v.verdict, v.steps), (pc.STEPS, 501))
        self.assertIn("steps", v.reason())
        v = self.verdict("steps=900000", budgets=b)
        self.assertEqual((v.verdict, v.steps), (pc.STEPS, 501))

    def test_another_exit_one_is_still_a_service_failure(self):
        with self.assertRaisesRegex(pc.PrecheckFailed, "exit 1"):
            self.verdict("abort=rc1")

    def test_the_emulator_is_started_with_the_cost_flag(self):
        self.assertTrue(self.verdict().ok)   # the stand-in prints the cost figure only for -X, and a run without it would be a service failure
        self.assertEqual(self.emulated(), 1)

    def test_an_emulator_killed_by_a_signal_is_a_service_failure_not_a_verdict(self):
        with self.assertRaisesRegex(pc.PrecheckFailed, "signal 9"):
            self.verdict("abort=kill")

    def test_an_emulator_that_prints_no_figures_is_a_service_failure(self):
        with self.assertRaisesRegex(pc.PrecheckFailed, "no steps figure"):
            self.verdict("abort=nosteps")
        self.emu = pc.Emulator("true", str(self.elf))
        with self.assertRaises(pc.PrecheckFailed):
            self.verdict()

    def test_an_emulator_that_crashes_without_a_guest_message_is_a_service_failure(self):
        with self.assertRaisesRegex(pc.PrecheckFailed, "exit 3"):
            self.verdict("abort=crash")

    def test_an_interrupt_kills_the_emulator_group(self):
        child = self.dir / "child.pid"
        i, _ = self.files(f"steps=5 sleep=20 child={child}")
        import threading
        real = pc.subprocess.Popen.communicate
        def boom(self_, *a, **k):
            for _ in range(100):   # let the stand-in start its helper
                if child.exists() and child.read_text().strip():
                    break
                time.sleep(0.05)
            raise KeyboardInterrupt
        pc.subprocess.Popen.communicate = boom
        try:
            with self.assertRaises(KeyboardInterrupt):
                pc.run_emulator(self.emu, i, 30, 10**9)
        finally:
            pc.subprocess.Popen.communicate = real
        pid = int(child.read_text())
        time.sleep(0.3)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_input_tool_refused(self):
        def refuse():
            raise pc.InputToolFailed("Response is too big")
        v = pc.check_block(self.emu, self.budgets, refuse)
        self.assertEqual(v.verdict, pc.INPUT_TOOL)
        self.assertIn("too big", v.reason())
        self.assertFalse(v.ok)

    def test_check_block_runs_the_input_tool_then_the_checks(self):
        i, w = self.files()
        self.assertTrue(pc.check_block(self.emu, self.budgets, lambda: (i, w)).ok)

    def test_missing_emulator_is_a_clear_start_error(self):
        with self.assertRaisesRegex(pc.PrecheckError, "emulator.*not found"):
            pc.check_start(pc.Emulator(str(self.dir / "nope"), str(self.elf)))
        with self.assertRaisesRegex(pc.PrecheckError, "guest ELF"):
            pc.check_start(pc.Emulator(FAKE, str(self.dir / "no.elf")))
        pc.check_start(self.emu)

    def test_defaults(self):
        b = pc.Budgets()
        self.assertEqual((b.max_steps, b.timeout, b.max_input_bytes, b.max_codes, b.max_code_bytes),
                         (1_000_000_000, 40.0, 64 * 1024 * 1024, 1000, 24 * 1024 * 1024))
        self.assertEqual((b.budget_seconds, b.cost_intercept, round(1 / b.cost_per_second, 12)), (120.0, 15.0, 3.64e-9))


def verdict_of(ok, why=pc.STEPS):
    return pc.Verdict() if ok else pc.Verdict(why, detail="x")


class TestSelect(unittest.TestCase):
    """The search is a pure function over a callback, so these use plain lists: a transaction is a number."""

    def run_select(self, txs, fits, **kw):
        calls = []

        def check(items):
            calls.append(len(items))
            return verdict_of(fits(items))
        return pc.select(txs, check, **kw), calls

    def test_all_fit_is_one_check(self):
        s, calls = self.run_select(list(range(10)), lambda items: True)
        self.assertEqual((s.kept, s.waiting, s.convicted, calls), (list(range(10)), [], [], [10]))

    def test_cut_to_the_longest_prefix(self):
        for limit in range(1, 17):
            s, calls = self.run_select(list(range(16)), lambda items: len(items) <= limit)
            self.assertEqual(s.kept, list(range(limit)), limit)
            self.assertEqual(s.waiting, list(range(limit, 16)))
            self.assertEqual(s.convicted, [])
            self.assertLessEqual(len(calls), 6)

    def test_by_weight(self):
        s, _ = self.run_select([5, 5, 5, 5, 5, 5], lambda items: sum(items) <= 17)
        self.assertEqual((len(s.kept), len(s.waiting)), (3, 3))

    def test_a_lone_transaction_is_convicted_and_the_rest_go_on(self):
        s, _ = self.run_select(list("abcde"), lambda items: "b" not in items)   # not the first, yet convicted in this same block
        self.assertEqual((s.kept, s.waiting, [t for t, _ in s.convicted]), (["a"], list("cde"), ["b"]))
        s, _ = self.run_select(list("abcde"), lambda items: "a" not in items)
        self.assertEqual((s.kept, s.waiting), (list("bcde"), []))
        self.assertEqual([t for t, _ in s.convicted], ["a"])
        self.assertFalse(s.convicted[0][1].ok)
        self.assertIn("over the proving budget", s.convicted[0][1].reason())

    def test_a_lone_offender_in_the_middle_is_convicted_in_that_block(self):
        s, calls = self.run_select(list("abcde"), lambda items: "c" not in items)
        self.assertEqual((s.kept, s.waiting, [t for t, _ in s.convicted]), (list("ab"), list("de"), ["c"]))
        self.assertEqual(calls[-1], 1)   # one extra check: the transaction after the cut, alone
        self.assertFalse(s.convicted[0][1].ok)

    def test_the_first_after_the_offender_is_not_blamed_when_it_fits_alone(self):
        s, _ = self.run_select(list("T1 B T2 T3".split()), lambda items: "B" not in items)
        self.assertEqual((s.kept, s.waiting, [t for t, _ in s.convicted]), (["T1"], ["T2", "T3"], ["B"]))
        s, _ = self.run_select(list("T4 B T2 T3".split()), lambda items: "B" not in items)
        self.assertEqual((s.kept, [t for t, _ in s.convicted]), (["T4"], ["B"]))

    def test_the_offenders_later_transactions_wait_wherever_it_stands(self):
        s, _ = self.run_select([("a", 1), ("b", 1), ("a", 2), ("c", 1)], lambda items: ("b", 1) not in items,
                               dependents=lambda c, later: [t for t in later if t[0] == c[0]])
        self.assertEqual((s.kept, s.waiting, [t for t, _ in s.convicted]), ([("a", 1)], [("a", 2), ("c", 1)], [("b", 1)]))

    def test_the_transaction_after_the_cut_is_not_tried_alone_when_a_kept_one_has_its_sender(self):
        same = lambda c, later: [t for t in later if t[0] == c[0]]
        calls = []

        def check(items):
            calls.append(list(items))
            return verdict_of(len(items) <= 2)
        txs = [("a", 0), ("a", 1), ("a", 2)]
        s = pc.select(txs, check, dependents=same)
        self.assertEqual((s.kept, s.waiting, s.convicted), (txs[:2], txs[2:], []))
        self.assertNotIn([("a", 2)], calls)   # a lone ("a", 2) would be refused for its nonce: it is not asked
        # another sender's transaction after the cut is still tried alone
        s = pc.select([("a", 0), ("a", 1), ("b", 0)], lambda items: verdict_of(("b", 0) not in items), dependents=same)
        self.assertEqual(([t for t, _ in s.convicted], s.kept), ([("b", 0)], [("a", 0), ("a", 1)]))

    def test_a_transaction_reth_cannot_build_alone_waits_when_it_is_not_first(self):
        def check(items):   # only a block that starts with "a" can be built; "c" fits no budget
            if items[0] != "a":
                return pc.Verdict(pc.UNBUILDABLE, detail="x")
            return verdict_of(len(items) <= 2)
        s = pc.select(list("abcd"), check)
        self.assertEqual((s.kept, s.waiting, s.convicted), (list("ab"), list("cd"), []))
        # not first after a conviction either: "b" cannot be built without "a", which is convicted, so it waits; "c" goes on
        def check2(items):
            if items == ["a"] or "a" in items:
                return pc.Verdict(pc.GUEST, detail="x")
            return pc.Verdict(pc.UNBUILDABLE, detail="x") if items[0] == "b" else pc.Verdict()
        s = pc.select(list("abc"), check2)
        self.assertEqual(([t for t, _ in s.convicted], s.kept, s.waiting), (["a"], list("c"), list("b")))
        # the block's first: reth just built it first on this parent, so a refusal is reth's fault, not the transaction's; nobody is blamed
        with self.assertRaises(pc.PrecheckFailed):
            pc.select(list("ab"), lambda items: pc.Verdict(pc.UNBUILDABLE, detail="x"))

    def test_a_pair_bad_only_together_is_not_convicted_by_the_extra_check(self):
        s, _ = self.run_select(list("abcde"), lambda items: not ("b" in items and "c" in items))
        self.assertEqual((s.kept, s.waiting, s.convicted), (list("ab"), list("cde"), []))

    def test_everything_convicted(self):
        s, _ = self.run_select([1, 2, 3], lambda items: False)
        self.assertEqual((s.kept, s.waiting, [t for t, _ in s.convicted]), ([], [], [1, 2, 3]))

    def test_bad_only_together_land_in_separate_blocks(self):
        # each of x and y passes alone; together they do not
        def fits(items):
            return not ("x" in items and "y" in items)
        txs = ["a", "x", "b", "c", "y", "d"]
        s, _ = self.run_select(txs, fits)
        self.assertEqual(s.kept, ["a", "x", "b", "c"])
        self.assertEqual(s.waiting, ["y", "d"])
        self.assertEqual(s.convicted, [])
        s2, _ = self.run_select(s.waiting, fits)
        self.assertEqual((s2.kept, s2.waiting), (["y", "d"], []))

    def test_bad_together_next_to_each_other(self):
        s, _ = self.run_select(["x", "y"], lambda items: not ("x" in items and "y" in items))
        self.assertEqual((s.kept, s.waiting, s.convicted), (["x"], ["y"], []))

    def test_a_limit_on_checks_keeps_what_is_known_to_fit(self):
        s, calls = self.run_select(list(range(64)), lambda items: len(items) <= 5, max_checks=3)
        self.assertTrue(s.exhausted)
        self.assertEqual(len(calls), 3)
        self.assertEqual(s.kept + s.waiting, list(range(64)))
        self.assertEqual(s.kept, [])   # checks of 64, 32, 16: none fit
        s, _ = self.run_select(list(range(64)), lambda items: len(items) <= 20, max_checks=4)
        self.assertEqual((len(s.kept), len(s.waiting)), (16, 48))

    def test_the_checks_of_one_cut_are_bounded_by_the_block_size(self):
        s, calls = self.run_select(list(range(200)), lambda items: False)   # every transaction is over budget alone
        self.assertTrue(s.exhausted)
        self.assertLessEqual(len(calls), 2 * 8 + 4)
        self.assertEqual(s.kept, [])
        self.assertEqual(len(s.convicted) + len(s.waiting), 200)

    def test_a_time_limit_keeps_the_longest_prefix_known_to_fit(self):
        now = [0.0]

        def check(items):
            now[0] += 100   # each check takes 100 s
            return verdict_of(len(items) <= 10)
        s = pc.select(list(range(64)), check, max_seconds=250, clock=lambda: now[0])
        self.assertTrue(s.exhausted)
        self.assertEqual(s.checks, 3)   # 64, 32 and 16 are over; the next would start at 300 s
        self.assertEqual(s.kept + s.waiting, list(range(64)))

    def test_empty(self):
        s, calls = self.run_select([], lambda items: False)
        self.assertEqual((s.kept, s.waiting, s.convicted, calls), ([], [], [], []))

    def test_longest_prefix_on_its_own(self):
        self.assertEqual(pc.longest_prefix(8, lambda k: verdict_of(k <= 3))[0], 3)
        self.assertEqual(pc.longest_prefix(8, lambda k: verdict_of(True)), (8, None))


if __name__ == "__main__":
    unittest.main()
