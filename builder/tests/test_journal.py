"""The producer's journal and the block-cutting setting (README.md, "The journal" and "The block-cutting setting"), against the same
fakes as test_producer.py. The tests drive `Producer.step()` by hand on a fake clock, then read the journal's lines."""
import contextlib, io, json, os, re, sys, tempfile, threading, unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
import test_producer as tp
from fakes import HEAD_HASH, HEAD_NUMBER, tx

ALICE, BOB = tb.ALICE, tb.BOB
CHAIN_ID = 770101   # the fake chain record's


class Lines(tp.Loop):
    def journal(self, s, *names):
        """The journal's lines in the order they were written, only those of the named events if any are named."""
        folder = Path(s.cfg.work_dir) / "journal"
        found = [json.loads(l) for f in sorted(folder.glob("*.jsonl")) for l in f.read_text().splitlines()] if folder.exists() else []
        return [l for l in found if not names or l["event"] in names]

    def events(self, s, attempt=None):
        return [l["event"] for l in self.journal(s) if attempt is None or l.get("attempt") == attempt]

    def one(self, s, name, attempt=None):
        (line,) = [l for l in self.journal(s, name) if attempt is None or l.get("attempt") == attempt]
        return line


class EveryOutcome(Lines):
    def test_a_committed_block_has_a_line_for_each_step(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        s.reth.tx_legs[t["hash"]] = []
        p = self.producer(s)
        p.step()
        self.assertEqual(self.events(s), ["pool", "cut", "built", "proof_queued", "proof_started", "proof_ended", "submitted", "answered", "final_seen"])
        lines = self.journal(s)
        self.assertEqual([l["seq"] for l in lines], list(range(1, 10)))   # the sequence counts up from 1 in each run
        self.assertEqual({(l["v"], l["run"]) for l in lines}, {(1, p.journal.run_id)})
        self.assertTrue(all(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", l["time"]) for l in lines))   # UTC, to the millisecond
        self.assertEqual(self.one(s, "pool")["waiting"], 1)
        cut = self.one(s, "cut")
        self.assertEqual({k: cut[k] for k in ("attempt", "number", "strategy", "cut_reason", "pool_waiting", "idle_before_cut_ms", "in_flight_at_cut")},
                         {"attempt": 1, "number": HEAD_NUMBER + 1, "strategy": "on_demand", "cut_reason": "pool", "pool_waiting": 1,
                          "idle_before_cut_ms": 0, "in_flight_at_cut": 0})
        built = self.one(s, "built")
        self.assertEqual((built["block_hash"], built["parent_hash"], built["tx_hashes"], built["rebuilds"], built["left_out"]),
                         (self.reports[-1]["blockHash"], HEAD_HASH, [t["hash"]], 0, []))
        self.assertGreater(built["gas_used"], 0)
        ended = self.one(s, "proof_ended")
        self.assertEqual((ended["outcome"], ended["prover"]), ("ok", "fake-prove.sh"))
        self.assertGreaterEqual(ended["seconds"], 0)
        sub = self.one(s, "submitted")
        self.assertEqual(sub["argument_bytes"], len((Path(s.cfg.work_dir) / f"block-{HEAD_NUMBER + 1}" / "advance.json").read_bytes()))
        answered = self.one(s, "answered")
        self.assertEqual((answered["outcome"], answered["update_id"], answered["completion_offset"], answered["traffic_bytes"]), ("committed", "u1", 43, None))
        self.assertEqual(self.one(s, "final_seen")["number"], HEAD_NUMBER + 1)

    def test_a_block_canton_refused_ends_with_a_refusal_and_is_never_final(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, refuse="the registry says no")
        self.producer(s).step()
        answered = self.one(s, "answered")
        self.assertEqual((answered["outcome"], "the registry says no" in answered["reason"], answered["update_id"] if "update_id" in answered else None), ("refused", True, None))
        self.assertNotIn("final_seen", self.events(s))

    def test_a_block_canton_did_not_take_and_did_not_refuse_is_not_taken(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, fail_but_commit=True)
        s.ledger.commit = False
        self.producer(s).step()
        self.assertEqual(self.one(s, "answered")["outcome"], "not_taken")

    def test_an_unknown_outcome_is_resolved_later_on_the_same_attempt(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        s.ledger.head_fails_after_submit = True
        p = self.producer(s)
        p.step()
        self.assertEqual(self.one(s, "answered")["outcome"], "unknown")
        self.assertNotIn("resolved", self.events(s))
        s.ledger.head_fails_after_submit, s.ledger.drop_but_commit = False, False
        p.step()
        self.assertEqual(self.one(s, "resolved")["outcome"], "committed")
        self.assertEqual(self.one(s, "resolved")["attempt"], 1)
        self.assertEqual(self.one(s, "final_seen")["number"], HEAD_NUMBER + 1)

    def test_an_unknown_outcome_that_was_not_committed_is_resolved_as_not_committed(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        s.ledger.commit, s.ledger.head_fails_after_submit = False, True
        p = self.producer(s)
        p.step()
        s.ledger.head_fails_after_submit = False
        p.step()
        self.assertEqual(self.one(s, "resolved")["outcome"], "not committed")
        self.assertNotIn("final_seen", self.events(s))

    def test_a_proof_that_fails_ends_the_attempt_as_failed(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, prover_fails=True)
        self.producer(s).step()
        self.assertEqual(self.events(s, 1)[-3:], ["proof_started", "proof_ended", "answered"])
        self.assertEqual(self.one(s, "proof_ended")["outcome"], "failed")
        answered = self.one(s, "answered")
        self.assertEqual((answered["outcome"], answered["stage"]), ("failed", "proof_ended"))
        self.assertIn("prover is down", answered["reason"] + self.one(s, "proof_ended")["reason"])

    def test_a_proof_of_another_block_is_a_wrong_block(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        os.environ["FAKE_PROVER_WRONG_BLOCK"] = "1"
        self.addCleanup(os.environ.pop, "FAKE_PROVER_WRONG_BLOCK", None)
        self.producer(s).step()
        self.assertEqual(self.one(s, "proof_ended")["outcome"], "wrong_block")
        self.assertNotIn("submitted", self.events(s))

    def test_a_failure_before_canton_is_read_has_a_cut_with_no_number(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, chains=0)   # no ZkChain contract to build on
        self.producer(s).step()
        self.assertIsNone(self.one(s, "cut")["number"])
        answered = self.one(s, "answered")
        self.assertEqual((answered["outcome"], answered["stage"]), ("failed", "cut"))

    def test_a_pool_with_nothing_that_can_go_in_is_a_skipped_attempt(self):
        t = tx(BOB, 0)
        s = self.setup({BOB: [t]})
        s.reth.tx_legs[t["hash"]] = [tb.PAY]   # its leg has no Canton side
        self.producer(s).step()
        self.assertEqual(self.events(s, 1), ["cut", "skipped"])
        skipped = self.one(s, "skipped")
        self.assertEqual([x["transaction"] for x in skipped["left_out"]], [t["hash"]])
        self.assertEqual(skipped["rebuilds"], 1)

    def test_a_transaction_left_out_of_a_block_is_named_in_built(self):
        left, good = tx(BOB, 0), tx(ALICE, 0, price=5)
        s = self.setup({BOB: [left], ALICE: [good]})
        s.reth.tx_legs[left["hash"]] = [tb.PAY]
        self.producer(s).step()
        built = self.one(s, "built")
        self.assertEqual((built["tx_hashes"], built["rebuilds"], [x["transaction"] for x in built["left_out"]]), ([good["hash"]], 1, [left["hash"]]))

    def test_a_transaction_held_back_has_an_excluded_line(self):
        bad = tx(ALICE, 0)
        s = self.setup({ALICE: [bad]}, refuse="no")
        p = self.producer(s, cooldown=600)
        p.step(); p.step()
        line = self.one(s, "excluded")
        self.assertEqual((line["transaction"], line["until"]), (bad["hash"], b.iso(self.now[0] + 600)))


class CommandIdAndAnswer(Lines):
    def test_the_command_id_is_made_from_the_chain_the_number_the_block_hash_and_the_attempt(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, refuse="no")
        p = self.producer(s)
        p.step()
        self.now[0] += 100; p.step()
        first, second = [l["command_id"] for l in self.journal(s, "submitted")]
        hashes = [l["block_hash"] for l in self.journal(s, "built")]
        self.assertEqual(first, f"ostia-{CHAIN_ID}-{HEAD_NUMBER + 1}-{hashes[0][2:18]}-1")
        self.assertEqual(second, f"ostia-{CHAIN_ID}-{HEAD_NUMBER + 1}-{hashes[1][2:18]}-2")
        self.assertEqual([x["commandId"] for x in s.ledger.submitted], [first, second])   # what Canton got is what the journal says

    def test_the_once_command_gives_a_deterministic_id_too(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        result = self.build(s)
        self.assertEqual(result["commandId"], f"ostia-{CHAIN_ID}-{HEAD_NUMBER + 1}-{result['blockHash'][2:18]}-1")
        self.assertEqual(s.ledger.submitted[0]["commandId"], result["commandId"])

    def test_the_update_id_and_the_completion_offset_come_from_the_ledger_answer(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        result = self.build(s)
        self.assertEqual((result["updateId"], result["completionOffset"]), ("u1", 43))

    def test_an_answer_without_them_gives_none(self):
        s = self.setup({})
        for answer in ({}, [], "ok", {"updateId": 5, "completionOffset": "7"}):
            with mock.patch.object(b, "post_json", return_value=answer):
                self.assertEqual(b.Ledger(s.cfg).advance({"contractId": "c"}, {}), {"updateId": None, "completionOffset": None})

    def test_a_lost_reply_that_hid_a_commit_has_no_update_id(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        self.producer(s).step()
        answered = self.one(s, "answered")
        self.assertEqual((answered["outcome"], answered["update_id"], answered["completion_offset"]), ("committed", None, None))


class Traffic(Lines):
    def run_one(self, s, **k):
        self.producer(s, **k).step()
        return self.one(s, "answered")

    def test_the_traffic_is_what_the_participant_used_across_advance(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.cfg.traffic_url = s.ledger.url + "/traffic"
        s.ledger.traffic = [{"extraTrafficConsumed": 1000}, {"trafficState": {"extraTrafficConsumed": "13500"}}]   # a number, and an int64 as digits
        self.assertEqual(self.run_one(s)["traffic_bytes"], 12500)

    def test_the_traffic_is_null_where_the_participant_does_not_report_it(self):
        for name, traffic in (("not asked for", None), ("no answer", []), ("one answer only", [{"extraTrafficConsumed": 5}]),
                              ("no such field", [{"x": 1}, {"x": 2}]), ("it went down", [{"extraTrafficConsumed": 9}, {"extraTrafficConsumed": 3}])):
            with self.subTest(name):
                s = self.setup({ALICE: [tx(ALICE, 0)]})
                if traffic is not None:
                    s.cfg.traffic_url = s.ledger.url + "/traffic"
                    s.ledger.traffic = list(traffic)
                self.assertIsNone(self.run_one(s)["traffic_bytes"])

    def test_the_traffic_is_not_read_while_another_block_is_in_flight(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.cfg.traffic_url = s.ledger.url + "/traffic"
        s.ledger.traffic = [{"extraTrafficConsumed": 1}, {"extraTrafficConsumed": 2}]
        attempt = b.Attempt(b.Journal(Path(s.dir) / "j", clock=lambda: 1_000_000.0), 1, in_flight=1)
        b.build_block(s.cfg, journal=attempt)
        self.assertEqual(len(s.ledger.traffic), 2)   # untouched
        (answered,) = [json.loads(l) for l in (Path(s.dir) / "j" / "1970-01-12.jsonl").read_text().splitlines() if '"answered"' in l]
        self.assertIsNone(answered["traffic_bytes"])

    def test_a_participant_that_answers_nonsense_does_not_hold_up_a_block(self):
        s = self.setup({})
        s.cfg.traffic_url = "http://127.0.0.1:9/nowhere"
        self.assertIsNone(b.read_traffic(s.cfg))
        self.assertEqual([b.parse_traffic(x) for x in (None, 7, {"extraTrafficConsumed": True}, {"extraTrafficConsumed": -1}, {"extraTrafficConsumed": "12x"})], [None] * 5)


class TheFile(Lines):
    def test_every_line_is_synced_and_a_new_file_is_synced_too(self):
        folder = Path(tempfile.mkdtemp()) / "journal"
        self.addCleanup(lambda: __import__("shutil").rmtree(folder.parent))
        j = b.Journal(folder, clock=lambda: 1_000_000.0)
        with mock.patch.object(os, "fsync", wraps=os.fsync) as fsync:
            j.event("pool", waiting=1)
            self.assertEqual(fsync.call_count, 2)   # the line, and the folder that now holds the new file
            j.event("pool", waiting=2)
            self.assertEqual(fsync.call_count, 3)   # the line only
        self.assertEqual(len((folder / "1970-01-12.jsonl").read_text().splitlines()), 2)

    def test_a_new_utc_day_is_a_new_file(self):
        folder = Path(tempfile.mkdtemp()) / "journal"
        self.addCleanup(lambda: __import__("shutil").rmtree(folder.parent))
        now = [1_700_000_000.0 + 86_399 - 1_700_000_000 % 86_400]   # one second before midnight UTC
        j = b.Journal(folder, clock=lambda: now[0])
        j.event("pool", waiting=1)
        now[0] += 1.5
        j.event("pool", waiting=2)
        files = sorted(f.name for f in folder.iterdir())
        self.assertEqual(files, ["2023-11-14.jsonl", "2023-11-15.jsonl"])
        self.assertEqual([json.loads((folder / f).read_text())["seq"] for f in files], [1, 2])   # the sequence runs on across the files

    def test_a_line_cut_short_by_a_crash_does_not_swallow_the_next_run_s_first_line(self):
        folder = Path(tempfile.mkdtemp()) / "journal"
        self.addCleanup(lambda: __import__("shutil").rmtree(folder.parent))
        b.Journal(folder, clock=lambda: 1_000_000.0).event("pool", waiting=1)
        with open(folder / "1970-01-12.jsonl", "ab") as f:
            f.write(b'{"v":1,"run":"x","seq":2,"ti')   # the crash
        b.Journal(folder, clock=lambda: 1_000_000.0).event("pool", waiting=3)
        lines = (folder / "1970-01-12.jsonl").read_text().splitlines()
        self.assertEqual(len(lines), 3)
        self.assertEqual(json.loads(lines[2])["waiting"], 3)

    def test_a_journal_that_cannot_be_written_does_not_stop_the_chain(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        blocked = Path(s.dir) / "blocked"
        blocked.write_text("a file, where the folder should be")
        p = self.producer(s, journal=b.Journal(blocked / "journal", clock=lambda: self.now[0]))
        p.step()
        self.assertTrue(self.reports[-1]["committed"])   # the block went in
        self.assertEqual(s.ledger.head["headNumber"], str(HEAD_NUMBER + 1))
        error = self.status()["journalError"]
        self.assertIn("NotADirectoryError", error["error"])   # and the status says so
        # the journal comes back: the next line works, the error clears, and the lost lines are a gap in the sequence
        blocked.unlink()
        s.reth.pool[BOB] = [tx(BOB, 0)]
        s.reth.tx_legs[s.reth.pool[BOB][0]["hash"]] = []
        p.step()
        self.assertIsNone(self.status()["journalError"])
        self.assertGreater(self.journal_lines(blocked)[0]["seq"], 1)

    def journal_lines(self, folder):
        return [json.loads(l) for f in sorted((folder / "journal").glob("*.jsonl")) for l in f.read_text().splitlines()]

    def test_a_journal_file_that_cannot_be_opened_is_no_error_of_the_loop_either(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        folder = Path(s.cfg.work_dir) / "journal"
        (folder / "1970-01-12.jsonl").mkdir(parents=True)   # the day's file is a folder: every line fails
        self.producer(s).step()
        self.assertTrue(self.reports[-1]["committed"])
        self.assertEqual(self.status()["consecutiveFailures"], 0)
        self.assertIn("IsADirectoryError", self.status()["journalError"]["error"])


class TheSetting(Lines):
    def run_main(self, *argv):
        out = io.StringIO()
        with mock.patch.object(sys, "argv", ["builder.py", *argv]), contextlib.redirect_stdout(out):
            code = b.main()
        return code, out.getvalue()

    def test_the_heartbeat_has_two_names_and_the_default_is_on_demand_with_none(self):
        args = b.parser().parse_args(["run"])
        self.assertEqual((args.strategy, args.gather_ms, args.heartbeat_seconds, args.test), ("on_demand", 0, 0, False))
        self.assertEqual(b.parser().parse_args(["run", "--heartbeat-seconds", "600"]).heartbeat_seconds, 600)
        self.assertEqual(b.parser().parse_args(["run", "--empty-every-seconds", "600"]).heartbeat_seconds, 600)   # the old name
        args = b.parser().parse_args(["run", "--strategy", "on_demand", "--gather-ms", "250", "--test"])
        self.assertEqual((args.gather_ms, args.test), (250, True))

    def test_a_setting_that_cannot_keep_up_is_refused_and_says_why(self):
        for argv, why in ((["--heartbeat-seconds", "2"], "empty block takes 6.3 s"),
                          (["--empty-every-seconds", "1"], "cannot keep up"),
                          (["--gather-ms", "-1"], "cannot be negative"),
                          (["--gather-ms", "60000"], "would wait longer"),
                          (["--strategy", "fixed_rhythm"], "not available")):
            with self.subTest(argv):
                code, out = self.run_main("run", *argv)
                self.assertEqual(code, 1)
                self.assertIn(why, json.loads(out)["error"])

    def test_the_settings_that_are_fine(self):
        b.check_strategy("on_demand", 0, 0)
        b.check_strategy("on_demand", 250, 600)
        b.check_strategy("on_demand", 0, 6.3)

    def test_a_block_is_not_cut_until_gather_ms_after_the_first_transaction(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        s.reth.tx_legs[t["hash"]] = []
        p = self.producer(s, gather_ms=2000)
        p.step()
        self.assertEqual((self.built(s), self.waits), ([], [0.5]))
        self.now[0] += 1.0; p.step()
        self.assertEqual(self.built(s), [])
        self.assertEqual(self.waits[-1], 0.5)
        self.now[0] += 0.8; p.step()
        self.assertEqual(self.built(s), [])
        self.assertAlmostEqual(self.waits[-1], 0.2, places=6)   # the last half second is cut to what is left of the gather
        s.reth.pool[BOB] = [tx(BOB, 0, price=5)]   # one more arrives meanwhile
        s.reth.tx_legs[s.reth.pool[BOB][0]["hash"]] = []
        self.now[0] += 0.2; p.step()
        cut = self.one(s, "cut")
        self.assertEqual((cut["cut_reason"], cut["idle_before_cut_ms"], cut["pool_waiting"]), ("gather", 2000, 2))
        self.assertEqual(len(self.one(s, "built")["tx_hashes"]), 2)   # the gather batched them

    def test_no_gather_cuts_at_once(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        self.producer(s).step()
        self.assertEqual(self.one(s, "cut")["cut_reason"], "pool")

    def test_a_pool_that_empties_while_gathering_starts_the_wait_afresh(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        p = self.producer(s, gather_ms=1000)
        p.step()
        t = s.reth.pool.pop(ALICE)
        self.now[0] += 0.9; p.step()   # nothing waits any more
        s.reth.pool[ALICE] = t
        self.now[0] += 0.5; p.step()   # a transaction again: 0.5 s after the last look, but the wait begins now
        self.assertEqual(self.built(s), [])
        self.now[0] += 1.0; p.step()
        self.assertEqual(self.one(s, "cut")["cut_reason"], "gather")

    def test_the_heartbeat_makes_an_empty_block_and_says_so(self):
        s = self.setup({})
        p = self.producer(s, empty_every=30)
        self.now[0] += 31; p.step()
        cut = self.one(s, "cut")
        self.assertEqual((cut["cut_reason"], cut["idle_before_cut_ms"], cut["pool_waiting"]), ("heartbeat", 31_000, 0))
        self.assertEqual(self.one(s, "built")["tx_hashes"], [])
        self.assertEqual(self.one(s, "answered")["outcome"], "committed")

    def test_a_block_cut_again_after_a_refusal_is_a_retry(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, refuse="no")
        p = self.producer(s)
        p.step()
        s.ledger.refuse = None
        self.now[0] += 100; p.step()
        self.assertEqual([l["cut_reason"] for l in self.journal(s, "cut")], ["pool", "retry"])
        self.assertEqual([l["attempt"] for l in self.journal(s, "cut")], [1, 2])


class PoolAndRun(Lines):
    def test_the_pool_is_sampled_when_it_changes_and_at_most_once_a_second(self):
        s = self.setup({})
        p = self.producer(s)
        p.sample_pool(0, self.now[0])
        for dt, n in ((0.3, 1), (0.3, 1), (0.5, 1)):
            self.now[0] += dt
            p.sample_pool(n, self.now[0])
        self.assertEqual([l["waiting"] for l in self.journal(s, "pool")], [0, 1])   # written once the second was over, not before
        self.assertEqual(self.now[0] - p.pool_sampled[0], 0)

    def test_a_run_has_a_start_with_every_setting_and_a_stop(self):
        s = self.setup({})
        p = self.producer(s, empty_every=600, gather_ms=250, test=True, source_commit="abc123", cooldown=60)
        self.stop.set()
        p.run()
        start, stop = self.journal(s, "run_started")[0], self.journal(s, "run_stopped")[0]
        self.assertEqual(start["settings"], {"strategy": "on_demand", "gather_ms": 250, "heartbeat_seconds": 600, "max_in_flight": 1, "idle_ms": 500,
                                             "exclude_cooldown_seconds": 60, "test": True, "traffic_read": False})
        self.assertEqual((start["strategy"], start["source_commit"], stop["state"]), ("on_demand", "abc123", "stopped"))
        self.assertEqual(self.status()["runId"], start["run"])

    def test_every_run_has_its_own_id_and_its_sequence_starts_again(self):
        s = self.setup({})
        runs = []
        for _ in range(2):
            p = self.producer(s)
            self.stop.set(); p.run()
            runs.append(p.journal.run_id)
        starts = self.journal(s, "run_started")
        self.assertEqual([(l["run"], l["seq"]) for l in starts], [(runs[0], 1), (runs[1], 1)])
        self.assertNotEqual(*runs)

    def test_the_real_command_writes_its_journal(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        s.reth.tx_legs[t["hash"]] = []
        env = {**self.env(s), "FAKE_PROVER_SLEEP": "0"}
        import subprocess, signal, time
        proc = subprocess.Popen([sys.executable, str(HERE.parent / "builder.py"), "run", "--test", "--empty-every-seconds", "600"],
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.time() + 30
            while time.time() < deadline and "final_seen" not in self.events(s):
                time.sleep(0.2)
        finally:
            proc.send_signal(signal.SIGTERM)
            proc.communicate(timeout=30)
        self.assertIn("final_seen", self.events(s))
        start = self.journal(s, "run_started")[0]
        self.assertEqual((start["settings"]["test"], start["settings"]["heartbeat_seconds"]), (True, 600))
        self.assertEqual(self.journal(s, "run_stopped")[0]["state"], "stopped")


if __name__ == "__main__":
    unittest.main()
