"""The pre-check in the builder (README.md, "Pre-check"): each block is run in a stand-in emulator before it is proven, and one over the budgets
is cut back to the longest prefix that fits. The stand-in's steps per transaction are set by FAKE_TX_PLAN (fake-make-input-sized.sh): 100 unless
the plan says otherwise, and the budget here is 250 steps.
Run: python3 -m unittest discover -s builder/tests"""
import json, os, shutil, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import precheck as pc
import test_builder as tb
import test_pipeline as tp
from test_producer import Loop
from fakes import HEAD_NUMBER, hash_of, raw_of, tx

ALICE, BOB, CAROL = tb.ALICE, tb.BOB, tb.CAROL
FIRST = HEAD_NUMBER + 1


class Checked:
    """A mixin: a setup whose input tool and emulator are the sized stand-ins, with the pre-check on."""

    def checked(self, s, plan=None, **budgets):
        work = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(work, ignore_errors=True))
        (work / "steps").mkdir()
        (work / "plan.json").write_text(json.dumps(plan or {}))
        elf = work / "guest.elf"
        elf.write_bytes(b"elf")
        for k, v in {"FAKE_STEPS_DIR": str(work / "steps"), "FAKE_TX_PLAN": str(work / "plan.json")}.items():
            os.environ[k] = v
            self.addCleanup(os.environ.pop, k, None)
        s.cfg.make_input_cmd = str(HERE / "fake-make-input-sized.sh")
        s.cfg.precheck = pc.Precheck(pc.Emulator(str(HERE / "fake-ziskemu-block.sh"), str(elf)),
                                     pc.Budgets(**{"max_steps": 250, "timeout": 5, "max_input_bytes": 10_000, "max_codes": 5, "max_code_bytes": 1000, **budgets}))
        return s

    def lines(self, s, name):
        out = []
        for f in sorted((Path(s.cfg.work_dir) / "journal").glob("*.jsonl")):
            out += [json.loads(x) for x in f.read_text().splitlines()]
        return [x for x in out if x["event"] == name]

    def block(self, s, **k):
        journal = b.Journal(Path(s.cfg.work_dir) / "journal")
        return b.build_block(s.cfg, journal=b.Attempt(journal, 1), **k)

    def three(self, steps=None, prices=(30, 20, 10)):
        """One transaction each from three senders, best price first; `steps` is the plan: sender index -> steps."""
        ts = [tx(x, 0, price=p) for x, p in zip((ALICE, BOB, CAROL), prices)]
        return ts, {t["hash"]: {"steps": n} for t, n in zip(ts, steps or ()) if n}


