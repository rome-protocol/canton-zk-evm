#!/usr/bin/env python3
"""Tests of deploy.py against a local chain (anvil), with throwaway keystores. Run by deploy-test.sh after `forge build`."""
import copy, importlib.util, json, os, shutil, socket, subprocess, tempfile, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEPLOY = HERE / "deploy.py"
PASSWORD = "throwaway-pass-9f2c"
GATEWAY, BRIDGE, TOKEN = "0x" + "a1" * 20, "0x" + "b2" * 20, "0x" + "c3" * 20
FEE_TO, REFUSER = "0x" + "d4" * 20, "0x" + "e5" * 20


def sh(*args, env=None):
    return subprocess.run(args, capture_output=True, text=True, env={**os.environ, **(env or {})})


class Local(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
        cls.url = f"http://127.0.0.1:{port}"
        cls.anvil = subprocess.Popen(["anvil", "--port", str(port), "--silent"])
        for _ in range(100):
            if sh("cast", "chain-id", "--rpc-url", cls.url).returncode == 0:
                break
            time.sleep(0.1)
        (cls.tmp / "pw").write_text(PASSWORD)
        cls.who = {}
        for name in ("deployer", "proposer", "other"):
            out = json.loads(sh("cast", "wallet", "new", str(cls.tmp), name, "--unsafe-password", PASSWORD, "--json").stdout)
            out = out[0] if isinstance(out, list) else out  # the shape differs between Foundry releases
            cls.who[name] = out["address"]
            sh("cast", "rpc", "anvil_setBalance", out["address"], "0x56BC75E2D63100000", "--rpc-url", cls.url)

    @classmethod
    def tearDownClass(cls):
        cls.anvil.terminate()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def config(self, **over):
        c = {
            "name": "test", "chainId": 770101, "localNetwork": 75, "gateway": GATEWAY, "bridge": BRIDGE,
            "settingsTimelock": {"minDelay": 300, "proposers": [self.who["proposer"]], "executors": [self.who["proposer"]]},
            "upgradeTimelock": None, "refuser": REFUSER, "feeRecipient": FEE_TO, "refundWait": 259200,
            "asset": {"address": TOKEN, "instrument": "0x" + "11" * 32, "feeOut": "500000000", "feeIn": "1000000000",
                      "feeRefund": "500000000", "minAmount": "1000000000", "lockCap": "100000000000"},
            "destinations": [{"network": 0, "unit": 1, "open": False}], "claimFees": [{"network": 0, "fee": "1500000000"}],
        }
        c.update(over)
        return c

    def run_deploy(self, *args, cfg=None, state=None, url=None, vectors=None):
        t = self.tmp
        cfg_path = t / f"cfg-{id(cfg)}.json"
        cfg_path.write_text(json.dumps(cfg or self.config()))
        a = ["python3", str(DEPLOY), "--config", str(cfg_path), "--state", str(state or t / "state.json"),
             "--deployer-keystore", str(t / "deployer"), "--deployer-password-file", str(t / "pw"),
             "--proposer-keystore", str(t / "proposer"), "--proposer-password-file", str(t / "pw")]
        if vectors:
            a += ["--vectors", str(vectors)]
        p = sh(*a, *args, env={"ROUTER_RPC_URL": url or self.url})
        return p.returncode, p.stdout + p.stderr

    def fresh_state(self):
        return self.tmp / f"state-{time.monotonic_ns()}.json"

    def call(self, to, sig, *args):
        return sh("cast", "call", to, sig, *args, "--rpc-url", self.url).stdout.split()[0]

    def test_deploy_then_settings_then_check(self):
        st = self.fresh_state()
        rc, out = self.run_deploy("deploy", state=st)
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.count("\ntx ") + out.startswith("tx "), 7)  # the ProxyAdmin, the timelock, two implementations, two proxies, the hand-over
        s = json.loads(st.read_text())
        self.assertEqual(self.call(s["book"], "outOpen()(bool)"), "false")
        self.assertEqual(self.call(s["book"], "owner()(address)").lower(), s["settingsTimelock"].lower())
        rc, out = self.run_deploy("check", state=st)
        self.assertEqual(rc, 0, out)
        self.assertIn("all read-backs passed", out)
        rc, out = self.run_deploy("settings-schedule", state=st)
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.call(s["book"], "claimFee(address,uint32)(uint256)", TOKEN, "0"), "0")  # nothing is set before the delay has run
        rc, out = self.run_deploy("settings-execute", state=st)
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.call(s["book"], "claimFee(address,uint32)(uint256)", TOKEN, "0"), "1500000000")
        self.assertEqual(self.call(s["book"], "canonical(bytes32)(address)", "0x" + "11" * 32).lower(), TOKEN)
        self.assertEqual(self.call(s["book"], "unitOf(uint32)(uint256)", "0"), "1")
        self.assertEqual(self.call(s["book"], "inOpen()(bool)"), "false")  # listing opens the route, never the direction
        rc, out = self.run_deploy("check", "--settings", state=st)
        self.assertEqual(rc, 0, out)
        for secret in (PASSWORD, self.url):
            self.assertNotIn(secret, out)

    def test_two_timelocks_when_configured(self):
        cfg = self.config(upgradeTimelock={"minDelay": 600, "proposers": [self.who["other"]], "executors": [self.who["other"]]})
        st = self.fresh_state()
        rc, out = self.run_deploy("deploy", cfg=cfg, state=st)
        self.assertEqual(rc, 0, out)
        s = json.loads(st.read_text())
        self.assertNotEqual(s["upgradeTimelock"].lower(), s["settingsTimelock"].lower())
        self.assertEqual(self.call(s["proxyAdmin"], "owner()(address)").lower(), s["upgradeTimelock"].lower())
        self.assertEqual(self.call(s["upgradeTimelock"], "getMinDelay()(uint256)"), "600")
        self.assertEqual(self.call(s["settingsTimelock"], "getMinDelay()(uint256)"), "300")

    def test_check_names_every_difference(self):
        st = self.fresh_state()
        self.assertEqual(self.run_deploy("deploy", state=st)[0], 0)
        base = self.config()
        for what, change in [
            ("minDelay", lambda c: c["settingsTimelock"].update(minDelay=301)),
            ("EXECUTOR_ROLE", lambda c: c["settingsTimelock"]["executors"].append(self.who["other"])),
            ("PROPOSER_ROLE", lambda c: c["settingsTimelock"].update(proposers=[self.who["other"]])),
            ("bridge", lambda c: c.update(bridge="0x" + "99" * 20)),
            ("gateway", lambda c: c.update(gateway="0x" + "98" * 20)),
            ("refuser", lambda c: c.update(refuser="0x" + "97" * 20)),
        ]:
            cfg = copy.deepcopy(base)
            change(cfg)
            rc, out = self.run_deploy("check", cfg=cfg, state=st)
            self.assertEqual(rc, 1, what)
            self.assertIn(what, out)
        pinned = self.tmp / "r1.json"
        pinned.write_text(json.dumps({"inboxCodeHash": "0x" + "00" * 32}))
        rc, out = self.run_deploy("check", state=st, vectors=pinned)
        self.assertEqual(rc, 1)
        self.assertIn("inboxCodeHash", out)

    def test_check_fails_when_initialize_does_not_revert(self):
        st = self.fresh_state()
        self.assertEqual(self.run_deploy("deploy", state=st)[0], 0)
        s = json.loads(st.read_text())
        s["book"] = self.who["other"]  # an account, not a locked proxy: initialize "succeeds"
        st.write_text(json.dumps(s))
        rc, out = self.run_deploy("check", state=st)
        self.assertEqual(rc, 1)
        self.assertIn("initialize", out)

    def test_deployer_may_not_hold_a_role(self):
        cfg = self.config(settingsTimelock={"minDelay": 300, "proposers": [self.who["proposer"], self.who["deployer"]], "executors": [self.who["proposer"]]})
        st = self.fresh_state()
        rc, out = self.run_deploy("deploy", cfg=cfg, state=st)
        self.assertEqual(rc, 1)
        self.assertIn("deployer", out)
        self.assertFalse(st.exists())  # nothing was sent

    def test_refuses_a_remote_chain_without_live_and_hides_its_address(self):
        remote = "https://rpc.example.invalid/key-8f3a"
        st = self.fresh_state()
        rc, out = self.run_deploy("deploy", state=st, url=remote)
        self.assertEqual(rc, 1)
        self.assertIn("--live", out)
        self.assertNotIn("key-8f3a", out)
        self.assertFalse(st.exists())

    def test_live_checks_the_chain_id(self):
        rc, out = self.run_deploy("--live", "check", state=self.fresh_state())
        self.assertEqual(rc, 1)
        self.assertIn("chain id", out)  # anvil is 31337, the config says 770101

    def test_second_deploy_into_the_same_state_is_refused(self):
        st = self.fresh_state()
        self.assertEqual(self.run_deploy("deploy", state=st)[0], 0)
        rc, out = self.run_deploy("deploy", state=st)
        self.assertEqual(rc, 1)
        self.assertIn("already", out)


class Config(unittest.TestCase):
    @staticmethod
    def module():
        spec = importlib.util.spec_from_file_location("deploy", DEPLOY)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m

    def test_the_testnet_file_names_what_is_still_missing_and_is_whole_once_filled(self):
        m = self.module()
        c = json.loads((HERE / "deploy" / "testnet.json").read_text())
        with self.assertRaises(m.Fail) as e:
            m.validate(c)
        for field in ("instrument", "refuser", "feeRecipient"):
            self.assertIn(field, str(e.exception))
        c.update(refuser=REFUSER, feeRecipient=FEE_TO)
        c["asset"]["instrument"] = "0x" + "11" * 32
        m.validate(c)

    def test_the_mainnet_example_has_a_second_timelock_and_is_not_deployable_as_it_stands(self):
        m = self.module()
        c = json.loads((HERE / "deploy" / "mainnet.example.json").read_text())
        self.assertIsNotNone(c["upgradeTimelock"])
        with self.assertRaises(m.Fail):
            m.validate(c)


if __name__ == "__main__":
    unittest.main()
