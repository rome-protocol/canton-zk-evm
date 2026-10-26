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
        self.assertEqual(sorted(v.fields()), ["codeBytes", "codes", "inputBytes", "seconds", "steps", "verdict"])

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

    def test_no_steps_line_is_not_a_pass(self):
        self.emu = pc.Emulator("true", str(self.elf))
        self.assertEqual(self.verdict().verdict, pc.GUEST)

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
                         (233_000_000, 20.0, 64 * 1024 * 1024, 1000, 24 * 1024 * 1024))


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
        s, _ = self.run_select(list("abcde"), lambda items: "b" not in items)
        self.assertEqual(s.kept, ["a"])
        self.assertEqual([t for t, _ in s.convicted], [])
        s, _ = self.run_select(list("abcde"), lambda items: "a" not in items)
        self.assertEqual((s.kept, s.waiting), (list("bcde"), []))
        self.assertEqual([t for t, _ in s.convicted], ["a"])
        self.assertFalse(s.convicted[0][1].ok)
        self.assertIn("over the proving budget", s.convicted[0][1].reason())

    def test_a_convicted_transaction_in_the_middle_waits_with_the_rest(self):
        s, _ = self.run_select(list("abcde"), lambda items: "c" not in items)
        self.assertEqual((s.kept, s.waiting, s.convicted), (list("ab"), list("cde"), []))
        # next block: c leads, is convicted on its own, d and e go on
        s, _ = self.run_select(list("cde"), lambda items: "c" not in items)
        self.assertEqual((s.kept, [t for t, _ in s.convicted]), (list("de"), ["c"]))

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

    def test_empty(self):
        s, calls = self.run_select([], lambda items: False)
        self.assertEqual((s.kept, s.waiting, s.convicted, calls), ([], [], [], []))

    def test_longest_prefix_on_its_own(self):
        self.assertEqual(pc.longest_prefix(8, lambda k: verdict_of(k <= 3))[0], 3)
        self.assertEqual(pc.longest_prefix(8, lambda k: verdict_of(True)), (8, None))


if __name__ == "__main__":
    unittest.main()
