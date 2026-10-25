"""The prover pool in the builder's loop: --prover and --prove-timeout, the `prover` journal lines and the status file's `provers` list with two
or more provers, and nothing of them with one. The stand-in prover's answers are set per job (fake-prove.sh, FAKE_PROVER_PLAN)."""
import json, os, re, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import provers as pv
from test_producer import Loop, ALICE
from fakes import tx

A, B_ = "http://127.0.0.1:7001", "http://127.0.0.1:7002"


def tag(url: str) -> str:
    return re.sub(r"[^a-z0-9]", "_", url)


class Wiring(Loop):
    def setUp(self):
        self.plan = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.plan, ignore_errors=True))
        for k, v in {"FAKE_PROVER_PLAN": str(self.plan), "FAKE_LOG": str(self.plan / "fake.log")}.items():
            os.environ[k] = v
            self.addCleanup(os.environ.pop, k, None)

    def script(self, url, *lines):
        (self.plan / tag(url)).write_text("".join(f"{x}\n" for x in lines))

    def producer_with(self, s, specs, timeout=60):
        s.cfg.pool = b.new_pool(pv.parse_provers(specs, "fake-prove.sh"), timeout)
        return self.producer(s)

    def lines(self, s, kind):
        folder = Path(s.cfg.work_dir) / "journal"
        found = [json.loads(x) for f in sorted(folder.glob("*.jsonl")) for x in f.read_text().splitlines()]
        return [x for x in found if x.get("event") == kind or x.get("kind") == kind]

    def test_two_provers_a_failure_goes_to_the_other_and_the_block_commits(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        self.script(A, "fail")
        p = self.producer_with(s, [f"a={A}", f"b={B_}"])
        p.step()
        self.assertTrue(self.reports[-1]["committed"])
        ended = self.lines(s, "proof_ended")
        self.assertEqual((ended[-1]["prover"], ended[-1]["outcome"], ended[-1]["tried_first"]), ("b", "ok", ["a"]))
        self.assertEqual([x["prover"] for x in self.lines(s, "prover")], ["a"])
        self.assertEqual(self.lines(s, "prover")[0]["state"], "down")
        self.assertEqual({x["name"]: x["state"] for x in self.status()["provers"]}, {"a": "down", "b": "up"})

    def test_a_block_that_fails_on_both_is_a_failure_and_marks_no_prover_down(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        self.script(A, "fail")
        self.script(B_, "fail")
        p = self.producer_with(s, [f"a={A}", f"b={B_}"])
        p.step()
        self.assertFalse(self.reports[-1]["committed"])
        self.assertIn("every prover", self.reports[-1]["error"])
        self.assertEqual({x["state"] for x in self.status()["provers"]}, {"up"})
        self.assertEqual(self.lines(s, "prover"), [])

    def test_a_prover_that_hangs_is_given_up_at_the_timeout_and_the_other_proves_it(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        self.script(A, "hang")
        p = self.producer_with(s, [f"a={A}", f"b={B_}"], timeout=2)
        p.step()
        self.assertTrue(self.reports[-1]["committed"])
        self.assertEqual(self.lines(s, "proof_ended")[-1]["prover"], "b")

    def test_a_hang_with_one_prover_is_a_timeout_failure(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        self.script(A, "hang")
        p = self.producer_with(s, [f"a={A}"], timeout=2)
        p.step()
        self.assertFalse(self.reports[-1]["committed"])
        ended = self.lines(s, "proof_ended")[-1]
        self.assertEqual(ended["outcome"], "timeout")
        self.assertNotIn("provers", self.status())

    def test_one_prover_writes_no_prover_line_and_no_provers_list(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        p = self.producer_with(s, [f"a={A}"])
        p.step()
        self.assertTrue(self.reports[-1]["committed"])
        self.assertEqual(self.lines(s, "prover"), [])
        self.assertNotIn("provers", self.status())
        self.assertEqual(self.lines(s, "proof_ended")[-1]["prover"], "fake-prove.sh")
        self.assertIn(tag(A), (self.plan / "log").read_text())   # the one prover's URL still reached the prove command

    def test_no_provers_runs_the_prove_command_alone(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        p = self.producer(s)   # cfg.pool is None
        p.step()
        self.assertTrue(self.reports[-1]["committed"])
        self.assertNotIn("provers", self.status())
        self.assertEqual(self.lines(s, "prover"), [])

    def test_the_settings_name_the_provers_only_with_two_or_more(self):
        s = self.setup({})
        self.assertNotIn("provers", self.producer_with(s, [f"a={A}"]).settings)
        two = self.producer_with(s, [f"a={A}", f"b={B_}"], timeout=90)
        self.assertEqual((two.settings["provers"], two.settings["prove_timeout_seconds"]), (["a", "b"], 90))

    def test_the_arguments(self):
        ap = b.parser()
        a = ap.parse_args(["run", "--prover", f"a={A}", "--prover", f"b={B_}", "--prove-timeout", "90", "--prover-input-dir", "/x"])
        self.assertEqual((a.prover, a.prove_timeout, a.prover_input_dir), ([f"a={A}", f"b={B_}"], 90, "/x"))
        d = ap.parse_args(["run"])
        self.assertEqual((d.prover, d.prove_timeout), ([], pv.DEFAULT_TIMEOUT))
        with self.assertRaises(ValueError):
            pv.parse_provers(["a=nonsense"], "x")


if __name__ == "__main__":
    unittest.main()
