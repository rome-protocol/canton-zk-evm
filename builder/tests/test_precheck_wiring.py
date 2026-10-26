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
from test_pipeline import A
from fakes import HEAD_HASH, HEAD_NUMBER, RpcError, hash_of, raw_of, tx

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
        self.assertEqual(verdicts, [(3, "steps"), (1, "ok"), (2, "ok"), (1, "ok")])   # the last: the transaction after the cut, alone
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

    def test_the_block_that_goes_on_is_the_block_that_was_checked(self):
        # the clock moves a second at every build: a block built again for the kept prefix must still be the one whose check passed
        ticks = iter(range(10**6))
        real = b.time.time
        b.time.time = lambda: real() + next(ticks)
        self.addCleanup(setattr, b.time, "time", real)
        s, ts, result = self.run_three()
        self.assertEqual(result["transactions"], [t["hash"] for t in ts[:2]])
        two = [x for x in self.lines(s, "precheck") if x["transactions"] == 2 and x["verdict"] == "ok"]
        self.assertEqual(result["blockHash"], two[-1]["block"])

    def test_a_lone_offender_in_the_middle_is_left_out_in_that_block(self):
        ts, plan = self.three((0, 300, 0))
        s = self.checked(self.setup({t["from"]: [t] for t in ts}), plan)
        result = self.block(s)
        self.assertEqual(result["transactions"], [ts[0]["hash"]])
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [ts[1]["hash"]])
        self.assertEqual(self.in_pool(s), {ts[1]["hash"], ts[2]["hash"]})   # both are back in the pool; the producer holds the convicted one

    def test_an_emulator_killed_by_a_signal_blames_nobody(self):
        for word in ("kill", "nosteps", "crash"):
            ts, plan = self.three()
            s = self.checked(self.setup({t["from"]: [t] for t in ts}), {t["hash"]: {"steps": 100, "abort": word} for t in ts})
            with self.assertRaises(b.BuilderError) as e:
                self.block(s)
            self.assertIn("pre-check could not run", str(e.exception), word)
            self.assertEqual(self.in_pool(s) | {x["transaction"] for x in getattr(e.exception, "lost_transactions", [])}, {t["hash"] for t in ts}, word)
            self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH, word)   # reth is back on Canton's head

    def test_a_reth_error_in_a_trial_build_blames_nobody(self):
        ts, plan = self.three()
        s = self.checked(self.setup({t["from"]: [t] for t in ts}), plan)
        real, calls = s.reth._rpc, []
        def flaky(method, params):
            if method == "txpool_content":
                calls.append(1)
                if len(calls) > 1:   # the first is the block's own build; the next is a trial's
                    raise RpcError("reth is busy")
            return real(method, params)
        s.reth._rpc = flaky
        with self.assertRaises(b.BuilderError):
            self.block(s)
        self.assertEqual(self.lines(s, "precheck_cut"), [])

    def test_the_input_of_a_block_that_passes_is_made_once(self):
        ts, plan = self.three()
        s = self.checked(self.setup({t["from"]: [t] for t in ts}), plan, max_steps=10**6)
        real, seen = s.reth._rpc, []
        s.reth._rpc = lambda method, params: (seen.append(method), real(method, params))[1]
        self.assertTrue(self.block(s)["committed"])
        self.assertEqual(seen.count("debug_executionWitness"), 1)
        self.assertEqual(list(Path(s.cfg.work_dir).glob("block-*/precheck-*")), [])

    def test_a_stale_precheck_folder_is_removed(self):
        ts, plan = self.three()
        s = self.checked(self.setup({t["from"]: [t] for t in ts}), plan)
        old = Path(s.cfg.work_dir) / f"block-{FIRST}" / "precheck-1-2"
        old.mkdir(parents=True)
        (old / "input.bin").write_bytes(b"x")
        self.block(s)
        self.assertFalse(old.exists())

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
                         (7, 40.0, 64 * 1024 * 1024, 1000, 24 * 1024 * 1024))
        self.assertEqual((setup.budgets.budget_seconds, setup.budgets.cost_intercept, setup.max_seconds), (120.0, 15.0, 300.0))


