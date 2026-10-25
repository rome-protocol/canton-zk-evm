"""--target-gas-limit: the builder asks reth to move the block gas limit toward a target, never past the chain's gasCap. Without it the calls to reth
are exactly what they were. Run: python3 -m unittest discover -s builder/tests"""
import json, sys, threading, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from fakes import tx

ALICE = tb.ALICE
CAP = 30_000_000


class Target(tb.Case):
    def attributes(self, s):
        return [p[1] for m, p in s.reth.ws_calls if m == "testing_buildBlockV1"]

    def test_default_is_none_and_no_attribute_is_sent(self):
        self.assertEqual(b.Config.__dataclass_fields__["target_gas_limit"].default, 0)
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        self.assertTrue(b.build_block(s.cfg)["committed"])
        (attrs,) = self.attributes(s)
        self.assertNotIn("targetGasLimit", attrs)
        self.assertEqual(b.targeting(s.cfg, CAP), {})

    def test_a_target_under_the_cap_is_sent_as_hex(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, gas_cap=CAP)
        s.cfg.target_gas_limit = 20_000_000
        self.assertTrue(b.build_block(s.cfg)["committed"])
        (attrs,) = self.attributes(s)
        self.assertEqual(attrs["targetGasLimit"], hex(20_000_000))
        self.assertEqual(b.targeting(s.cfg, CAP), {"target_gas_limit": 20_000_000})

    def test_a_target_over_the_cap_is_held_at_the_cap_and_journaled(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, gas_cap=CAP)
        s.cfg.target_gas_limit = 60_000_000
        self.assertTrue(b.build_block(s.cfg)["committed"])
        (attrs,) = self.attributes(s)
        self.assertEqual(attrs["targetGasLimit"], hex(CAP))
        self.assertEqual(b.targeting(s.cfg, CAP), {"target_gas_limit": CAP, "target_gas_limit_asked": 60_000_000, "target_gas_limit_clamped_to_cap": True})

    def test_the_cap_is_read_again_for_every_block(self):
        s = self.setup({ALICE: [tx(ALICE, 0), tx(ALICE, 1)]}, gas_cap=CAP)
        s.cfg.target_gas_limit = 60_000_000
        self.assertTrue(b.build_block(s.cfg)["committed"])
        s.ledger.gas_cap = 45_000_000   # Canton's record changes between the blocks
        self.assertTrue(b.build_block(s.cfg)["committed"])
        first, second = [a["targetGasLimit"] for a in self.attributes(s)]
        self.assertEqual((first, second), (hex(CAP), hex(45_000_000)))

    def test_the_budget_follows_the_limit_reth_will_build(self):
        parent = 30_000_000
        step = parent // 1024 - 1
        mk = lambda target: type("C", (), {"target_gas_limit": target})()
        self.assertEqual(b.budget_for(mk(0), CAP, parent), parent)   # no target: as it always was
        self.assertEqual(b.budget_for(mk(60_000_000), CAP, parent), parent)   # rising: the parent's limit, the most a block can start from
        self.assertEqual(b.budget_for(mk(parent), CAP, parent), parent)
        self.assertEqual(b.budget_for(mk(20_000_000), CAP, parent), parent - step)   # falling: one step under the parent's limit
        self.assertEqual(b.budget_for(mk(parent - 5), CAP, parent), parent - 5)   # the target is closer than a step
        self.assertEqual(b.budget_for(mk(0), 25_000_000, parent), 25_000_000)   # the cap still holds it
        self.assertEqual(b.budget_for(mk(20_000_000), 25_000_000, parent), 25_000_000)

    def test_the_built_line_names_the_target_only_when_one_is_set(self):
        for target, fields in ((0, {}), (20_000_000, {"target_gas_limit": 20_000_000}),
                               (60_000_000, {"target_gas_limit": CAP, "target_gas_limit_asked": 60_000_000, "target_gas_limit_clamped_to_cap": True})):
            s = self.setup({ALICE: [tx(ALICE, 0)]}, gas_cap=CAP)
            s.cfg.target_gas_limit = target
            attempt = tb.Attempts()
            self.assertTrue(b.build_block(s.cfg, journal=attempt)["committed"])
            (built,) = [f for n, f in attempt.events if n == "built"]
            self.assertEqual({k: v for k, v in built.items() if k.startswith("target_gas_limit")}, fields)

    def test_the_run_settings_name_the_target_only_when_one_is_set(self):
        s = self.setup({})
        mk = lambda: b.Producer(s.cfg, threading.Event(), idle=0.5, status_file=str(Path(s.dir) / "status.json"), emit=lambda r: None).settings
        self.assertNotIn("target_gas_limit", mk())
        s.cfg.target_gas_limit = 60_000_000
        self.assertEqual(mk()["target_gas_limit"], 60_000_000)


class CommandLine(tb.Case):
    run_main = tb.CommandLine.run_main

    def test_the_flag_reaches_reth(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, gas_cap=CAP)
        code, out = self.run_main(s, "--target-gas-limit", "25000000")
        self.assertEqual((code, out["committed"]), (0, True))
        (attrs,) = [p[1] for m, p in s.reth.ws_calls if m == "testing_buildBlockV1"]
        self.assertEqual(attrs["targetGasLimit"], hex(25_000_000))

    def test_without_the_flag_nothing_is_sent(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        code, out = self.run_main(s)
        self.assertEqual(code, 0)
        (attrs,) = [p[1] for m, p in s.reth.ws_calls if m == "testing_buildBlockV1"]
        self.assertNotIn("targetGasLimit", attrs)

    def test_a_target_under_one_is_refused(self):
        for bad in ("0", "-5", "many"):
            code, out = self.run_main(self.setup({}), "--target-gas-limit", bad)
            self.assertEqual(code, 1)
            self.assertIn("bad arguments", out["error"] if "error" in out else json.dumps(out))


if __name__ == "__main__":
    unittest.main()
