"""The always-on loop (`builder.py run`), against the same fakes as test_builder.py. The tests drive `Producer.step()` by hand with a
fake clock and a recording `wait`, so no test sleeps; one test runs the real command and signals it."""
import json, os, signal, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from fakes import BUILDER, HEAD_NUMBER, JWT_SECRET, LEDGER_TOKEN, tx

ALICE, BOB = tb.ALICE, tb.BOB


class Loop(tb.Case):
    def producer(self, s, **k):
        """A producer on a fake clock; `waits` records every pause it asks for, `reports` every line it prints."""
        self.now, self.waits, self.reports = [1_000_000.0], [], []
        self.stop = threading.Event()
        self.status_file = str(Path(s.dir) / "status.json")
        def wait(seconds):
            self.waits.append(seconds)
            return False
        opts = dict(idle=0.5, status_file=self.status_file, emit=self.reports.append, clock=lambda: self.now[0], wait=wait)
        return b.Producer(s.cfg, self.stop, **{**opts, **k})

    def built(self, s):
        return [p for m, p in s.reth.ws_calls if m == "testing_buildBlockV1"]

    def status(self):
        return json.loads(Path(self.status_file).read_text())


class WhenToBuild(Loop):
    def test_an_empty_pool_makes_no_block_and_waits(self):
        s = self.setup({})
        p = self.producer(s)
        p.step(); p.step()
        self.assertEqual(self.built(s), [])
        self.assertEqual(self.waits, [0.5, 0.5])
        self.assertEqual(self.reports, [])

    def test_a_waiting_transaction_makes_a_block(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        p = self.producer(s)
        p.step()
        (report,) = self.reports
        self.assertIs(report["committed"], True)
        self.assertEqual((report["number"], report["transactions"]), (HEAD_NUMBER + 1, [t["hash"]]))
        self.assertIn("proveSeconds", report); self.assertIn("advanceSeconds", report)
        p.step()   # the pool is empty again
        self.assertEqual(len(self.reports), 1)

    def test_after_a_commit_the_next_block_is_made_at_once(self):
        a, c = tx(ALICE, 0, gas=20_000_000), tx(BOB, 0, gas=20_000_000, price=5)   # too big for one block
        s = self.setup({ALICE: [a], BOB: [c]})
        p = self.producer(s)
        p.step(); p.step()
        self.assertEqual([r["transactions"] for r in self.reports], [[a["hash"]], [c["hash"]]])
        self.assertEqual(self.waits, [])

    def test_an_empty_block_is_made_when_the_heartbeat_is_due_and_not_before(self):
        s = self.setup({})
        p = self.producer(s, empty_every=30)
        self.now[0] += 29; p.step()
        self.assertEqual(self.reports, [])
        self.now[0] += 2; p.step()
        (report,) = self.reports
        self.assertEqual((report["committed"], report["transactions"]), (True, []))
        p.step()   # the clock for the next one starts at the commit
        self.assertEqual(len(self.reports), 1)

    def test_no_heartbeat_when_it_is_not_asked_for(self):
        s = self.setup({})
        p = self.producer(s)
        self.now[0] += 10_000; p.step()
        self.assertEqual(self.reports, [])

    def test_a_pool_whose_transactions_are_all_held_back_does_not_make_empty_blocks(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        p = self.producer(s)
        p.excluded[t["hash"]] = self.now[0] + 600
        p.step()   # the one block, empty because the only transaction is held back
        self.assertEqual(self.reports[0]["transactions"], [])
        p.step(); p.step()
        self.assertEqual(len(self.reports), 1)
        self.now[0] += 601   # the cool-down is over: the transaction goes in
        p.step()
        self.assertEqual(self.reports[1]["transactions"], [t["hash"]])


class Refusals(Loop):
    def test_a_refused_block_is_tried_again_and_commits_once_canton_agrees(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, refuse="no")
        p = self.producer(s)
        p.step()
        self.assertIs(self.reports[0]["committed"], False)
        self.assertEqual(self.reports[0]["keptTransactions"], [t["hash"]])
        s.ledger.refuse = None
        p.step()
        self.assertEqual([r["committed"] for r in self.reports], [False, True])
        self.assertEqual(self.reports[1]["transactions"], [t["hash"]])

    def test_a_transaction_in_two_refused_blocks_in_a_row_is_left_out_for_the_cool_down(self):
        bad, good = tx(ALICE, 0), tx(BOB, 0, price=5)
        s = self.setup({ALICE: [bad], BOB: [good]}, refuse="the registry says no")
        p = self.producer(s, cooldown=600)
        p.step()
        self.assertEqual(self.status()["excluded"], [])
        p.step()   # the second refusal with the same transactions
        until = b.iso(self.now[0] + 600)
        self.assertEqual(sorted((e["transaction"], e["until"]) for e in self.status()["excluded"]),
                         sorted([(bad["hash"], until), (good["hash"], until)]))
        s.ledger.refuse = None
        p.step()   # both are held back: the block is empty and commits
        self.assertEqual(self.reports[-1]["transactions"], [])
        # the cool-down ends and they are tried again
        self.now[0] += 601
        p.step()
        self.assertEqual(sorted(self.reports[-1]["transactions"]), sorted([bad["hash"], good["hash"]]))
        self.assertEqual(self.status()["excluded"], [])

    def test_refusals_with_a_commit_between_them_are_not_consecutive(self):
        t = tx(ALICE, 0, gas=20_000_000)
        u = tx(BOB, 0, gas=20_000_000, price=5)
        s = self.setup({ALICE: [t], BOB: [u]}, refuse="no")
        p = self.producer(s)
        p.step()
        s.ledger.refuse = None; p.step()   # t commits
        s.ledger.refuse = "no"; p.step()   # u refused: it was not in the refused block before the commit
        self.assertEqual(p.excluded, {})
        self.assertEqual([r["committed"] for r in self.reports], [False, True, False])

    def test_an_unknown_outcome_goes_on_and_the_next_block_starts_from_cantons_head(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        s.ledger.head_fails_after_submit = True
        p = self.producer(s)
        p.step()
        self.assertIsNone(self.reports[0]["committed"])
        self.assertEqual(self.status()["blocksUnknown"], 1)
        s.ledger.head_fails_after_submit, s.ledger.drop_but_commit = False, False
        s.reth.pool[ALICE] = [tx(ALICE, 1)]
        p.step()
        self.assertEqual(self.reports[1]["number"], HEAD_NUMBER + 2)


class Failures(Loop):
    def test_a_failing_block_backs_off_up_to_thirty_seconds_and_a_good_one_resets_it(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, prover_fails=True)
        p = self.producer(s)
        for _ in range(8):
            p.step()
        self.assertEqual(self.waits, [1, 2, 4, 8, 16, 30, 30, 30])
        self.assertTrue(all(r["committed"] is False and "error" in r for r in self.reports))
        self.assertEqual(self.status()["consecutiveFailures"], 8)
        os.environ["FAKE_PROVER_FAILS"] = ""
        p.step()
        self.assertTrue(self.reports[-1]["committed"])
        self.assertEqual(self.status()["consecutiveFailures"], 0)
        self.assertEqual(len(self.waits), 8)

    def test_a_pool_that_cannot_be_read_is_a_failure_too(self):
        s = self.setup({})
        def down(cfg): raise OSError("connection refused")
        p = self.producer(s, pending=down)
        p.step()
        self.assertEqual(self.reports, [{"committed": False, "error": "OSError: connection refused"}])
        self.assertEqual(self.waits, [1])

    def test_failed_blocks_do_not_count_toward_the_two_in_a_row(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, refuse="no")
        p = self.producer(s)
        p.step()
        os.environ["FAKE_PROVER_FAILS"] = "1"; p.step()   # a failure between the two refusals
        os.environ["FAKE_PROVER_FAILS"] = ""; p.step()
        self.assertEqual(p.excluded, {})


class StatusFile(Loop):
    def test_the_status_after_a_commit_and_a_refusal(self):
        a, c = tx(ALICE, 0, gas=20_000_000), tx(BOB, 0, gas=20_000_000, price=5)
        s = self.setup({ALICE: [a], BOB: [c]})
        p = self.producer(s)
        p.write_status()
        first = self.status()
        self.assertEqual((first["state"], first["blocksCommitted"], first["lastCommitted"], first["averageProveSeconds"]), ("running", 0, None, None))
        p.step()
        s.ledger.refuse = "the registry says no"
        p.step()
        st = self.status()
        self.assertEqual((st["blocksCommitted"], st["blocksRefused"], st["consecutiveFailures"]), (1, 1, 0))
        self.assertEqual((st["lastCommitted"]["number"], st["lastCommitted"]["hash"]), (HEAD_NUMBER + 1, self.reports[0]["blockHash"]))
        self.assertEqual(st["lastCommitted"]["time"], b.iso(self.now[0]))
        self.assertIn("the registry says no", st["lastError"]["error"])
        self.assertIsInstance(st["averageProveSeconds"], float)
        self.assertIsInstance(st["averageAdvanceSeconds"], float)
        self.assertEqual(st["excluded"], [])
        self.assertEqual(os.listdir(s.dir).count("status.json.tmp"), 0)

    def test_a_status_file_that_cannot_be_written_does_not_stop_the_chain(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        p = self.producer(s, status_file=str(Path(s.dir) / "status.json" / "x" / "status.json"))
        (Path(s.dir) / "status.json").write_text("a file, so the folder cannot be made")
        p.step()
        self.assertTrue(self.reports[0]["committed"])

    def test_an_idle_loop_still_refreshes_the_status(self):
        s = self.setup({})
        p = self.producer(s)
        p.write_status()
        before = self.status()["updatedAt"]
        self.now[0] += 6
        p.step()
        self.assertNotEqual(self.status()["updatedAt"], before)


class TheCommand(Loop):
    def env(self, s):
        state = Path(s.dir) / "state"
        state.mkdir()
        (state / "jwt.hex").write_text(JWT_SECRET.hex())
        return {**os.environ, "CZE_STATE_DIR": str(state), "CZE_LEDGER_URL": s.ledger.url, "CZE_LEDGER_USER": "builder-user",
                "CZE_LEDGER_TOKEN": LEDGER_TOKEN, "CZE_BUILDER_PARTY": BUILDER, "CZE_FEE_RECIPIENT": "0x" + "fe" * 20,
                "RETH_WS_PORT": s.reth.ws_url.rsplit(":", 1)[1], "RETH_ENGINE_PORT": s.reth.engine_url.rsplit(":", 1)[1],
                "CZE_GENESIS": s.cfg.genesis, "CZE_WORK_DIR": s.cfg.work_dir, "CZE_MAKE_INPUT_CMD": s.cfg.make_input_cmd,
                "CZE_PROVE_CMD": s.cfg.prove_cmd, "FAKE_PROVER_SLEEP": "1.5"}

    def test_a_signal_lets_the_block_in_progress_finish_and_exits_zero(self):
        a, c = tx(ALICE, 0, gas=20_000_000), tx(BOB, 0, gas=20_000_000, price=5)
        s = self.setup({ALICE: [a], BOB: [c]})
        status = str(Path(s.dir) / "status.json")
        proc = subprocess.Popen([sys.executable, str(HERE.parent / "builder.py"), "run", "--idle-ms", "50", "--status-file", status],
                                env=self.env(s), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        deadline = time.time() + 30
        while not (s.log.exists() and "prove" in s.log.read_text()):   # the first block is being proven
            self.assertLess(time.time(), deadline, "the first block never reached the prover")
            time.sleep(0.05)
        proc.send_signal(signal.SIGTERM)
        out, err = proc.communicate(timeout=60)
        self.assertEqual(proc.returncode, 0, err)
        (line,) = out.splitlines()   # one block, and one JSON line for it
        self.assertEqual((json.loads(line)["committed"], json.loads(line)["transactions"]), (True, [a["hash"]]))
        st = json.loads(Path(status).read_text())
        self.assertEqual((st["state"], st["blocksCommitted"]), ("stopped", 1))
        self.assertEqual(len(s.ledger.submitted), 1)

    def test_run_does_not_take_exclude(self):
        s = self.setup({})
        proc = subprocess.run([sys.executable, str(HERE.parent / "builder.py"), "run", "--exclude", "0x" + "00" * 32],
                              env=self.env(s), capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("--exclude is for once", json.loads(proc.stdout)["error"])


if __name__ == "__main__":
    unittest.main()
