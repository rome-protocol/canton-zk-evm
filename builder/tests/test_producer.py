"""The always-on loop (`builder.py run`), against the same fakes as test_builder.py. The tests drive `Producer.step()` by hand with a
fake clock and a recording `wait`, so no test sleeps, except the status ticker's tests, which run its thread on short real ticks; one test
runs the real command and signals it."""
from datetime import datetime, timezone
import json, os, shutil, signal, subprocess, sys, tempfile, threading, time, unittest
from unittest import mock
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from fakes import BUILDER, HEAD_NUMBER, JWT_SECRET, LEDGER_TOKEN, RpcError, tx

ALICE, BOB = tb.ALICE, tb.BOB


class Loop(tb.Case):
    engine = None   # the producer class; the pipeline tests set it

    def producer(self, s, **k):
        """A producer on a fake clock; `waits` records every pause it asks for, `reports` every line it prints."""
        self.now, self.waits, self.reports = [1_000_000.0], [], []
        self.stop = threading.Event()
        self.status_file = str(Path(s.dir) / "status.json")
        def wait(seconds):
            self.waits.append(seconds)
            return False
        opts = dict(idle=0.5, status_file=self.status_file, emit=self.reports.append, clock=lambda: self.now[0], wait=wait)
        return (self.engine or b.Producer)(s.cfg, self.stop, **{**opts, **k})

    def env(self, s):
        state = Path(s.dir) / "state"
        state.mkdir()
        (state / "jwt.hex").write_text(JWT_SECRET.hex())
        return {**os.environ, "CZE_STATE_DIR": str(state), "CZE_LEDGER_URL": s.ledger.url, "CZE_LEDGER_USER": "builder-user",
                "CZE_LEDGER_TOKEN": LEDGER_TOKEN, "CZE_BUILDER_PARTY": BUILDER, "CZE_FEE_RECIPIENT": "0x" + "fe" * 20,
                "RETH_WS_PORT": s.reth.ws_url.rsplit(":", 1)[1], "RETH_ENGINE_PORT": s.reth.engine_url.rsplit(":", 1)[1],
                "CZE_GENESIS": s.cfg.genesis, "CZE_WORK_DIR": s.cfg.work_dir, "CZE_MAKE_INPUT_CMD": s.cfg.make_input_cmd,
                "CZE_PROVE_CMD": s.cfg.prove_cmd, "FAKE_PROVER_SLEEP": "1.5"}

    def built(self, s):
        return [p for m, p in s.reth.ws_calls if m == "testing_buildBlockV1"]

    def looks(self, s):
        """How many times the loop has built a block to see what could go in. A left-out transaction makes it build twice."""
        return len(self.built(s)) // 2

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
        a, c = tx(ALICE, 0, gas=20_000_000, used=20_000_000), tx(BOB, 0, gas=20_000_000, used=20_000_000, price=5)   # each uses 20M of the 30M block: too big for one block
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

    def test_a_pool_whose_transactions_are_all_held_back_makes_no_block_at_all(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        p = self.producer(s)
        p.excluded[t["hash"]] = self.now[0] + 600
        p.step(); p.step(); p.step()
        self.assertEqual(s.ledger.submitted, [])   # no proof and no commit is spent on a block with nothing in it
        self.assertEqual(s.log.exists() and s.log.read_text(), False)
        self.assertEqual(s.reth.pool[ALICE], [t])
        self.now[0] += 601   # the cool-down is over: the transaction goes in at once
        p.step()
        self.assertEqual(self.reports[-1]["transactions"], [t["hash"]])

    def test_a_leg_that_gets_its_canton_side_later_goes_in_without_any_other_change_of_the_pool(self):
        t = tx(BOB, 0)
        s = self.setup({BOB: [t]})   # no terms yet
        s.reth.tx_legs[t["hash"]] = [tb.PAY]
        p = self.producer(s)
        p.step()
        self.assertEqual(s.ledger.submitted, [])
        self.assertEqual(self.reports, [{"skipped": True, "number": HEAD_NUMBER + 1,
                                         "leftOut": [{"transaction": t["hash"], "reason": self.reports[0]["leftOut"][0]["reason"]}]}])
        p.step(); p.step()   # not looked at again before the pause is over, and not told again
        self.assertEqual(self.looks(s), 1)
        self.assertEqual(len(self.reports), 1)
        s.ledger.terms.append(tb.TERMS)
        self.now[0] += 2.1; p.step()
        self.assertTrue(self.reports[-1]["committed"])
        self.assertEqual(self.reports[-1]["transactions"], [t["hash"]])
        self.assertEqual(self.in_pool(s), set())

    def test_a_pool_that_stays_the_same_is_looked_at_with_a_growing_pause(self):
        t = tx(BOB, 0)
        s = self.setup({BOB: [t]})
        s.reth.tx_legs[t["hash"]] = [tb.PAY]
        p = self.producer(s)
        p.step()
        looks = [self.looks(s)]
        for dt in (1.9, 0.2, 3.9, 0.2, 7.9, 0.2):   # looks at 2 s, 6 s and 14 s after the first
            self.now[0] += dt; p.step(); looks.append(self.looks(s))
        self.assertEqual(looks, [1, 1, 2, 2, 3, 3, 4])

    def test_a_transaction_that_arrives_while_the_pool_is_being_looked_at_is_not_forgotten(self):
        waiting, late = tx(ALICE, 0), tx(BOB, 0, price=5)
        s = self.setup({ALICE: [waiting]})
        s.reth.tx_legs[waiting["hash"]] = [tb.PAY]
        arrived = []
        def building(cfg, exclude, **k):
            result = b.build_block(cfg, exclude, **k)
            if not arrived:
                arrived.append(1)
                s.reth.pool[BOB] = [late]   # a good transaction comes in while the check runs
            return result
        p = self.producer(s, build=building)
        p.step()
        self.assertEqual(s.ledger.submitted, [])
        self.now[0] += 2.1; p.step()
        self.assertEqual(self.reports[-1]["transactions"], [late["hash"]])
        self.assertEqual([x["transaction"] for x in self.reports[-1]["leftOut"]], [waiting["hash"]])

    def test_a_replacement_with_the_same_count_is_picked_up(self):
        old, new = tx(ALICE, 0, name="old"), tx(ALICE, 0, price=20, name="new")
        s = self.setup({ALICE: [old]})
        s.reth.tx_legs[old["hash"]] = [tb.PAY]
        p = self.producer(s)
        p.step()
        s.reth.pool[ALICE] = [new]   # same sender and nonce, a higher fee, and no leg
        self.now[0] += 2.1; p.step()
        self.assertEqual(self.reports[-1]["transactions"], [new["hash"]])

    def test_transactions_that_only_ask_for_deposits_nobody_made_cost_no_proof_and_no_commit(self):
        s = self.setup({})
        spam = []
        for i in range(5):
            t = tx("0x" + f"{i + 1:02x}" * 20, 0, name="spam")
            s.reth.tx_legs[t["hash"]] = [tb.Leg(tb.DEPOSIT, f"{i + 1:064x}", tb.WTKB, tb.PAYEE, 1)]
            s.reth.pool[t["from"]] = [t]
            spam.append(t)
        p = self.producer(s)
        for _ in range(4):
            p.step(); self.now[0] += 2.5
        self.assertEqual(s.ledger.submitted, [])
        self.assertFalse(s.log.exists())
        extra = tx("0x" + "77" * 20, 0, name="spam")
        s.reth.tx_legs[extra["hash"]] = [tb.Leg(tb.DEPOSIT, "99" * 32, tb.WTKB, tb.PAYEE, 1)]
        s.reth.pool[extra["from"]] = [extra]   # more of it: still no block
        p.step(); self.now[0] += 2.5; p.step()
        self.assertEqual(s.ledger.submitted, [])
        good = tx(BOB, 0, price=5)
        s.reth.pool[BOB] = [good]   # a real transaction goes in, and the rest stays out of the block
        self.now[0] += 2.5; p.step()
        self.assertEqual(self.reports[-1]["transactions"], [good["hash"]])
        self.assertEqual(len(s.ledger.submitted), 1)


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

    def test_a_lone_transaction_in_two_refused_blocks_in_a_row_is_left_out_for_the_cool_down(self):
        bad = tx(ALICE, 0)
        s = self.setup({ALICE: [bad]}, refuse="the registry says no")
        p = self.producer(s, cooldown=600)
        p.step()
        self.assertEqual(self.status()["excluded"], [])
        p.step()   # the second refusal with the same transaction
        self.assertEqual(self.status()["excluded"], [{"transaction": bad["hash"], "until": b.iso(self.now[0] + 600)}])
        s.ledger.refuse = None
        p.step()   # it is held back and nothing else waits: no block
        self.assertEqual([r["committed"] for r in self.reports], [False, False])
        self.now[0] += 601   # the cool-down ends and it is tried again
        p.step()
        self.assertEqual(self.reports[-1]["transactions"], [bad["hash"]])
        self.assertEqual(self.status()["excluded"], [])

    def test_several_transactions_in_two_refused_blocks_are_tried_one_block_each_before_any_is_left_out(self):
        bad, good = tx(ALICE, 0), tx(BOB, 0, price=5)
        s = self.setup({ALICE: [bad], BOB: [good]}, refuse="the registry says no")
        p = self.producer(s, cooldown=600)
        p.step(); p.step()
        self.assertEqual((p.excluded, sorted(p.suspects)), ({}, sorted([bad["hash"], good["hash"]])))
        for _ in range(3):
            probe = p.probe
            s.ledger.refuse = "no" if probe == bad["hash"] else None
            if probe is None:
                break
            p.step()
            self.assertEqual(self.reports[-1]["keptTransactions" if not self.reports[-1]["committed"] else "transactions"], [probe])
        self.assertEqual(list(p.excluded), [bad["hash"]])   # only the bad one is held back
        self.assertIn(good["hash"], [h for r in self.reports if r.get("committed") for h in r["transactions"]])
        self.assertEqual(self.in_pool(s), {bad["hash"]})

    def test_refusals_with_a_commit_between_them_are_not_consecutive(self):
        t = tx(ALICE, 0, gas=20_000_000, used=20_000_000)
        u = tx(BOB, 0, gas=20_000_000, used=20_000_000, price=5)
        s = self.setup({ALICE: [t], BOB: [u]}, refuse="no")
        p = self.producer(s)
        p.step()
        s.ledger.refuse = None; p.step()   # t commits
        s.ledger.refuse = "no"; p.step()   # u refused: it was not in the refused block before the commit
        self.assertEqual(p.excluded, {})
        self.assertEqual([r["committed"] for r in self.reports], [False, True, False])

    def test_an_unknown_outcome_that_canton_did_commit_is_counted_and_the_chain_goes_on(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        s.ledger.no_completion = True
        p = self.producer(s)
        p.step()
        self.assertIsNone(self.reports[0]["committed"])
        self.assertEqual(self.status()["blocksUnknown"], 1)
        self.assertEqual({k: v for k, v in self.status()["waitingToBeResolved"].items() if k != "why"}, {"number": HEAD_NUMBER + 1, "hash": self.reports[0]["blockHash"], "commandId": self.reports[0]["commandId"]})
        s.ledger.no_completion, s.ledger.drop_but_commit = False, False
        p.step()   # finds out
        self.assertEqual(self.reports[1], {"resolved": "committed", "number": HEAD_NUMBER + 1, "blockHash": self.reports[0]["blockHash"], "updateId": "u1", "completionOffset": 43})
        self.assertEqual((self.status()["blocksCommitted"], self.status()["lastCommitted"]["number"]), (1, HEAD_NUMBER + 1))
        s.reth.pool[ALICE] = [tx(ALICE, 1)]
        p.step()
        self.assertEqual(self.reports[2]["number"], HEAD_NUMBER + 2)

    def test_an_unknown_outcome_that_canton_did_not_commit_puts_the_transactions_back_and_they_go_in_later(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        s.ledger.garbage_reply, s.ledger.commit, s.ledger.no_completion = True, False, True
        p = self.producer(s)
        p.step()
        self.assertIsNone(self.reports[0]["committed"])
        self.assertEqual(self.in_pool(s), set())   # reth holds them as mined and its head is the block that never committed
        p.step()   # the command has no completion yet: nothing is built, reth is not moved, and the loop waits
        self.assertEqual(len(self.built(s)), 1)
        self.assertEqual(len(self.reports), 1)
        self.assertEqual(self.waits[-1], 1.0)
        self.assertEqual(self.in_pool(s), set())
        s.ledger.no_completion = False   # its completion shows: it failed
        p.step()
        self.assertEqual(self.reports[1], {"resolved": "not committed", "number": HEAD_NUMBER + 1, "blockHash": self.reports[0]["blockHash"]})
        self.assertEqual(self.in_pool(s), {t["hash"]})
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], tb.HEAD_HASH)   # reth is back on Canton's head
        s.ledger.garbage_reply, s.ledger.commit = False, True
        p.step()
        self.assertEqual((self.reports[-1]["committed"], self.reports[-1]["transactions"]), (True, [t["hash"]]))

    def test_a_timeout_that_commits_later_is_waited_for_and_the_next_block_goes_on_top_of_it(self):
        a, c = tx(ALICE, 0), tx(BOB, 0, price=5)
        s = self.setup({ALICE: [a]})
        s.ledger.late = True   # the Advance times out (a 503) and commits only later
        p = self.producer(s)
        p.step()
        first = self.reports[0]
        self.assertIsNone(first["committed"])
        s.reth.pool[BOB] = [c]   # more work arrives while the command is in progress
        for _ in range(3):
            p.step()   # nothing is built, reth is not rewound, and the status says what it waits for
        self.assertEqual((len(self.built(s)), len(s.ledger.submitted), len(self.reports)), (1, 1, 1))
        self.assertEqual(self.waits, [1.0] * 3)
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], first["blockHash"])
        self.assertEqual({k: v for k, v in self.status()["waitingToBeResolved"].items() if k != "why"}, {"number": HEAD_NUMBER + 1, "hash": first["blockHash"], "commandId": first["commandId"]})
        s.ledger.land(ok=True)
        s.ledger.late = False
        p.step()
        self.assertEqual(self.reports[1], {"resolved": "committed", "number": HEAD_NUMBER + 1, "blockHash": first["blockHash"], "updateId": "u1", "completionOffset": 43})
        self.assertIsNone(self.status()["waitingToBeResolved"])
        p.step()
        self.assertEqual((self.reports[2]["committed"], self.reports[2]["number"], self.reports[2]["transactions"]), (True, HEAD_NUMBER + 2, [c["hash"]]))
        self.assertEqual([int(x["commandId"].split("-")[2]) for x in s.ledger.submitted], [HEAD_NUMBER + 1, HEAD_NUMBER + 2])   # one block at each height

    def test_a_timeout_that_is_rejected_later_syncs_reth_to_canton_head_before_the_next_block(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        s.ledger.late = True
        p = self.producer(s)
        p.step()
        p.step()
        s.ledger.land(ok=False, message="UNKNOWN_CONTRACT_SYNCHRONIZERS")
        s.ledger.late = False
        p.step()
        self.assertEqual(self.reports[1]["resolved"], "not committed")
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], tb.HEAD_HASH)   # reth is on Canton's head
        self.assertEqual(self.in_pool(s), {t["hash"]})
        p.step()   # the transactions go in a new block 1 above Canton's head
        self.assertEqual((self.reports[2]["committed"], self.reports[2]["number"]), (True, HEAD_NUMBER + 1))

    def test_with_no_completion_the_head_decides_only_when_canton_time_is_past_the_window(self):
        for commit in (True, False):
            s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
            s.ledger.no_completion, s.ledger.commit = True, commit
            p = self.producer(s)
            p.step()
            if not commit:
                self.now[0] += 10_000   # the builder's clock is far past the window: it decides nothing
                p.step()
                self.assertEqual(len(self.reports), 1)   # still waiting
                self.assertEqual(self.status()["waitingToBeResolved"]["number"], HEAD_NUMBER + 1)
                s.ledger.record_time = "2100-01-01T00:00:00.000000Z"   # Canton's checkpoints are past it
            with mock.patch.object(b, "builder_now", lambda: 4102444800.0):   # and the builder's clock agrees with them
                p.step()
            self.assertEqual(self.reports[1]["resolved"], "committed" if commit else "not committed")

    def test_a_canton_clock_far_ahead_of_the_builders_is_named_in_the_status(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        s.ledger.no_completion, s.ledger.commit = True, False
        p = self.producer(s)
        p.step()
        s.ledger.record_time = datetime.fromtimestamp(time.time() + 10_000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")   # past the window by Canton's time, an hour ahead of ours
        self.now[0] += 10_000
        p.step()
        self.assertEqual(len(self.reports), 1)   # still waiting: nothing is settled by the window
        why = self.status()["waitingToBeResolved"]["why"]
        self.assertIn("clock", why)
        self.assertIn("ahead", why)

    def test_an_advance_with_no_answer_is_still_settled_by_its_command_after_a_restart(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        s.ledger.late = True
        first = self.producer(s)
        first.step()
        block = self.reports[0]["blockHash"]
        second = self.producer(s)   # a new process: it knows the command from the work folder
        second.load_unresolved()
        second.step()   # no completion yet: reth stays where it is, nothing is built
        self.assertEqual(len(self.built(s)), 1)
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], block)
        self.assertEqual(self.status()["waitingToBeResolved"]["hash"], block)
        s.ledger.land(ok=True)
        s.ledger.late = False
        second.step()
        self.assertEqual(self.reports[-1], {"resolved": "committed", "number": HEAD_NUMBER + 1, "blockHash": block, "updateId": "u1", "completionOffset": 43})
        self.assertEqual(s.forkchoices()[-1]["finalizedBlockHash"], block)

    def test_a_damaged_kept_file_does_not_let_a_block_be_built_while_a_command_is_in_doubt(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.ledger.late = True
        first = self.producer(s)
        first.step()
        block = self.reports[0]["blockHash"]
        b.saved_path(s.cfg).write_text("this is not json")   # the kept transactions cannot be read
        second = self.producer(s)
        second.load_unresolved()
        s.reth.pool[BOB] = [tx(BOB, 0, price=5)]   # more work: it must wait
        second.step()
        second.step()
        self.assertEqual(len(s.ledger.submitted), 1)   # never a second block at that height
        self.assertEqual(self.status()["waitingToBeResolved"]["hash"], block)
        s.ledger.land(ok=True)
        s.ledger.late = False
        second.step()
        self.assertEqual(self.reports[-1]["resolved"], "committed")

    def test_a_record_that_cannot_be_read_stops_the_building(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        b.unresolved_path(s.cfg).parent.mkdir(parents=True, exist_ok=True)
        b.unresolved_path(s.cfg).write_text("{ this is not json")
        p = self.producer(s)
        p.step()
        p.step()
        self.assertEqual((s.ledger.submitted, self.built(s)), ([], []))
        self.assertTrue(self.waits)   # it backs off and tries to read again

    def test_a_submit_cut_short_in_this_process_is_waited_for_by_the_next_step(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.ledger.late = True
        p = self.producer(s)
        real = b.Ledger.advance
        def advance(ledger, chain, argument, command_id=None):
            try:
                real(ledger, chain, argument, command_id)
            except Exception:
                pass
            raise KeyboardInterrupt
        with mock.patch.object(b.Ledger, "advance", advance), self.assertRaises(KeyboardInterrupt):
            p.step()
        block = b.load_unresolved(s.cfg)["hash"]
        p.step()   # the record is on disk: the producer reads it and waits for the command instead of building
        self.assertEqual(len(s.ledger.submitted), 1)
        self.assertEqual(self.status()["waitingToBeResolved"]["hash"], block)
        s.ledger.land(ok=True)
        s.ledger.late = False
        p.step()
        self.assertEqual(self.reports[-1]["resolved"], "committed")

    def test_a_transaction_that_cannot_be_put_back_is_listed_in_the_status(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        s.ledger.garbage_reply, s.ledger.commit, s.ledger.no_completion = True, False, True
        p = self.producer(s)
        p.step()
        s.ledger.no_completion = False
        s.reth.refuse_resend = True
        p.step()
        self.assertEqual(self.reports[-1]["lostTransactions"], [{"transaction": t["hash"], "error": self.reports[-1]["lostTransactions"][0]["error"]}])
        self.assertEqual([x["transaction"] for x in self.status()["lostTransactions"]], [t["hash"]])

    def test_a_service_failure_is_not_a_refusal(self):
        a, c = tx(ALICE, 0), tx(BOB, 0, price=5)
        s = self.setup({ALICE: [a], BOB: [c]})
        s.ledger.fail_but_commit, s.ledger.commit = True, False   # a 503 and nothing committed
        p = self.producer(s)
        for _ in range(3):
            p.step()
        self.assertEqual([(r["committed"], r["rejected"]) for r in self.reports], [(False, False)] * 3)
        self.assertEqual(self.waits, [1, 2, 4])
        self.assertEqual((p.excluded, p.suspects), ({}, []))
        st = self.status()
        self.assertEqual((st["blocksRefused"], st["consecutiveFailures"]), (0, 3))
        s.ledger.fail_but_commit, s.ledger.commit = False, True
        p.step()
        self.assertEqual(sorted(self.reports[-1]["transactions"]), sorted([a["hash"], c["hash"]]))

    def test_repeated_refusals_back_off_and_a_commit_resets_the_pause(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, refuse="no")
        p = self.producer(s, cooldown=600)
        p.step(); p.step()
        self.assertEqual(self.waits, [1, 2])
        self.now[0] += 601
        s.ledger.refuse = None; p.step()   # commits
        s.reth.pool[ALICE] = [tx(ALICE, 1)]
        s.ledger.refuse = "no"; p.step()
        self.assertEqual(self.waits, [1, 2, 1])


class Failures(Loop):
    def test_a_failing_block_backs_off_up_to_thirty_seconds_and_a_good_one_resets_it(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        down = [True]
        def building(cfg, exclude, **k):
            if down[0]:
                raise b.BuilderError("reth is down")
            return b.build_block(cfg, exclude, **k)
        p = self.producer(s, build=building)
        for _ in range(8):
            p.step()
        self.assertEqual(self.waits, [1, 2, 4, 8, 16, 30, 30, 30])
        self.assertTrue(all(r["committed"] is False and "error" in r for r in self.reports))
        self.assertEqual(self.status()["consecutiveFailures"], 8)
        down[0] = False
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


class NeverDies(Loop):
    def test_a_very_long_outage_never_overflows_the_backoff(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, prover_fails=True)
        p = self.producer(s)
        p.failures = 1100
        p.step(); p.step()
        self.assertEqual(self.waits, [30, 30])
        self.assertEqual(self.status()["consecutiveFailures"], 1102)

    def test_the_status_keeps_the_original_error_when_moving_reth_back_fails_too(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, prover_fails=True)
        s.reth.no_state_for_genesis = True
        p = self.producer(s)
        p.step()
        self.assertIn("prove", self.reports[-1]["error"])
        self.assertNotIn("no state found", self.reports[-1]["error"])
        self.assertIn("no state found", self.reports[-1]["rewindError"])
        err = self.status()["lastError"]
        self.assertIn("prove", err["error"])
        self.assertNotIn("no state found", err["error"])
        self.assertIn("no state found", err["rewindError"])

    def test_a_refusal_keeps_canton_reason_in_the_status_when_moving_reth_back_fails_too(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, refuse="the sidecar refused the proof: wrong program key")
        s.reth.no_state_for_genesis = True
        p = self.producer(s)
        p.step()
        self.assertIs(self.reports[-1]["committed"], False)
        self.assertIn("wrong program key", self.reports[-1]["reason"])
        self.assertIn("no state found", self.reports[-1]["rewindError"])
        status = self.status()
        err = status["lastError"]
        self.assertIn("wrong program key", err["error"])
        self.assertNotIn("no state found", err["error"])
        self.assertIn("no state found", err["rewindError"])

    def test_a_failure_without_a_failed_move_back_has_no_rewind_error_in_the_status(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, prover_fails=True)
        p = self.producer(s)
        p.step()
        self.assertNotIn("rewindError", self.status()["lastError"])

    def test_a_log_pipe_that_is_gone_does_not_stop_the_loop(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        def gone(report): raise BrokenPipeError("the collector died")
        p = self.producer(s, emit=gone)
        p.step()
        self.assertEqual(self.status()["blocksCommitted"], 1)

    def test_a_fault_of_the_loops_own_is_a_failure_and_a_crash_is_said_in_the_status(self):
        s = self.setup({})
        calls = []
        def pending(cfg):
            calls.append(1)
            if len(calls) == 1:
                raise KeyError("a bug")
            self.stop.set()
            return 0
        p = self.producer(s, pending=pending)
        p.run()   # the first look fails, the second stops it
        self.assertEqual(self.status()["state"], "stopped")
        self.assertEqual(self.reports[0]["error"], "KeyError: 'a bug'")
        def killed(cfg): raise KeyboardInterrupt()
        p = self.producer(s, pending=killed)
        with self.assertRaises(KeyboardInterrupt):
            p.run()
        self.assertEqual(self.status()["state"], "crashed")


class Housekeeping(Loop):
    def test_the_work_folders_of_old_committed_blocks_are_removed(self):
        work = Path(self.setup({}).dir) / "w"
        for n in (1, 5, 6, 10, 16, 17, 30):
            (work / f"block-{n}").mkdir(parents=True)
        (work / "status.json").write_text("{}")
        b.prune_work(str(work), 16, keep=10)
        self.assertEqual(sorted(os.listdir(work)), ["block-10", "block-16", "block-17", "block-30", "status.json"])

    def test_one_builder_at_a_time_per_work_folder(self):
        s = self.setup({})
        with b.work_lock(s.cfg.work_dir):
            with self.assertRaises(b.BuilderError) as e:
                with b.work_lock(s.cfg.work_dir):
                    pass
            self.assertIn("another builder is running", str(e.exception))
        with b.work_lock(s.cfg.work_dir):   # free again
            pass

    def test_a_token_file_is_read_on_every_call(self):
        s = self.setup({ALICE: [tx(ALICE, 0)], BOB: [tx(BOB, 0, price=5)]})
        token = Path(s.dir) / "token"
        token.write_text(tb.LEDGER_TOKEN + "\n")
        s.cfg.ledger_token, s.cfg.ledger_token_file = "stale", str(token)
        self.build(s)
        self.assertEqual(s.ledger.bad_auth, 0)
        token.write_text("rotated")   # the fake counts every call that does not carry the one token it knows
        s.reth.pool[ALICE] = [tx(ALICE, 1)]
        self.build(s)
        self.assertGreater(s.ledger.bad_auth, 0)


class StatusFile(Loop):
    def test_the_status_after_a_commit_and_a_refusal(self):
        a, c = tx(ALICE, 0, gas=20_000_000, used=20_000_000), tx(BOB, 0, gas=20_000_000, used=20_000_000, price=5)
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


class StatusTicker(Loop):
    def slow_run(self, s, **k):
        """`run` in a thread, with a build that takes 20 s on the fake clock (a slow prover); returns the producer and the thread."""
        seen = []
        def building(cfg, exclude, **kw):
            for _ in range(20):   # 20 fake seconds, a little real time each, so the ticker gets its turns
                self.now[0] += 1
                time.sleep(0.03)
                seen.append(self.status()["updatedAt"])
            return b.build_block(cfg, exclude, **kw)
        p = self.producer(s, build=building, status_tick=0.01, **k)
        self.seen = seen
        t = threading.Thread(target=p.run)
        return p, t

    def test_the_status_stays_fresh_during_a_block_longer_than_the_alive_rule(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        p, t = self.slow_run(s)
        t.start()
        deadline = time.time() + 20
        while len(self.seen) < 20 and time.time() < deadline:
            time.sleep(0.02)
        self.stop.set()
        t.join(30)
        distinct = sorted(set(self.seen))
        self.assertGreater(len(distinct), 10)   # it moved on, not only at the ends
        parse = lambda x: datetime.strptime(x, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        self.assertGreaterEqual(parse(distinct[-1]) - parse(distinct[0]), 15)   # past the 15 s the explorer allows
        self.assertEqual(self.status()["state"], "stopped")

    def test_only_updated_at_changes_between_writes_and_states_still_show(self):
        s = self.setup({})
        p = self.producer(s, status_tick=0.01)
        p.write_status()
        first = self.status()
        self.now[0] += 30
        time.sleep(0.1)
        self.assertEqual(self.status(), first)   # nothing runs the ticker outside run()
        t = threading.Thread(target=p.tick_status, args=(threading.Event(),), daemon=True)
        t.start()
        deadline = time.time() + 5
        while self.status()["updatedAt"] == first["updatedAt"] and time.time() < deadline:
            time.sleep(0.01)
        again = self.status()
        self.assertNotEqual(again["updatedAt"], first["updatedAt"])
        self.assertEqual({k: v for k, v in again.items() if k != "updatedAt"}, {k: v for k, v in first.items() if k != "updatedAt"})
        p.write_status("stopped", final=True)
        t.join(5)
        self.assertFalse(t.is_alive())   # a final write ends the ticker
        self.assertEqual(self.status()["state"], "stopped")

    def test_the_ticker_ends_with_the_run_and_writes_nothing_after_it(self):
        s = self.setup({})
        p = self.producer(s, status_tick=0.01)
        before = {t for t in threading.enumerate() if t.name == "status-ticker"}   # a ticker another test left is not this run's
        self.stop.set()
        p.run()
        self.assertFalse([t for t in threading.enumerate() if t.name == "status-ticker" and t not in before])
        last = Path(self.status_file).read_text()
        time.sleep(0.1)
        self.assertEqual(Path(self.status_file).read_text(), last)
        self.assertEqual(self.status()["state"], "stopped")

    def test_a_status_path_that_cannot_be_written_is_logged_once_and_does_not_stop_the_ticker_or_the_chain(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        (Path(s.dir) / "blocker").write_text("a file, so the folder cannot be made")
        p = self.producer(s, status_file=str(Path(s.dir) / "blocker" / "status.json"), status_tick=0.01)
        err = mock.patch("sys.stderr", new_callable=__import__("io").StringIO)
        with err as out:
            t = threading.Thread(target=p.run)
            t.start()
            time.sleep(0.3)
            self.stop.set()
            t.join(30)
        self.assertFalse(t.is_alive())
        self.assertEqual(out.getvalue().count("cannot write the status file"), 1)
        self.assertTrue(self.reports and self.reports[0]["committed"])

    def test_the_ticker_stops_refreshing_when_the_loop_has_written_nothing_for_the_stall_limit(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        p, t = self.slow_run(s, status_stall=10)   # the build takes 20 fake seconds; the limit is 10
        t.start()
        deadline = time.time() + 20
        while len(self.seen) < 20 and time.time() < deadline:
            time.sleep(0.02)
        self.stop.set()
        t.join(30)
        parse = lambda x: datetime.strptime(x, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        moved = parse(max(self.seen)) - parse(min(self.seen))
        self.assertGreaterEqual(moved, 8)    # it refreshed while the stall was short
        self.assertLessEqual(moved, 11)      # and stopped at the limit, though the build went on to 20 s
        self.assertEqual(self.seen[-1], max(self.seen))   # the last reads are the frozen value, not a later refresh
        self.assertLess(parse(self.seen[-1]), parse(min(self.seen)) + 12)

    def test_a_ticker_failure_other_than_a_write_error_is_reported_once_and_the_ticker_goes_on(self):
        s = self.setup({})
        p = self.producer(s, status_tick=0.01)
        p.write_status()
        calls = []
        def broken(status):
            calls.append(1)
            raise RuntimeError("dictionary changed size during iteration")
        p.put_status = broken
        done = threading.Event()
        t = threading.Thread(target=p.tick_status, args=(done,), daemon=True)
        with mock.patch("sys.stderr", new_callable=__import__("io").StringIO) as out:
            t.start()
            deadline = time.time() + 5
            while len(calls) < 3 and time.time() < deadline:
                time.sleep(0.01)
            self.assertTrue(t.is_alive())
            done.set()
            t.join(5)
        self.assertGreaterEqual(len(calls), 3)
        self.assertEqual(out.getvalue().count("the status ticker failed"), 1)

    def test_the_status_kept_for_the_ticker_shares_no_objects_with_the_loop(self):
        s = self.setup({})
        p = self.producer(s)
        p.lost = [{"hash": "0x1"}]
        p.write_status()
        p.lost.append({"hash": "0x2"})
        self.assertEqual(p.status_last["lostTransactions"], [{"hash": "0x1"}])

    def test_a_failed_write_is_reported_again_after_one_has_worked_and_the_ticker_stays_alive(self):
        s = self.setup({})
        blocker = Path(s.dir) / "blocker"
        p = self.producer(s, status_file=str(blocker / "status.json"), status_tick=0.01)
        said = lambda out: out.getvalue().count("cannot write the status file")
        blocker.write_text("a file, so the folder cannot be made")
        done = threading.Event()
        with mock.patch("sys.stderr", new_callable=__import__("io").StringIO) as out:
            p.write_status()
            t = threading.Thread(target=p.tick_status, args=(done,), name="status-ticker", daemon=True)
            t.start()
            self.addCleanup(lambda: (done.set(), t.join(5)))   # the ticker ends even when an assertion fails
            time.sleep(0.15)
            self.assertEqual(said(out), 1)    # one line, though the ticker tried many times
            self.assertTrue(t.is_alive())
            blocker.unlink()                  # now the path can be written
            deadline = time.time() + 5
            while not (blocker / "status.json").exists() and time.time() < deadline:
                time.sleep(0.01)
            self.assertTrue((blocker / "status.json").exists())
            self.assertEqual(said(out), 1)
            time.sleep(0.05)
            with p.status_lock:   # the ticker is not writing into the folder while it is swapped for a file
                shutil.rmtree(blocker)
                blocker.write_text("a file again")   # unwritable again
            deadline = time.time() + 5
            while said(out) < 2 and time.time() < deadline:
                time.sleep(0.01)
            self.assertEqual(said(out), 2)    # reported again after a write worked in between
            self.assertTrue(t.is_alive())
            done.set()
            t.join(5)


class TheCommand(Loop):
    def test_a_signal_lets_the_block_in_progress_finish_and_exits_zero(self):
        a, c = tx(ALICE, 0, gas=20_000_000, used=20_000_000), tx(BOB, 0, gas=20_000_000, used=20_000_000, price=5)
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

    def test_a_ctrl_c_to_the_whole_process_group_does_not_cut_the_proof_short(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        status = str(Path(s.dir) / "status.json")
        proc = subprocess.Popen([sys.executable, str(HERE.parent / "builder.py"), "run", "--idle-ms", "50", "--status-file", status],
                                env=self.env(s), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        deadline = time.time() + 30
        while not (s.log.exists() and "prove" in s.log.read_text()):
            self.assertLess(time.time(), deadline, "the block never reached the prover")
            time.sleep(0.05)
        os.killpg(proc.pid, signal.SIGINT)   # what a terminal's Ctrl-C does
        out, err = proc.communicate(timeout=60)
        self.assertEqual(proc.returncode, 0, err)
        self.assertEqual([json.loads(l)["committed"] for l in out.splitlines()], [True])
        self.assertEqual(len(s.ledger.submitted), 1)

    def test_a_second_builder_on_the_same_work_folder_is_refused(self):
        s = self.setup({})
        env = self.env(s)
        with b.work_lock(s.cfg.work_dir):
            for command in ("run", "once"):
                proc = subprocess.run([sys.executable, str(HERE.parent / "builder.py"), command], env=env, capture_output=True, text=True)
                self.assertEqual(proc.returncode, 1)
                self.assertIn("another builder is running", json.loads(proc.stdout)["error"])

    def test_a_busy_loop_is_refused(self):
        s = self.setup({})
        proc = subprocess.run([sys.executable, str(HERE.parent / "builder.py"), "run", "--idle-ms", "0"], env=self.env(s), capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("--idle-ms must be at least 50", json.loads(proc.stdout)["error"])

    def test_run_does_not_take_exclude(self):
        s = self.setup({})
        proc = subprocess.run([sys.executable, str(HERE.parent / "builder.py"), "run", "--exclude", "0x" + "00" * 32],
                              env=self.env(s), capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("--exclude is for once", json.loads(proc.stdout)["error"])


class Unprovable(Loop):
    """A transaction the input tool or the prover cannot finish must not wedge the chain."""

    def input_fails_for(self, *hashes):
        os.environ["FAKE_INPUT_FAILS_FOR"] = "|".join(h[2:] for h in hashes)
        self.addCleanup(os.environ.pop, "FAKE_INPUT_FAILS_FOR", None)

    def committed(self):
        return [h for r in self.reports if r.get("committed") for h in r["transactions"]]

    def test_a_lone_transaction_that_fails_twice_is_left_out_and_the_chain_goes_on(self):
        bad = tx(ALICE, 0)
        s = self.setup({ALICE: [bad]})
        self.input_fails_for(bad["hash"])
        p = self.producer(s, cooldown=600)
        p.step()
        self.assertEqual(p.excluded, {})   # once is a failure of the service
        p.step(); p.step()   # twice, and a block without it has passed the prover
        self.assertEqual(list(p.excluded), [bad["hash"]])
        st = self.status()
        (ex,) = st["excluded"]
        self.assertEqual((ex["transaction"], ex["until"]), (bad["hash"], b.iso(self.now[0] + 600)))
        self.assertIn("could not be proven", ex["reason"])
        self.assertTrue(any(r.get("excluded") == bad["hash"] for r in self.reports))   # said in the log too
        good = tx(BOB, 0)
        s.reth.pool[BOB] = [good]   # the chain is not wedged: a good transaction goes in
        p.step()
        self.assertEqual(self.reports[-1]["transactions"], [good["hash"]])
        self.assertEqual(self.in_pool(s), {bad["hash"]})
        self.now[0] += 601   # the cool-down is over: it is tried again, and fails again
        p.step()
        self.assertEqual(self.reports[-1]["committed"], False)

    def test_a_bad_transaction_beside_a_good_one_is_found_and_the_good_one_goes_in(self):
        bad, good = tx(ALICE, 0), tx(BOB, 0, price=5)
        s = self.setup({ALICE: [bad], BOB: [good]})
        self.input_fails_for(bad["hash"])
        p = self.producer(s, cooldown=600)
        for _ in range(5):
            p.step()
        self.assertEqual(list(p.excluded), [bad["hash"]])
        self.assertEqual(self.committed(), [good["hash"]])
        self.assertEqual(self.in_pool(s), {bad["hash"]})
        self.assertIsNone(self.status()["searchingForUnprovable"])

    def test_the_culprit_among_many_is_found_by_halves(self):
        txs = [tx(f"0x{i:040x}", 0, price=40 - 10 * i) for i in range(4)]   # price order: 0, 1, 2, 3
        s = self.setup({t["from"]: [t] for t in txs})
        self.input_fails_for(txs[2]["hash"])
        p = self.producer(s, cooldown=600)
        p.step(); p.step()   # both blocks hold all four
        self.assertEqual(self.status()["searchingForUnprovable"], {"candidates": [t["hash"] for t in txs]})
        for _ in range(6):
            p.step()
        self.assertEqual(list(p.excluded), [txs[2]["hash"]])
        self.assertEqual(sorted(self.committed()), sorted(t["hash"] for t in (txs[0], txs[1], txs[3])))
        self.assertEqual(self.in_pool(s), {txs[2]["hash"]})

    def test_a_prover_that_is_down_for_a_moment_blames_nobody(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, prover_fails=True)
        p = self.producer(s, cooldown=600)
        for _ in range(4):   # the prover fails every block: no block has shown that it works, so nobody is blamed
            p.step()
        self.assertEqual(p.excluded, {})
        os.environ["FAKE_PROVER_FAILS"] = ""
        p.step()
        self.assertEqual((p.excluded, self.committed()), ({}, [t["hash"]]))

    def test_a_prover_outage_in_the_middle_of_a_hunt_blames_nobody(self):
        txs = [tx(f"0x{i:040x}", 0, price=40 - 10 * i) for i in range(4)]
        s = self.setup({t["from"]: [t] for t in txs}, prover_fails=True)
        p = self.producer(s, cooldown=600)
        for _ in range(8):   # the prover is down the whole time, through the halving
            p.step()
        self.assertEqual(p.excluded, {})
        os.environ["FAKE_PROVER_FAILS"] = ""
        for _ in range(6):
            p.step()
        self.assertEqual((p.excluded, set(self.committed())), ({}, {t["hash"] for t in txs}))

    def test_a_conviction_waits_for_a_block_without_the_candidate_to_pass_the_prover(self):
        bad = tx(ALICE, 0)
        s = self.setup({ALICE: [bad]})
        self.input_fails_for(bad["hash"])
        p = self.producer(s, cooldown=600)
        p.step(); p.step()
        self.assertEqual(p.excluded, {})   # twice, but the service has not been shown to work
        p.step()   # a block without it passes
        self.assertEqual(list(p.excluded), [bad["hash"]])

    def test_a_transaction_convicted_again_is_held_back_twice_as_long(self):
        bad = tx(ALICE, 0)
        s = self.setup({ALICE: [bad]})
        self.input_fails_for(bad["hash"])
        p = self.producer(s, cooldown=600)
        for _ in range(3):
            p.step()
        self.assertEqual(p.excluded[bad["hash"]], self.now[0] + 600)
        self.now[0] += 601
        for _ in range(3):
            p.step()
        self.assertEqual(p.excluded[bad["hash"]], self.now[0] + 1200)
        self.now[0] += 1201
        for _ in range(3):
            p.step()
        self.assertEqual(p.excluded[bad["hash"]], self.now[0] + 2400)
        self.assertEqual([r["until"] for r in self.reports if r.get("excluded")][-1], b.iso(self.now[0] + 2400))

    def test_two_culprits_among_many_are_both_found_and_the_rest_go_in(self):
        txs = [tx(f"0x{i:040x}", 0, price=60 - 10 * i) for i in range(5)]
        s = self.setup({t["from"]: [t] for t in txs})
        self.input_fails_for(txs[1]["hash"], txs[3]["hash"])
        p = self.producer(s, cooldown=600)
        for _ in range(12):
            p.step()
        self.assertEqual(set(p.excluded), {txs[1]["hash"], txs[3]["hash"]})
        self.assertEqual(set(self.committed()), {t["hash"] for t in (txs[0], txs[2], txs[4])})
        self.assertEqual(self.in_pool(s), {txs[1]["hash"], txs[3]["hash"]})

    def test_a_service_failure_that_goes_away_blames_nobody(self):
        a, c = tx(ALICE, 0), tx(BOB, 0, price=5)
        s = self.setup({ALICE: [a], BOB: [c]}, prover_fails=True)
        p = self.producer(s)
        p.step(); p.step()   # a prover that is down: both blocks hold both
        os.environ["FAKE_PROVER_FAILS"] = ""
        for _ in range(4):
            p.step()
        self.assertEqual(p.excluded, {})
        self.assertEqual(sorted(self.committed()), sorted([a["hash"], c["hash"]]))
        self.assertEqual(self.in_pool(s), set())
        self.assertIsNone(self.status()["searchingForUnprovable"])

    def test_one_failure_alone_holds_nothing_back(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, prover_fails=True)
        p = self.producer(s)
        p.step()
        os.environ["FAKE_PROVER_FAILS"] = ""
        p.step()
        self.assertEqual((p.excluded, self.reports[-1]["transactions"]), ({}, [t["hash"]]))


class SavedBlock(Loop):
    """The transactions of a block are on disk from before it is proven until Canton has it or reth has them back."""

    def saved(self, s):
        return b.saved_path(s.cfg)

    def cut_short(self, s):
        """What a crash in the middle of a block leaves: reth has the block as head (its transactions are out of the pool) and the
        builder is gone, having put nothing back."""
        with b.connect(s.cfg.ws_url, max_size=None) as ws:
            reth = b.Reth(s.cfg, ws)
            chain = b.Ledger(s.cfg).head()
            head = "0x" + chain["headHash"]
            reth.forkchoice(head, head, head)
            b.build_and_import(s.cfg, reth, chain, head, set())

    def test_a_rebuild_that_reth_empties_leaves_no_saved_copy_and_the_next_step_backs_off_instead_of_restoring(self):
        # BOB's leg has no Canton side. After the first build reth has less gas: the rebuild of ALICE's transaction is left out for its gas limit,
        # so the rebuilt block is empty and (prove_empty False) is skipped. ALICE's transaction is back in the pool, so no saved copy may remain:
        # it would be sent again by the next step as a recovered block.
        good, bad = tx(ALICE, 0, gas=90_000, price=20), tx(BOB, 0, gas=90_000, price=10)
        s = self.setup({ALICE: [good], BOB: [bad]})   # no terms
        s.reth.tx_legs[bad["hash"]] = [tb.PAY]
        real, seen = b.read_legs, []

        def read(*a, **k):
            out = real(*a, **k)
            if not seen:
                seen.append(1)
                s.reth.gas_limit = 50_000
            return out
        p = self.producer(s)
        with mock.patch.object(b, "read_legs", read):
            p.step()
        self.assertEqual([r.get("skipped") for r in self.reports], [True])
        self.assertEqual([x["transaction"] for x in self.reports[0]["leftOut"]], [bad["hash"]])
        self.assertFalse(self.saved(s).exists())
        self.assertEqual({t["hash"] for ts in s.reth.pool.values() for t in ts}, {good["hash"], bad["hash"]})
        looked = len(self.built(s))
        p.step(); p.step()   # inside the pause: nothing is restored, built or reported
        self.assertEqual(len(self.reports), 1)
        self.assertEqual(len(self.built(s)), looked)
        self.assertNotIn("recovered", json.dumps(self.reports))

    def test_the_transactions_are_on_disk_while_the_block_is_proven_and_gone_once_it_is_committed(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        seen = Path(s.dir) / "seen"
        wrapper = Path(s.dir) / "prove-and-look.sh"
        wrapper.write_text(f'#!/usr/bin/env bash\ncp "{self.saved(s)}" "{seen}"\nexec "{tb.HERE / "fake-prove.sh"}" "$@"\n')
        wrapper.chmod(0o755)
        s.cfg.prove_cmd = str(wrapper)
        self.assertTrue(b.build_block(s.cfg)["committed"])
        self.assertEqual(json.loads(seen.read_text()), [{"hash": t["hash"], "raw": tb.raw_of(t), "number": HEAD_NUMBER + 1}])
        self.assertFalse(self.saved(s).exists())

    def test_a_refused_block_and_a_failed_one_leave_nothing_on_disk(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, refuse="no")
        self.assertIs(b.build_block(s.cfg)["committed"], False)
        self.assertFalse(self.saved(s).exists())
        self.assertEqual(self.in_pool(s), {t["hash"]})
        os.environ["FAKE_PROVER_FAILS"] = "1"
        self.addCleanup(os.environ.__setitem__, "FAKE_PROVER_FAILS", "")
        with self.assertRaises(b.BuilderError):
            b.build_block(s.cfg)
        self.assertFalse(self.saved(s).exists())

    def test_a_block_whose_outcome_is_not_known_keeps_them_until_it_is_settled(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        s.ledger.garbage_reply, s.ledger.commit, s.ledger.no_completion = True, False, True
        p = self.producer(s)
        p.step()
        self.assertTrue(self.saved(s).exists())
        s.ledger.no_completion = False
        p.step()
        self.assertFalse(self.saved(s).exists())
        self.assertEqual(self.in_pool(s), {t["hash"]})

    def test_a_restart_in_the_middle_of_a_block_gives_its_transactions_back_before_anything_is_built(self):
        a, c = tx(ALICE, 0), tx(BOB, 0, price=5)
        s = self.setup({ALICE: [a], BOB: [c]})
        self.cut_short(s)
        self.assertEqual(self.in_pool(s), set())   # reth dropped them and does not give them back
        self.assertTrue(self.saved(s).exists())
        p = self.producer(s)   # a new process
        p.step()
        self.assertEqual(self.reports[0]["recovered"], 2)
        self.assertEqual(self.reports[0]["lostTransactions"], [])
        self.assertFalse(self.saved(s).exists())
        methods = [m for m, _ in s.reth.ws_calls]
        self.assertLess(methods.index("eth_sendRawTransaction"), len(methods) - 1 - methods[::-1].index("testing_buildBlockV1"))   # given back before the last build
        self.assertEqual(sorted(self.reports[-1]["transactions"]), sorted([a["hash"], c["hash"]]))   # and built into a block at once
        self.assertEqual(self.in_pool(s), set())

    def test_recovery_ignores_transactions_reth_already_has_or_cannot_use(self):
        a, c = tx(ALICE, 0), tx(BOB, 0)
        s = self.setup({ALICE: [a], BOB: [c]})
        self.cut_short(s)
        s.reth.pool[ALICE] = [a]   # one is back in the pool already
        found = b.recover_saved(s.cfg)
        self.assertEqual((found["recovered"], found["lostTransactions"]), (2, []))
        s2 = self.setup({ALICE: [a]})
        self.cut_short(s2)
        s2.reth.refuse_resend = True   # reth will not take it back
        found = b.recover_saved(s2.cfg)
        self.assertEqual([x["transaction"] for x in found["lostTransactions"]], [a["hash"]])
        self.assertFalse(self.saved(s2).exists())
        self.assertIsNone(b.recover_saved(s2.cfg))   # nothing more to do

    def test_a_failed_move_back_after_a_failure_keeps_the_saved_copy_for_the_next_start(self):
        a = tx(ALICE, 0)
        s = self.setup({ALICE: [a]}, prover_fails=True)
        s.reth.no_state_for_genesis = True   # reth stays at the failed block: it answers "nonce too low" for the transaction
        with self.assertRaises(b.BuilderError) as raised:
            b.build_block(s.cfg)
        self.assertIn("no state found", raised.exception.rewind_error)
        self.assertFalse(hasattr(raised.exception, "lost_transactions"))
        self.assertTrue(self.saved(s).exists())   # not cleared: nothing was put back
        self.assertEqual(self.in_pool(s), set())
        s.reth.no_state_for_genesis = False   # the next start can move reth back
        found = b.recover_saved(s.cfg)
        self.assertEqual((found["recovered"], found["lostTransactions"]), (1, []))
        self.assertEqual(self.in_pool(s), {a["hash"]})
        self.assertFalse(self.saved(s).exists())

    def test_a_failed_move_back_after_a_refusal_keeps_the_saved_copy_for_the_next_start(self):
        a = tx(ALICE, 0)
        s = self.setup({ALICE: [a]}, refuse="the sidecar refused the proof: wrong program key")
        s.reth.no_state_for_genesis = True
        result = b.build_block(s.cfg)
        self.assertIs(result["committed"], False)
        self.assertIn("no state found", result["rewindError"])
        self.assertEqual(result["keptTransactions"], [a["hash"]])
        self.assertNotIn("lostTransactions", result)
        self.assertTrue(self.saved(s).exists())
        self.assertEqual(self.in_pool(s), set())
        s.reth.no_state_for_genesis = False
        found = b.recover_saved(s.cfg)
        self.assertEqual((found["recovered"], found["lostTransactions"]), (1, []))
        self.assertEqual(self.in_pool(s), {a["hash"]})

    def test_the_producer_recovers_after_a_failed_move_back_on_the_next_start(self):
        a = tx(ALICE, 0)
        s = self.setup({ALICE: [a]}, prover_fails=True)
        s.reth.no_state_for_genesis = True
        self.producer(s).step()
        self.assertTrue(self.saved(s).exists())
        self.assertEqual(self.status().get("lostTransactions", []), [])
        s.reth.no_state_for_genesis = False
        os.environ["FAKE_PROVER_FAILS"] = ""
        self.producer(s).step()   # the next start: rewinds, sends the transaction again, builds it
        self.assertEqual(self.reports[-1]["transactions"], [a["hash"]])
        self.assertEqual(self.status().get("lostTransactions", []), [])

    def test_a_lost_transaction_after_a_restart_is_in_the_status(self):
        a = tx(ALICE, 0)
        s = self.setup({ALICE: [a]})
        self.cut_short(s)
        s.reth.refuse_resend = True
        p = self.producer(s)
        p.step()
        self.assertEqual([x["transaction"] for x in self.status()["lostTransactions"]], [a["hash"]])

    def test_a_block_that_committed_before_the_crash_does_not_come_back_twice(self):
        a = tx(ALICE, 0)
        s = self.setup({ALICE: [a]})
        self.cut_short(s)
        # Canton did take the block: reth's pool refuses the transaction as already used (nonce too low), which is not a loss.
        s.reth.send_raw = lambda raw: (_ for _ in ()).throw(RpcError("nonce too low"))
        found = b.recover_saved(s.cfg)
        self.assertEqual((found["recovered"], found["lostTransactions"]), (1, []))

    def test_a_file_that_cannot_be_read_is_moved_aside_and_does_not_stop_the_chain(self):
        s = self.setup({})
        self.saved(s).parent.mkdir(parents=True, exist_ok=True)
        self.saved(s).write_text("{not json")
        p = self.producer(s)
        p.step()
        self.assertIn("could not be read", self.reports[0]["error"])
        self.assertFalse(self.saved(s).exists())
        self.assertEqual(len(list(self.saved(s).parent.glob(self.saved(s).name + ".unreadable-*"))), 1)
        p.step()
        self.assertEqual(len(self.reports), 1)

    def test_a_file_that_is_not_valid_text_is_moved_aside_whole_and_does_not_stop_the_chain(self):
        s = self.setup({})
        self.saved(s).parent.mkdir(parents=True, exist_ok=True)
        self.saved(s).write_bytes(b"\xff[")
        p = self.producer(s)
        p.step()
        self.assertIn("could not be read", self.reports[0]["error"])
        self.assertFalse(self.saved(s).exists())
        aside = list(self.saved(s).parent.glob(self.saved(s).name + ".unreadable-*"))
        self.assertEqual([x.read_bytes() for x in aside], [b"\xff["])
        p.step()
        self.assertEqual(len(self.reports), 1)

    def test_the_once_command_gives_them_back_too(self):
        a = tx(ALICE, 0)
        s = self.setup({ALICE: [a]})
        self.cut_short(s)
        proc = subprocess.run([sys.executable, str(HERE.parent / "builder.py"), "once"], env=self.env(s), capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["transactions"], [a["hash"]])


class LostTransactions(Loop):
    def test_a_transaction_reth_will_not_take_back_after_a_refusal_is_reported(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, refuse="no")
        s.reth.refuse_resend = True
        p = self.producer(s)
        p.step()
        report = self.reports[-1]
        self.assertEqual([x["transaction"] for x in report["lostTransactions"]], [t["hash"]])
        self.assertEqual([x["transaction"] for x in self.status()["lostTransactions"]], [t["hash"]])

    def test_a_transaction_reth_will_not_take_back_after_being_left_out_is_reported(self):
        t = tx(BOB, 0)
        s = self.setup({BOB: [t]})   # no terms: the leg has no Canton side
        s.reth.tx_legs[t["hash"]] = [tb.PAY]
        s.reth.refuse_resend = True
        p = self.producer(s)
        p.step()
        self.assertEqual([x["transaction"] for x in self.reports[0]["lostTransactions"]], [t["hash"]])
        self.assertEqual([x["transaction"] for x in self.status()["lostTransactions"]], [t["hash"]])

    def test_a_failure_after_which_reth_will_not_take_back_a_transaction_reports_it(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, prover_fails=True)
        s.reth.refuse_resend = True
        p = self.producer(s)
        p.step()
        self.assertEqual([x["transaction"] for x in self.reports[0]["lostTransactions"]], [t["hash"]])

    def test_a_left_out_transaction_reth_will_not_take_back_is_reported_when_the_prover_then_fails(self):
        a, bob = tx(ALICE, 0), tx(BOB, 0)
        s = self.setup({ALICE: [a], BOB: [bob]}, prover_fails=True)   # BOB's pay leg has no Canton side: it is left out and lost
        s.reth.tx_legs[bob["hash"]] = [tb.PAY]
        s.reth.refuse_resend = True
        p = self.producer(s)
        p.step()
        self.assertEqual(sorted(x["transaction"] for x in self.reports[0]["lostTransactions"]), sorted([a["hash"], bob["hash"]]))
        self.assertEqual(sorted(x["transaction"] for x in self.status()["lostTransactions"]), sorted([a["hash"], bob["hash"]]))

    def once(self, s):
        return subprocess.run([sys.executable, str(HERE.parent / "builder.py"), "once"], env=self.env(s), capture_output=True, text=True)

    def test_once_names_the_lost_transactions_when_the_prover_fails(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, prover_fails=True)
        s.reth.refuse_resend = True
        proc = self.once(s)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual((out["committed"], [x["transaction"] for x in out["lostTransactions"]]), (False, [t["hash"]]))
        self.assertIn("prover is down", out["error"])

    def test_once_names_the_ones_the_recovery_could_not_resend_when_the_block_then_fails(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, prover_fails=True)
        SavedBlock.cut_short(self, s)
        s.reth.refuse_resend = True
        proc = self.once(s)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual([x["transaction"] for x in out["lostTransactions"]], [t["hash"]])


class IdleChecks(Loop):
    def calls(self, s, method):
        return len([1 for m, _ in s.reth.ws_calls if m == method])

    def test_waiting_for_the_pool_never_fetches_it(self):
        s = self.setup({})
        p = self.producer(s)
        for _ in range(20):
            p.step()
        self.assertEqual((self.calls(s, "txpool_status"), self.calls(s, "txpool_content")), (20, 0))

    def test_a_pool_of_left_out_transactions_is_not_even_counted_between_looks_and_fetched_only_when_built_from(self):
        t = tx(BOB, 0)
        s = self.setup({BOB: [t]})
        s.reth.tx_legs[t["hash"]] = [tb.PAY]
        p = self.producer(s)
        p.step()   # one look: the pool is fetched for the build and again for the rebuild without the left-out transaction
        self.assertEqual((self.calls(s, "txpool_status"), self.calls(s, "txpool_content")), (1, 2))
        for _ in range(10):
            p.step()   # the clock has not moved
        self.assertEqual((self.calls(s, "txpool_status"), self.calls(s, "txpool_content")), (1, 2))
        self.now[0] += 2.0; p.step()   # the first pause is over: the pool is built from again (and the next pause is 4 s)
        self.assertEqual((self.calls(s, "txpool_status"), self.calls(s, "txpool_content")), (2, 4))
        self.now[0] += 2.0; p.step()   # the count is read again; it is unchanged and the pause is not over: no fetch
        self.assertEqual((self.calls(s, "txpool_status"), self.calls(s, "txpool_content")), (3, 4))


if __name__ == "__main__":
    unittest.main()