class Blocks(Checked, tb.Case):
    def run_three(self, steps=None, plan_extra=None, **budgets):
        ts, plan = self.three(steps)
        for t, extra in zip(ts, plan_extra or ()):
            if extra:
                plan[t["hash"]] = {**plan.get(t["hash"], {}), **extra}
        s = self.checked(self.setup({t["from"]: [t] for t in ts}), plan, **budgets)
        return s, ts, self.block(s)

    def test_a_block_within_the_budgets_goes_on_and_the_check_is_in_the_journal(self):
        s = self.checked(self.setup({ALICE: [tx(ALICE, 0)], BOB: [tx(BOB, 0)]}))
        result = self.block(s)
        self.assertTrue(result["committed"])
        self.assertEqual(len(result["transactions"]), 2)
        (line,) = self.lines(s, "precheck")
        self.assertEqual((line["verdict"], line["steps"], line["transactions"], line["codes"]), ("ok", 200, 2, 0))
        self.assertEqual(self.lines(s, "precheck_cut"), [])
        self.assertEqual(len(s.builds()), 1)   # no trial block: the block reth built is the one that was checked

    def test_a_block_over_the_steps_is_cut_by_halves_and_the_rest_wait(self):
        s, ts, result = self.run_three()
        self.assertTrue(result["committed"], result)
        self.assertEqual(result["transactions"], [t["hash"] for t in ts[:2]])
        self.assertEqual(result["leftOut"], [])
        self.assertEqual(self.in_pool(s), {ts[2]["hash"]})   # the rest wait in the pool for the next block
        (cut,) = self.lines(s, "precheck_cut")
        self.assertEqual((cut["kept"], cut["waiting"], cut["convicted"]), (2, [ts[2]["hash"]], []))
        verdicts = [(x["transactions"], x["verdict"]) for x in self.lines(s, "precheck")]
        self.assertEqual(verdicts, [(3, "steps"), (1, "ok"), (2, "ok")])
        self.assertNotIn("lostTransactions", result)

    def test_a_single_transaction_over_the_budget_is_left_out_with_a_reason(self):
        s, ts, result = self.run_three(steps=(300, 0, 0))
        self.assertTrue(result["committed"], result)
        self.assertEqual(result["transactions"], [t["hash"] for t in ts[1:]])
        (left,) = result["leftOut"]
        self.assertEqual(left["transaction"], ts[0]["hash"])
        self.assertTrue(left["overBudget"])
        self.assertIn("over the proving budget", left["reason"])
        self.assertIn("steps", left["reason"])
        (cut,) = self.lines(s, "precheck_cut")
        self.assertEqual(cut["convicted"], [ts[0]["hash"]])

    def test_a_convicted_transactions_later_ones_wait(self):
        a0, a1, bob = tx(ALICE, 0, price=30), tx(ALICE, 1, price=30), tx(BOB, 0, price=20)
        s = self.checked(self.setup({ALICE: [a0, a1], BOB: [bob]}), {a0["hash"]: {"steps": 300}})
        result = self.block(s)
        self.assertEqual(result["transactions"], [bob["hash"]])
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [a0["hash"]])
        self.assertIn(a1["hash"], self.in_pool(s))   # waits, and is not convicted

    def test_two_transactions_bad_only_together_land_in_separate_blocks(self):
        ts, _ = self.three()
        s = self.checked(self.setup({ALICE: [ts[0]], BOB: [ts[1]]}), {ts[0]["hash"]: {"steps": 150}, ts[1]["hash"]: {"steps": 150}})
        first = self.block(s)
        self.assertEqual((first["transactions"], first["leftOut"]), ([ts[0]["hash"]], []))
        second = self.block(s)
        self.assertEqual((second["transactions"], second["leftOut"]), ([ts[1]["hash"]], []))

    def test_a_check_over_time_kills_the_emulator_and_convicts(self):
        s, ts, result = self.run_three(plan_extra=({"sleep": 20}, None, None), timeout=0.5)
        self.assertEqual(result["transactions"], [t["hash"] for t in ts[1:]])
        self.assertIn("did not finish in time", result["leftOut"][0]["reason"])

    def test_an_input_over_the_byte_budget_is_over_budget(self):
        s = self.checked(self.setup({ALICE: [tx(ALICE, 0)]}), max_input_bytes=10)
        result = self.block(s)
        self.assertEqual(result["transactions"], [])   # the block is empty; it is proven as the empty block it is
        self.assertIn("input is bigger", result["leftOut"][0]["reason"])

    def test_more_code_loads_than_the_budget_cut_the_block(self):
        ts, _ = self.three()
        s = self.checked(self.setup({t["from"]: [t] for t in ts}), max_steps=10**6)   # two codes for every transaction, over 5 codes at three
        real = s.reth._rpc
        def witness(method, params):
            if method != "debug_executionWitness":
                return real(method, params)
            n = len(s.reth.block_txs.get(s.reth.by_number.get(int(params[0], 16)), []))
            return {"state": [], "codes": [f"0x60{i:02x}" for i in range(2 * n)], "keys": [], "headers": []}
        s.reth._rpc = witness
        result = self.block(s)
        self.assertEqual(result["transactions"], [t["hash"] for t in ts[:2]])
        self.assertEqual(self.lines(s, "precheck")[0]["verdict"], "codes")
        self.assertEqual(self.lines(s, "precheck")[0]["codes"], 6)

    def test_a_guest_abort_in_the_emulator_is_over_budget(self):
        s, ts, result = self.run_three(plan_extra=({"abort": "heap"}, None, None))
        self.assertEqual(result["transactions"], [t["hash"] for t in ts[1:]])
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [ts[0]["hash"]])
        self.assertIn("guest program fails", result["leftOut"][0]["reason"])

    def test_an_input_tool_that_refuses_the_block_is_over_budget(self):
        ts, plan = self.three()
        s = self.checked(self.setup({t["from"]: [t] for t in ts}), plan)
        os.environ["FAKE_INPUT_FAILS_FOR"] = ts[0]["hash"]
        self.addCleanup(os.environ.pop, "FAKE_INPUT_FAILS_FOR", None)
        result = self.block(s)
        self.assertEqual(result["transactions"], [t["hash"] for t in ts[1:]])
        self.assertIn("cannot make an input", result["leftOut"][0]["reason"])

    def test_with_the_switch_off_there_is_no_check(self):
        ts, plan = self.three()
        s = self.checked(self.setup({t["from"]: [t] for t in ts}), plan)
        s.cfg.precheck = None
        result = self.block(s)
        self.assertEqual(len(result["transactions"]), 3)
        self.assertEqual(self.lines(s, "precheck"), [])

    def test_a_missing_emulator_is_an_error_at_start(self):
        args = b.parser().parse_args(["once", "--precheck", "--ziskemu", "/nonexistent/ziskemu", "--guest-elf", str(HERE / "fake-prove.sh")])
        with self.assertRaises(b.BuilderError) as e:
            b.precheck_setup(args)
        self.assertIn("not found", str(e.exception))

    def test_the_defaults_are_the_plan_budgets(self):
        args = b.parser().parse_args(["once", "--precheck", "--ziskemu", str(HERE / "fake-ziskemu.sh"), "--guest-elf", str(HERE / "fake-prove.sh"),
                                      "--precheck-max-steps", "7"])
        setup = b.precheck_setup(args)
        self.assertEqual((setup.budgets.max_steps, setup.budgets.timeout, setup.budgets.max_input_bytes, setup.budgets.max_codes, setup.budgets.max_code_bytes),
                         (7, 20.0, 64 * 1024 * 1024, 1000, 24 * 1024 * 1024))