class SameSender(Checked, tb.Case):
    """A cut between two transactions of one sender: reth enforces nonces (a later one cannot be built without the earlier ones), so the
    transaction after the cut cannot be tried alone, and nobody is convicted for it."""

    def three_of_alice(self, plan=None, **budgets):
        ts = [tx(ALICE, n, price=30) for n in range(3)]
        s = self.checked(self.setup({ALICE: ts}), {t["hash"]: v for t, v in zip(ts, plan or [None] * 3) if v}, **budgets)
        s.reth.enforce_nonces = True
        return s, ts

    def test_one_senders_transactions_cut_between_two_nothing_is_convicted_and_the_last_lands_next(self):
        s, ts = self.three_of_alice()
        first = self.block(s)
        self.assertTrue(first["committed"], first)
        self.assertEqual(first["transactions"], [t["hash"] for t in ts[:2]])
        self.assertEqual(first["leftOut"], [])
        (cut,) = self.lines(s, "precheck_cut")
        self.assertEqual((cut["kept"], cut["convicted"], cut["waiting"]), (2, [], [ts[2]["hash"]]))
        self.assertNotIn("input_tool", [x["verdict"] for x in self.lines(s, "precheck")])
        self.assertNotIn("unbuildable", [x["verdict"] for x in self.lines(s, "precheck")])
        self.assertEqual(self.in_pool(s), {ts[2]["hash"]})
        second = self.block(s)
        self.assertTrue(second["committed"], second)
        self.assertEqual(second["transactions"], [ts[2]["hash"]])

    def test_a_lone_offender_behind_its_senders_earlier_one_is_convicted_once_that_is_mined(self):
        s, ts = self.three_of_alice([None, None, {"steps": 300}])
        first = self.block(s)
        self.assertEqual((first["transactions"], first["leftOut"]), ([t["hash"] for t in ts[:2]], []))
        second = self.block(s)   # alone and first now: over the budget by itself
        self.assertEqual(second["transactions"], [])
        (left,) = second["leftOut"]
        self.assertEqual(left["transaction"], ts[2]["hash"])
        self.assertTrue(left["overBudget"])


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


    def test_a_transaction_convicted_again_is_held_twice_as_long_up_to_a_day(self):
        ts, plan = self.three((300, 0, 0))
        p = self.producer(self.checked(self.setup({t["from"]: [t] for t in ts}), plan))
        x = {"transaction": ts[0]["hash"], "reason": "over the proving budget: x", "overBudget": True}
        held = []
        for _ in range(14):
            p.hold_over_budget([x], 1000.0)
            held.append(p.excluded.pop(x["transaction"]) - 1000.0)
        self.assertEqual(held[:4], [p.cooldown * k for k in (1, 2, 4, 8)])
        self.assertEqual(held[-1], max(p.cooldown, 86400))


class InFlight(Checked, tp.Depth):
    def test_the_pipeline_cuts_a_block_and_holds_the_convicted_one(self):
        ts, plan = self.three((300, 0, 0))
        s = self.checked(self.setup({t["from"]: [t] for t in ts}), plan)
        p = self.pipeline(s, 2)
        self.drive(p, lambda: ts[0]["hash"] in p.excluded and p.flight)
        self.assertIn("over the proving budget", p.excluded_why[ts[0]["hash"]])
        self.assertEqual([x["event"] for x in self.lines(s, "precheck_cut")], ["precheck_cut"])
        self.assertNotIn(ts[0]["hash"], {t["hash"] for t in p.flight[0].built.chosen})

    def test_a_cut_on_top_of_a_block_in_flight(self):
        DAVE = "0x" + "dd" * 20
        s = self.checked(self.setup({}))   # every transaction is 100 steps; the budget is 250
        self.script(A, "sleep 3")   # the first block's proof is slow: the second block is built on it while it is in flight
        p = self.pipeline(s, 2)
        s.reth.pool[ALICE] = [tx(ALICE, 0, price=30)]
        self.drive(p, lambda: len(self.lines(s, "cut")) == 1)
        later = [tx(BOB, 0, price=30), tx(CAROL, 0, price=20), tx(DAVE, 0, price=10)]
        for t in later:
            s.reth.pool[t["from"]] = [t]
        self.drive(p, lambda: len(self.committed()) == 3)
        first, second, third = [r for r in self.reports if r.get("committed")][:3]
        self.assertEqual(second["transactions"], [t["hash"] for t in later[:2]])   # cut back to two of the three
        self.assertEqual(third["transactions"], [later[2]["hash"]])   # the third waited in the pool and went into the next block
        self.assertEqual(second["leftOut"], [])
        (cut,) = self.lines(s, "precheck_cut")
        self.assertEqual((cut["kept"], cut["convicted"], cut["waiting"]), (2, [], [later[2]["hash"]]))
        # the prefix was built on the block in flight, never on Canton's head
        self.assertEqual(s.reth.blocks[second["blockHash"]]["parent"], first["blockHash"])
        heads = [q[0]["headBlockHash"] for m, q in s.reth.engine_calls if m == "engine_forkchoiceUpdatedV3"]
        built_first = heads.index(first["blockHash"])
        self.assertNotIn(HEAD_HASH, heads[built_first:], "reth went below the block in flight")
        self.assert_final_never_back(s)


if __name__ == "__main__":
    unittest.main()