class Held(Checked, Loop):
    def test_the_producer_holds_a_convicted_transaction_with_the_reason(self):
        ts, plan = self.three((300, 0, 0))
        s = self.checked(self.setup({t["from"]: [t] for t in ts}), plan)
        p = self.producer(s)
        p.step()
        self.assertEqual([t for t in p.excluded], [ts[0]["hash"]])
        (held,) = self.status()["excluded"]
        self.assertEqual(held["transaction"], ts[0]["hash"])
        self.assertIn("over the proving budget", held["reason"])
        self.assertEqual([x["event"] for x in self.lines(s, "excluded")], ["excluded"])


class InFlight(Checked, tp.Depth):
    def test_the_pipeline_cuts_a_block_and_holds_the_convicted_one(self):
        ts, plan = self.three((300, 0, 0))
        s = self.checked(self.setup({t["from"]: [t] for t in ts}), plan)
        p = self.pipeline(s, 2)
        self.drive(p, lambda: ts[0]["hash"] in p.excluded and p.flight)
        self.assertIn("over the proving budget", p.excluded_why[ts[0]["hash"]])
        self.assertEqual([x["event"] for x in self.lines(s, "precheck_cut")], ["precheck_cut"])
        self.assertNotIn(ts[0]["hash"], {t["hash"] for t in p.flight[0].built.chosen})


if __name__ == "__main__":
    unittest.main()
